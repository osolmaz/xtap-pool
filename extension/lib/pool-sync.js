// xtap-pool — background sync of captured tweets to the shared pool Space.
//
// Additive to xTap's local saving: tweets are appended to a persistent queue
// in chrome.storage.local and flushed in batches to POST <poolUrl>/api/ingest
// with the user's pool token. Delivery is at-least-once; the Space dedups.

const QUEUE_KEY = 'poolQueue';
const CONFIG_KEYS = ['poolUrl', 'poolToken', 'poolUsername', 'poolPaused', 'poolStats'];
const MAX_QUEUE = 5000;
const MAX_BATCH = 500;
const FLUSH_DEBOUNCE_MS = 20_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;

// Set at build/packaging time so friends get a working default without setup.
export const DEFAULT_POOL_URL = 'https://dutifuldev-xtap-pool.hf.space';

let queue = [];
let config = {
  poolUrl: DEFAULT_POOL_URL,
  poolToken: '',
  poolUsername: '',
  poolPaused: false,
};
let stats = { synced: 0, lastError: null, lastSyncAt: null };
let flushTimer = null;
let backoffMs = 0;
let flushing = false;

function storage() {
  return globalThis.chrome.storage.local;
}

function storageGet(keys) {
  return new Promise((resolve) => storage().get(keys, resolve));
}

function storageSet(items) {
  return new Promise((resolve) => storage().set(items, () => resolve()));
}

export async function initPoolSync() {
  const saved = await storageGet([QUEUE_KEY, ...CONFIG_KEYS]);
  queue = Array.isArray(saved[QUEUE_KEY]) ? saved[QUEUE_KEY] : [];
  if (typeof saved.poolUrl === 'string' && saved.poolUrl) config.poolUrl = saved.poolUrl;
  if (typeof saved.poolToken === 'string') config.poolToken = saved.poolToken;
  if (typeof saved.poolUsername === 'string') config.poolUsername = saved.poolUsername;
  config.poolPaused = saved.poolPaused === true;
  if (saved.poolStats && typeof saved.poolStats === 'object') stats = { ...stats, ...saved.poolStats };
  if (queue.length > 0) scheduleFlush(0);
}

async function persistQueue() {
  await storageSet({ [QUEUE_KEY]: queue });
}

async function persistStats() {
  await storageSet({ poolStats: stats });
}

/** Queue captured tweets for pool sync. Never throws. */
export function poolEnqueue(tweets) {
  if (!Array.isArray(tweets) || tweets.length === 0) return;
  queue.push(...tweets);
  if (queue.length > MAX_QUEUE) {
    const dropped = queue.length - MAX_QUEUE;
    queue = queue.slice(-MAX_QUEUE);
    console.warn(`[xtap-pool] queue overflow, dropped ${dropped} oldest tweets`);
  }
  persistQueue();
  scheduleFlush(queue.length >= MAX_BATCH ? 0 : FLUSH_DEBOUNCE_MS);
}

function scheduleFlush(delayMs) {
  if (flushTimer) {
    if (delayMs > 0) return;
    // An immediate flush supersedes a pending debounce timer.
    clearTimeout(flushTimer);
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    poolFlush();
  }, delayMs);
}

/** Push queued tweets to the Space, batch by batch. Returns when idle. */
export async function poolFlush() {
  if (flushing || config.poolPaused || !config.poolToken || queue.length === 0) return;
  flushing = true;
  try {
    while (queue.length > 0) {
      const batch = queue.slice(0, MAX_BATCH);
      const ok = await sendBatch(batch);
      if (!ok) break;
      queue = queue.slice(batch.length);
      await persistQueue();
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
    stats.lastError = 'pool token rejected — reconnect from the popup';
    await persistStats();
    return false;
  }
  if (!response.ok) {
    return retryLater(`pool responded ${response.status}`);
  }
  const body = await response.json().catch(() => ({}));
  stats.synced += typeof body.added === 'number' ? body.added : batch.length;
  stats.lastError = null;
  stats.lastSyncAt = new Date().toISOString();
  backoffMs = 0;
  await persistStats();
  return true;
}

async function retryLater(message) {
  backoffMs = Math.min(backoffMs > 0 ? backoffMs * 2 : BACKOFF_BASE_MS, BACKOFF_MAX_MS);
  stats.lastError = `${message} — retrying in ${Math.round(backoffMs / 1000)}s`;
  await persistStats();
  scheduleFlush(backoffMs);
  return false;
}

/** Handle a token handed off by the /connect page content script. */
export async function poolConnect({ token, username, url }) {
  if (typeof token !== 'string' || !token) return { ok: false, error: 'missing token' };
  config.poolToken = token;
  if (typeof username === 'string') config.poolUsername = username;
  if (typeof url === 'string' && url) config.poolUrl = url;
  stats.lastError = null;
  await storageSet({
    poolToken: config.poolToken,
    poolUsername: config.poolUsername,
    poolUrl: config.poolUrl,
    poolStats: stats,
  });
  scheduleFlush(0);
  return { ok: true, username: config.poolUsername };
}

export async function poolSetConfig({ url, token }) {
  if (typeof url === 'string' && url) config.poolUrl = url.replace(/\/+$/, '');
  if (typeof token === 'string' && token) {
    config.poolToken = token;
    config.poolUsername = '';
  }
  await storageSet({
    poolUrl: config.poolUrl,
    poolToken: config.poolToken,
    poolUsername: config.poolUsername,
  });
  scheduleFlush(0);
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
    lastError: stats.lastError,
    lastSyncAt: stats.lastSyncAt,
  };
}

// Test-only hook: reset module state between node --test cases.
export function _resetForTests() {
  queue = [];
  config = { poolUrl: DEFAULT_POOL_URL, poolToken: '', poolUsername: '', poolPaused: false };
  stats = { synced: 0, lastError: null, lastSyncAt: null };
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  backoffMs = 0;
  flushing = false;
}
