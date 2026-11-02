// xtap-pool — background handoff of captured observations to the raw Bucket.
//
// Additive to xTap's local saving: observations are appended to a persistent
// queue in chrome.storage.local, sealed into batches, and handed to the local
// daemon, which stores each batch in the pool outbox. `npm run push-outbox`
// uploads the outbox to the raw Bucket with the local Hugging Face token.
//
// A sealed batch keeps its name and size until the daemon acknowledges it, so a
// retry sends the same bytes under the same name. The uploader turns the name
// into the segment identity, so a repeated handoff never stores a second copy.

import { prepareObservations } from './observations.js';

const QUEUE_KEY = 'poolQueue';
const SAMPLES_KEY = 'poolSamples';
const SEALED_KEY = 'poolSealed';
const LAST_SEAL_KEY = 'poolLastSealMs';
const CONFIG_KEYS = ['poolPaused', 'poolStats'];
const MAX_QUEUE = 5000;
const MAX_BATCH = 500;
// The daemon accepts 10 MB bodies; JSON string escaping can grow the content.
export const MAX_HANDOFF_BYTES = 4_000_000;
const FLUSH_DEBOUNCE_MS = 20_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;

let queue = [];
let samples = {};
let sealed = null;
let lastSealMs = 0;
let paused = false;
let handoff = null;
let stats = { synced: 0, observations: 0, sampled: 0, blocked: 0, dropped: 0, lastError: null, lastSyncAt: null };
let queueWrites = Promise.resolve();
let flushTimer = null;
let backoffMs = 0;
let flushing = false;

const encoder = new TextEncoder();

function storage() {
  return globalThis.chrome.storage.local;
}

function storageGet(keys) {
  return new Promise((resolve, reject) => storage().get(keys, result => {
    const error = globalThis.chrome.runtime?.lastError;
    if (error) reject(new Error(error.message || 'pool storage read failed'));
    else resolve(result);
  }));
}

function storageSet(items) {
  return new Promise((resolve, reject) => storage().set(items, () => {
    const error = globalThis.chrome.runtime?.lastError;
    if (error) reject(new Error(error.message || 'pool storage write failed'));
    else resolve();
  }));
}

function withQueueWrite(operation) {
  const result = queueWrites.then(operation, operation);
  queueWrites = result.catch(() => {});
  return result;
}

function validSealed(value, queueLength) {
  return value && typeof value === 'object' &&
    typeof value.name === 'string' && value.name.length > 0 &&
    Number.isSafeInteger(value.count) && value.count > 0 && value.count <= queueLength;
}

/**
 * Restore pool state. `options.handoff(name, content)` stores one sealed batch
 * and resolves only after the daemon acknowledged it.
 */
export async function initPoolSync(options = {}) {
  handoff = typeof options.handoff === 'function' ? options.handoff : null;
  const saved = await storageGet([QUEUE_KEY, SAMPLES_KEY, SEALED_KEY, LAST_SEAL_KEY, ...CONFIG_KEYS]);
  queue = Array.isArray(saved[QUEUE_KEY]) ? saved[QUEUE_KEY] : [];
  samples = saved[SAMPLES_KEY] && typeof saved[SAMPLES_KEY] === 'object' ? saved[SAMPLES_KEY] : {};
  sealed = validSealed(saved[SEALED_KEY], queue.length) ? saved[SEALED_KEY] : null;
  lastSealMs = Number.isSafeInteger(saved[LAST_SEAL_KEY]) ? saved[LAST_SEAL_KEY] : 0;
  paused = saved.poolPaused === true;
  if (saved.poolStats && typeof saved.poolStats === 'object') stats = { ...stats, ...saved.poolStats };
  if (queue.length > 0) scheduleFlush(0);
}

async function persistStats() {
  await storageSet({ poolStats: stats });
}

/** Persist samples and admission state together. Failure leaves staged work pending. */
export function poolEnqueue(tweets) {
  if (!Array.isArray(tweets) || tweets.length === 0) return Promise.resolve();
  return withQueueWrite(async () => {
    const prepared = await prepareObservations(tweets, samples);
    if (queue.length + prepared.accepted.length > MAX_QUEUE) {
      stats = { ...stats, blocked: stats.blocked + 1, lastError: 'pool queue full — staged observations are waiting' };
      await persistStats();
      scheduleFlush(0);
      throw new Error(stats.lastError);
    }
    const nextQueue = [...queue, ...prepared.accepted];
    const nextStats = { ...stats, observations: stats.observations + prepared.accepted.length, sampled: stats.sampled + prepared.sampled };
    await storageSet({ [QUEUE_KEY]: nextQueue, [SAMPLES_KEY]: prepared.samples, poolStats: nextStats });
    queue = nextQueue;
    samples = prepared.samples;
    stats = nextStats;
    if (queue.length > 0) scheduleFlush(queue.length >= MAX_BATCH ? 0 : FLUSH_DEBOUNCE_MS);
  });
}

