// xtap-pool — background sync of captured tweets to the shared pool Space.
//
// Additive to xTap's local saving: tweets are appended to a persistent queue
// in chrome.storage.local and flushed in batches to POST <poolUrl>/api/ingest
// with the user's pool token. Delivery is at-least-once; the Space dedups.

import { prepareObservations } from './observations.js';

const QUEUE_KEY = 'poolQueue';
const SAMPLES_KEY = 'poolSamples';
const REJECTIONS_KEY = 'poolRejections';
const MAX_REJECTIONS = 500;
const CONFIG_KEYS = ['poolUrl', 'poolToken', 'poolUsername', 'poolPaused', 'poolStats'];
const MAX_QUEUE = 5000;
const MAX_BATCH = 500;
const FLUSH_DEBOUNCE_MS = 20_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;

// Set at build/packaging time so friends get a working default without setup.
export const DEFAULT_POOL_URL = 'https://osolmaz-xtap-pool.hf.space';

let queue = [];
let samples = {};
let rejections = [];
let queueWrites = Promise.resolve();
let config = {
  poolUrl: DEFAULT_POOL_URL,
  poolToken: '',
  poolUsername: '',
  poolPaused: false,
};
let stats = { synced: 0, observations: 0, sampled: 0, blocked: 0, lastError: null, lastSyncAt: null };
let flushTimer = null;
let backoffMs = 0;
let flushing = false;

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

export async function initPoolSync() {
  const saved = await storageGet([QUEUE_KEY, SAMPLES_KEY, REJECTIONS_KEY, ...CONFIG_KEYS]);
  queue = Array.isArray(saved[QUEUE_KEY]) ? saved[QUEUE_KEY] : [];
  samples = saved[SAMPLES_KEY] && typeof saved[SAMPLES_KEY] === 'object' ? saved[SAMPLES_KEY] : {};
  rejections = Array.isArray(saved[REJECTIONS_KEY]) ? saved[REJECTIONS_KEY] : [];
  if (typeof saved.poolUrl === 'string' && saved.poolUrl) config.poolUrl = saved.poolUrl;
  if (typeof saved.poolToken === 'string') config.poolToken = saved.poolToken;
  if (typeof saved.poolUsername === 'string') config.poolUsername = saved.poolUsername;
  config.poolPaused = saved.poolPaused === true;
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

/** Push queued tweets to the Space, batch by batch. Returns when idle. */
export async function poolFlush() {
  if (flushing || config.poolPaused || !config.poolToken || queue.length === 0) return;
  flushing = true;
  try {
    while (queue.length > 0) {
      const batch = queue.slice(0, MAX_BATCH);
      const acknowledgment = await sendBatch(batch);
      if (!acknowledgment) break;
      await withQueueWrite(async () => {
        const nextQueue = queue.slice(batch.length);
        const nextRejections = [...rejections, ...acknowledgment.rejected.map(item => ({ tweet: batch[item.index], reason: item.reason }))];
        if (nextRejections.length > MAX_REJECTIONS) throw new Error('pool rejection archive full — queued observations retained');
        const nextStats = { ...stats, synced: stats.synced + batch.length - acknowledgment.rejected.length, lastError: nextRejections.length ? `${nextRejections.length} rejected observations saved for inspection` : null, lastSyncAt: new Date().toISOString() };
        await storageSet({ [QUEUE_KEY]: nextQueue, [REJECTIONS_KEY]: nextRejections, poolStats: nextStats });
        queue = nextQueue;
        rejections = nextRejections;
        stats = nextStats;
        backoffMs = 0;
      });
    }
  } finally {
    flushing = false;
  }
}

async function sendBatch(batch) {
  let response;
  try {
    response = await globalThis.fetch(`${config.poolUrl}/api/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.poolToken}`,
      },
      body: JSON.stringify({ tweets: batch }),
    });
  } catch (e) {
    return retryLater(`network error: ${e && e.message ? e.message : e}`);
  }
  if (response.status === 401) {
    // Token expired or revoked — needs a manual reconnect, retrying won't help.
    await withQueueWrite(async () => {
      stats.lastError = 'pool token rejected — reconnect from the popup';
      await persistStats();
    });
    return false;
  }
  if (!response.ok) {
    return retryLater(`pool responded ${response.status}`);
  }
  const body = await response.json().catch(() => null);
  if (!body || body.ok !== true || !Number.isSafeInteger(body.added) || body.added < 0 ||
      !Number.isSafeInteger(body.duplicates) || body.duplicates < 0 ||
      !Array.isArray(body.rejected) ||
      !body.rejected.every(item => item && Number.isSafeInteger(item.index) && item.index >= 0 && item.index < batch.length && typeof item.reason === 'string' && item.reason.length > 0) ||
      new Set(body.rejected.map(item => item.index)).size !== body.rejected.length ||
      body.added + body.duplicates + body.rejected.length !== batch.length) {
    return retryLater('pool did not acknowledge the complete observation batch');
  }
  return { rejected: body.rejected };
}

