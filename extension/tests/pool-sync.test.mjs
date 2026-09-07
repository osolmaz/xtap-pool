import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// Minimal chrome.storage.local stub backed by a plain object.
const storageData = {};
let storageError = false;
globalThis.chrome = {
  runtime: {},
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
        if (storageError) globalThis.chrome.runtime.lastError = { message: 'storage full' };
        else Object.assign(storageData, structuredClone(items));
        if (cb) cb();
        delete globalThis.chrome.runtime.lastError;
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
  return mock.fn((_url, init) =>
    Promise.resolve(new Response(JSON.stringify({ ok: true, added: JSON.parse(init.body).tweets.length, duplicates: 0, rejected: [] }), { status: 200 })),
  );
}

beforeEach(() => {
  _resetForTests();
  storageError = false;
  for (const key of Object.keys(storageData)) delete storageData[key];
});

afterEach(() => _resetForTests());

describe('poolConnect + poolStatus', () => {
  it('stores the token and username for the configured pool origin', async () => {
    await poolSetConfig({ url: 'https://my-space.hf.space' });
    const result = await poolConnect(
      { token: 'xp1.a.b', username: 'osolmaz' },
      'https://my-space.hf.space/connect'
    );
    assert.deepEqual(result, { ok: true, username: 'osolmaz' });
    const status = poolStatus();
    assert.equal(status.connected, true);
    assert.equal(status.username, 'osolmaz');
    assert.equal(status.url, 'https://my-space.hf.space');
    assert.equal(storageData.poolToken, 'xp1.a.b');
  });

  it('refuses tokens handed off by a different origin', async () => {
    const result = await poolConnect(
      { token: 'xp1.a.b', username: 'mallory' },
      'https://evil-space.hf.space/connect'
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /unexpected origin/);
    assert.equal(poolStatus().connected, false);
  });

  it('rejects a missing token', async () => {
    const result = await poolConnect({ token: '', username: 'x' }, DEFAULT_POOL_URL);
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
    await poolEnqueue([tweet('1')]);
    await poolFlush();
    assert.equal(globalThis.fetch.mock.callCount(), 0);
    assert.equal(poolStatus().queued, 1);
  });

  it('sends queued tweets with the bearer token and drains the queue', async () => {
    globalThis.fetch = okFetch();
    await poolSetConfig({ url: 'https://s.hf.space' });
    await poolConnect({ token: 'tok', username: 'osolmaz' }, 'https://s.hf.space/connect');
    await poolEnqueue([tweet('1'), tweet('2')]);
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
    await poolSetConfig({ url: 'https://s.hf.space' });
    await poolConnect({ token: 'tok', username: 'o' }, 'https://s.hf.space/connect');
    await poolEnqueue([tweet('1')]);
    await poolFlush();
    assert.equal(poolStatus().queued, 1);
    assert.match(poolStatus().lastError, /offline/);
  });

  it('stops retrying on 401 and asks for a reconnect', async () => {
    globalThis.fetch = mock.fn(() => Promise.resolve(new Response('no', { status: 401 })));
    await poolSetConfig({ url: 'https://s.hf.space' });
    await poolConnect({ token: 'expired', username: 'o' }, 'https://s.hf.space/connect');
    await poolEnqueue([tweet('1')]);
    await poolFlush();
    assert.equal(poolStatus().queued, 1);
    assert.match(poolStatus().lastError, /reconnect/);
  });

  it('blocks overflow without discarding queued work or committing sample markers', async () => {
    await poolEnqueue([tweet('first')]);
    const many = [];
    for (let i = 0; i < 5000; i++) many.push(tweet(String(i)));
    await assert.rejects(poolEnqueue(many), /queue full/);
    assert.equal(poolStatus().queued, 1);
    assert.equal(storageData.poolQueue[0].id, 'first');
    assert.equal(Object.keys(storageData.poolSamples).length, 1);
    assert.equal(poolStatus().blocked, 1);
  });
});