function scheduleFlush(delayMs) {
  if (flushTimer) {
    if (delayMs > 0) return;
    // An immediate flush supersedes a pending debounce timer.
    clearTimeout(flushTimer);
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    poolFlush().catch(error => {
      stats.lastError = `pool persistence failed: ${error.message}`;
      scheduleFlush(BACKOFF_BASE_MS);
    });
  }, delayMs);
}

function batchContent(count) {
  return queue.slice(0, count).map(observation => `${JSON.stringify(observation)}\n`).join('');
}

/** Seal the next batch, dropping a leading observation that can never fit. */
function sealNext() {
  return withQueueWrite(async () => {
    if (sealed || queue.length === 0) return;
    let dropped = 0;
    while (dropped < queue.length && encoder.encode(JSON.stringify(queue[dropped])).length + 1 > MAX_HANDOFF_BYTES) dropped += 1;
    let count = 0;
    let bytes = 0;
    while (dropped + count < queue.length && count < MAX_BATCH) {
      const size = encoder.encode(JSON.stringify(queue[dropped + count])).length + 1;
      if (bytes + size > MAX_HANDOFF_BYTES) break;
      bytes += size;
      count += 1;
    }
    const nextQueue = dropped > 0 ? queue.slice(dropped) : queue;
    const sealMs = Math.max(Date.now(), lastSealMs + 1);
    const nextSealed = count > 0 ? { name: `${sealMs}-${globalThis.crypto.randomUUID()}.jsonl`, count } : null;
    const nextStats = dropped > 0
      ? { ...stats, dropped: stats.dropped + dropped, lastError: `${dropped} observation(s) larger than one handoff batch were dropped` }
      : stats;
    await storageSet({
      [QUEUE_KEY]: nextQueue,
      [SEALED_KEY]: nextSealed,
      [LAST_SEAL_KEY]: nextSealed ? sealMs : lastSealMs,
      poolStats: nextStats,
    });
    queue = nextQueue;
    sealed = nextSealed;
    if (nextSealed) lastSealMs = sealMs;
    stats = nextStats;
  });
}

/** Hand queued observations to the local daemon, batch by batch. Returns when idle. */
export async function poolFlush() {
  if (flushing || paused || !handoff || queue.length === 0) return;
  flushing = true;
  try {
    while (queue.length > 0) {
      await sealNext();
      if (!sealed) break;
      const batch = sealed;
      try {
        await handoff(batch.name, batchContent(batch.count));
      } catch (error) {
        await retryLater(`local handoff failed: ${error && error.message ? error.message : error}`);
        break;
      }
      await withQueueWrite(async () => {
        const nextQueue = queue.slice(batch.count);
        const nextStats = { ...stats, synced: stats.synced + batch.count, lastError: null, lastSyncAt: new Date().toISOString() };
        await storageSet({ [QUEUE_KEY]: nextQueue, [SEALED_KEY]: null, poolStats: nextStats });
        queue = nextQueue;
        sealed = null;
        stats = nextStats;
        backoffMs = 0;
      });
    }
  } finally {
    flushing = false;
  }
}

async function retryLater(message) {
  backoffMs = Math.min(backoffMs > 0 ? backoffMs * 2 : BACKOFF_BASE_MS, BACKOFF_MAX_MS);
  await withQueueWrite(async () => {
    stats.lastError = `${message} — retrying in ${Math.round(backoffMs / 1000)}s`;
    await persistStats();
  });
  scheduleFlush(backoffMs);
}

export async function poolTogglePause() {
  paused = !paused;
  await storageSet({ poolPaused: paused });
  if (!paused) scheduleFlush(0);
  return paused;
}

export function poolStatus() {
  return {
    paused,
    queued: queue.length,
    sealed: sealed ? sealed.name : null,
    synced: stats.synced,
    observations: stats.observations,
    sampled: stats.sampled,
    blocked: stats.blocked,
    dropped: stats.dropped,
    lastError: stats.lastError,
    lastSyncAt: stats.lastSyncAt,
  };
}

// Test-only hook: reset module state between node --test cases.
export function _resetForTests() {
  queue = [];
  samples = {};
  sealed = null;
  lastSealMs = 0;
  paused = false;
  handoff = null;
  stats = { synced: 0, observations: 0, sampled: 0, blocked: 0, dropped: 0, lastError: null, lastSyncAt: null };
  queueWrites = Promise.resolve();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  backoffMs = 0;
  flushing = false;
}