async function retryLater(message) {
  backoffMs = Math.min(backoffMs > 0 ? backoffMs * 2 : BACKOFF_BASE_MS, BACKOFF_MAX_MS);
  await withQueueWrite(async () => {
    stats.lastError = `${message} — retrying in ${Math.round(backoffMs / 1000)}s`;
    await persistStats();
  });
  scheduleFlush(backoffMs);
  return false;
}

/**
 * Handle a token handed off by the /connect page content script.
 *
 * The token is only accepted when the sender page's origin matches the
 * configured pool URL; otherwise any malicious HF Space rendering an
 * `#xtap-pool-token` element could silently repoint the extension and
 * receive all future captures. Switching pools requires setting the URL
 * explicitly (options / POOL_SET_CONFIG) before connecting.
 */
export async function poolConnect({ token, username }, senderUrl) {
  if (typeof token !== 'string' || !token) return { ok: false, error: 'missing token' };
  if (!senderMatchesPool(senderUrl)) {
    console.warn(`[xtap-pool] refused pool token from unexpected origin: ${senderUrl}`);
    return { ok: false, error: `refused token from unexpected origin (pool is ${config.poolUrl})` };
  }
  config.poolToken = token;
  if (typeof username === 'string') config.poolUsername = username;
  stats.lastError = null;
  await storageSet({
    poolToken: config.poolToken,
    poolUsername: config.poolUsername,
    poolStats: stats,
  });
  scheduleFlush(0);
  return { ok: true, username: config.poolUsername };
}

function senderMatchesPool(senderUrl) {
  if (typeof senderUrl !== 'string' || !senderUrl) return false;
  try {
    return new URL(senderUrl).origin === new URL(config.poolUrl).origin;
  } catch {
    return false;
  }
}

export async function poolSetConfig({ url, token }) {
  if (typeof url === 'string' && url) {
    const normalized = url.replace(/\/+$/, '');
    if (normalized !== config.poolUrl) {
      config.poolUrl = normalized;
      // A token is only valid for the pool that minted it. Keeping the old
      // one would leak it (and queued captures) to whatever Space the new
      // URL points at on the next flush.
      config.poolToken = '';
      config.poolUsername = '';
    }
  }
  if (typeof token === 'string' && token) {
    config.poolToken = token;
    config.poolUsername = '';
  }
  await storageSet({
    poolUrl: config.poolUrl,
    poolToken: config.poolToken,
    poolUsername: config.poolUsername,
  });
  if (config.poolToken) scheduleFlush(0);
}

export async function poolTogglePause() {
  config.poolPaused = !config.poolPaused;
  await storageSet({ poolPaused: config.poolPaused });
  if (!config.poolPaused) scheduleFlush(0);
  return config.poolPaused;
}

export function poolStatus() {
  return {
    connected: Boolean(config.poolToken),
    username: config.poolUsername,
    url: config.poolUrl,
    paused: config.poolPaused,
    queued: queue.length,
    synced: stats.synced,
    observations: stats.observations,
    sampled: stats.sampled,
    blocked: stats.blocked,
    rejected: rejections.length,
    lastError: stats.lastError,
    lastSyncAt: stats.lastSyncAt,
  };
}

// Test-only hook: reset module state between node --test cases.
export function _resetForTests() {
  queue = [];
  samples = {};
  rejections = [];
  queueWrites = Promise.resolve();
  config = { poolUrl: DEFAULT_POOL_URL, poolToken: '', poolUsername: '', poolPaused: false };
  stats = { synced: 0, observations: 0, sampled: 0, blocked: 0, lastError: null, lastSyncAt: null };
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  backoffMs = 0;
  flushing = false;
}