describe('durable observation delivery', () => {
  it('retains six-hour repeats and content edits but samples same-interval counters', async () => {
    const first = { ...tweet('1'), metrics: { likes: 1 } };
    await poolEnqueue([first]);
    await poolEnqueue([{ ...first, captured_at: '2026-05-21T00:02:00Z', metrics: { likes: 2 } }]);
    await poolEnqueue([{ ...first, captured_at: '2026-05-21T00:03:00Z', text: 'edited' }]);
    await poolEnqueue([{ ...first, captured_at: '2026-05-21T06:00:00Z' }]);
    assert.equal(poolStatus().queued, 3);
    assert.equal(poolStatus().sampled, 1);
    assert.equal(new Set(storageData.poolQueue.map(item => item.observation_id)).size, 3);
  });

  it('does not acknowledge or mark a sample when storage fails', async () => {
    storageError = true;
    await assert.rejects(poolEnqueue([tweet('1')]), /storage full/);
    assert.equal(poolStatus().queued, 0);
    assert.equal(storageData.poolSamples, undefined);
    storageError = false;
    await poolEnqueue([tweet('1')]);
    assert.equal(poolStatus().queued, 1);
  });

  it('restores the exact queued identity and sampling state after a restart', async () => {
    await poolEnqueue([tweet('1')]);
    const original = structuredClone(storageData.poolQueue);
    _resetForTests();
    await initPoolSync();
    await poolEnqueue([tweet('1')]);
    assert.deepEqual(storageData.poolQueue, original);
    assert.equal(poolStatus().queued, 1);
  });

  it('serializes concurrent enqueue writes without losing either observation', async () => {
    await Promise.all([poolEnqueue([tweet('1')]), poolEnqueue([tweet('2')])]);
    assert.deepEqual(storageData.poolQueue.map(item => item.id), ['1', '2']);
  });

  it('keeps a new enqueue that arrives during an in-flight batch request', async () => {
    await poolSetConfig({ token: 'test-token' });
    await poolEnqueue([tweet('1')]);
    let release;
    let requested;
    const started = new Promise(resolve => { requested = resolve; });
    globalThis.fetch = mock.fn((_url, init) => {
      if (JSON.parse(init.body).tweets[0].id === '1') {
        requested();
        return new Promise(resolve => { release = () => resolve(new Response(JSON.stringify({ ok: true, added: 1, duplicates: 0, rejected: [] }))); });
      }
      return Promise.resolve(new Response('', { status: 503 }));
    });
    const flushing = poolFlush();
    await started;
    await poolEnqueue([tweet('2')]);
    release();
    await flushing;
    assert.deepEqual(storageData.poolQueue.map(item => item.id), ['2']);
  });

  it('saves explicit server rejections separately and continues unaffected work', async () => {
    await poolSetConfig({ token: 'test-token' });
    await poolEnqueue([tweet('bad'), tweet('good')]);
    globalThis.fetch = mock.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true, added: 1, duplicates: 0, rejected: [{ index: 0, reason: 'author missing' }] }))));
    await poolFlush();
    assert.equal(poolStatus().queued, 0);
    assert.equal(poolStatus().synced, 1);
    assert.equal(poolStatus().rejected, 1);
    assert.equal(storageData.poolRejections[0].tweet.id, 'bad');
    assert.equal(storageData.poolRejections[0].reason, 'author missing');
    assert.match(poolStatus().lastError, /saved for inspection/);
  });

  it('keeps an acknowledged batch pending if the dequeue write fails', async () => {
    await poolSetConfig({ token: 'test-token' });
    await poolEnqueue([tweet('1')]);
    const original = structuredClone(storageData.poolQueue);
    globalThis.fetch = mock.fn(() => {
      storageError = true;
      return Promise.resolve(new Response(JSON.stringify({ ok: true, added: 1, duplicates: 0, rejected: [] })));
    });
    await assert.rejects(poolFlush(), /storage full/);
    assert.deepEqual(storageData.poolQueue, original);
    assert.equal(poolStatus().queued, 1);
    storageError = false;
    globalThis.fetch = mock.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true, added: 0, duplicates: 1, rejected: [] }))));
    await poolFlush();
    assert.equal(poolStatus().queued, 0);
    assert.equal(poolStatus().synced, 1);
  });

  for (const body of [null, {}, { ok: true, added: 0, duplicates: 0, rejected: [] }, { ok: true, added: 0, duplicates: 0, rejected: [{ index: 2, reason: 'invalid' }] }]) {
    it(`retains unacknowledged work for response ${JSON.stringify(body)}`, async () => {
      await poolSetConfig({ token: 'test-token' });
      await poolEnqueue([tweet('1')]);
      globalThis.fetch = mock.fn(() => Promise.resolve(new Response(JSON.stringify(body))));
      await poolFlush();
      assert.equal(storageData.poolQueue.length, 1);
      assert.match(poolStatus().lastError, /acknowledge/);
    });
  }
});

describe('pause + config + persistence', () => {
  it('pausing blocks flushes until resumed', async () => {
    globalThis.fetch = okFetch();
    await poolSetConfig({ url: 'https://s.hf.space' });
    await poolConnect({ token: 'tok', username: 'o' }, 'https://s.hf.space/connect');
    const paused = await poolTogglePause();
    assert.equal(paused, true);
    await poolEnqueue([tweet('1')]);
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

  it('clears a stale token when the pool url changes without a replacement', async () => {
    await poolSetConfig({ url: 'https://a.hf.space' });
    await poolConnect({ token: 'tok-a', username: 'osolmaz' }, 'https://a.hf.space/connect');
    assert.equal(poolStatus().connected, true);
    await poolSetConfig({ url: 'https://b.hf.space' });
    const status = poolStatus();
    assert.equal(status.url, 'https://b.hf.space');
    assert.equal(status.connected, false);
    assert.equal(status.username, '');
    assert.equal(storageData.poolToken, '');
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
