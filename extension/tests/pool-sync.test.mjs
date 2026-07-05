import { beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// Minimal chrome.storage.local stub backed by a plain object.
const storageData = {};
globalThis.chrome = {
  storage: {
    local: {
      get(keys, cb) {
        const out = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          if (key in storageData) out[key] = storageData[key];
        }
        cb(out);
      },
      set(items, cb) {
        Object.assign(storageData, items);
        if (cb) cb();
      },
    },
  },
};

const {
  initPoolSync,
  poolEnqueue,
  poolFlush,
  poolConnect,
  poolSetConfig,
  poolTogglePause,
  poolStatus,
  _resetForTests,
  DEFAULT_POOL_URL,
} = await import('../lib/pool-sync.js');

function tweet(id) {
  return { id, url: `https://x.com/a/status/${id}`, text: 'hi', captured_at: '2026-05-21T00:00:00.000Z', author: { username: 'a' } };
}

function okFetch() {
  return mock.fn(() =>
    Promise.resolve(new Response(JSON.stringify({ added: 1, duplicates: 0, rejected: [] }), { status: 200 })),
  );
}

beforeEach(() => {
  _resetForTests();
  for (const key of Object.keys(storageData)) delete storageData[key];
});

describe('poolConnect + poolStatus', () => {
  it('stores the token, username and space url', async () => {
    const result = await poolConnect({ token: 'xp1.a.b', username: 'osolmaz', url: 'https://my-space.hf.space' });
    assert.deepEqual(result, { ok: true, username: 'osolmaz' });
    const status = poolStatus();
    assert.equal(status.connected, true);
    assert.equal(status.username, 'osolmaz');
    assert.equal(status.url, 'https://my-space.hf.space');
    assert.equal(storageData.poolToken, 'xp1.a.b');
  });

  it('rejects a missing token', async () => {
    const result = await poolConnect({ token: '', username: 'x', url: '' });
    assert.equal(result.ok, false);
    assert.equal(poolStatus().connected, false);
  });

  it('defaults to the baked-in pool url', () => {
    assert.equal(poolStatus().url, DEFAULT_POOL_URL);
  });
});

describe('poolEnqueue + poolFlush', () => {
  it('does nothing without a token', async () => {
    globalThis.fetch = okFetch();
    poolEnqueue([tweet('1')]);
    await poolFlush();
    assert.equal(globalThis.fetch.mock.callCount(), 0);
    assert.equal(poolStatus().queued, 1);
  });

  it('sends queued tweets with the bearer token and drains the queue', async () => {
    globalThis.fetch = okFetch();
    await poolConnect({ token: 'tok', username: 'osolmaz', url: 'https://s.hf.space' });
    poolEnqueue([tweet('1'), tweet('2')]);
    await poolFlush();
    assert.equal(poolStatus().queued, 0);
    assert.equal(poolStatus().synced >= 1, true);
    const [url, init] = globalThis.fetch.mock.calls.at(-1).arguments;
    assert.equal(url, 'https://s.hf.space/api/ingest');
    assert.equal(init.headers.authorization, 'Bearer tok');
    assert.equal(JSON.parse(init.body).tweets.length, 2);
    assert.equal(storageData.poolQueue.length, 0);
  });

  it('keeps the queue and records the error when the pool is unreachable', async () => {
    globalThis.fetch = mock.fn(() => Promise.reject(new Error('offline')));
    await poolConnect({ token: 'tok', username: 'o', url: 'https://s.hf.space' });
    poolEnqueue([tweet('1')]);
    await poolFlush();
    assert.equal(poolStatus().queued, 1);
    assert.match(poolStatus().lastError, /offline/);
  });

  it('stops retrying on 401 and asks for a reconnect', async () => {
    globalThis.fetch = mock.fn(() => Promise.resolve(new Response('no', { status: 401 })));
    await poolConnect({ token: 'expired', username: 'o', url: 'https://s.hf.space' });
    poolEnqueue([tweet('1')]);
    await poolFlush();
    assert.equal(poolStatus().queued, 1);
    assert.match(poolStatus().lastError, /reconnect/);
  });

  it('caps the queue at 5000 tweets', async () => {
    const many = [];
    for (let i = 0; i < 5100; i++) many.push(tweet(String(i)));
    poolEnqueue(many);
    assert.equal(poolStatus().queued, 5000);
  });
});

describe('pause + config + persistence', () => {
  it('pausing blocks flushes until resumed', async () => {
    globalThis.fetch = okFetch();
    await poolConnect({ token: 'tok', username: 'o', url: 'https://s.hf.space' });
    const paused = await poolTogglePause();
    assert.equal(paused, true);
    poolEnqueue([tweet('1')]);
    await poolFlush();
    assert.equal(globalThis.fetch.mock.callCount(), 0);
    await poolTogglePause();
    await poolFlush();
    assert.equal(poolStatus().queued, 0);
  });

  it('poolSetConfig normalizes the url and clears the username on manual token', async () => {
    await poolSetConfig({ url: 'https://other.hf.space///', token: 'manual' });
    const status = poolStatus();
    assert.equal(status.url, 'https://other.hf.space');
    assert.equal(status.username, '');
    assert.equal(status.connected, true);
  });

  it('initPoolSync restores queue, config and stats from storage', async () => {
    storageData.poolQueue = [tweet('9')];
    storageData.poolToken = 'tok';
    storageData.poolUsername = 'osolmaz';
    storageData.poolUrl = 'https://restored.hf.space';
    storageData.poolPaused = true;
    storageData.poolStats = { synced: 42, lastError: null, lastSyncAt: null };
    await initPoolSync();
    const status = poolStatus();
    assert.equal(status.queued, 1);
    assert.equal(status.username, 'osolmaz');
    assert.equal(status.url, 'https://restored.hf.space');
    assert.equal(status.paused, true);
    assert.equal(status.synced, 42);
  });
});
