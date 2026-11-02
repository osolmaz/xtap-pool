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
  poolTogglePause,
  poolStatus,
  _resetForTests,
  MAX_HANDOFF_BYTES,
} = await import('../lib/pool-sync.js');

const OUTBOX_NAME = /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

function tweet(id) {
  return { id, url: `https://x.com/a/status/${id}`, text: 'hi', captured_at: '2026-05-21T00:00:00.000Z', author: { username: 'a' } };
}

function lines(content) {
  return content.trimEnd().split('\n').map(line => JSON.parse(line));
}

function recordingHandoff(impl = () => Promise.resolve()) {
  return mock.fn(impl);
}

// initPoolSync schedules its own flush, so restart tests wait for the outcome
// instead of racing that flush with an explicit one.
async function waitFor(condition) {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(condition(), 'condition was not reached');
}

beforeEach(() => {
  _resetForTests();
  storageError = false;
  for (const key of Object.keys(storageData)) delete storageData[key];
});

afterEach(() => _resetForTests());

describe('local handoff', () => {
  it('does nothing without a handoff transport', async () => {
    await initPoolSync();
    await poolEnqueue([tweet('1')]);
    await poolFlush();
    assert.equal(poolStatus().queued, 1);
  });

  it('hands a sealed JSONL batch to the daemon and drains the queue', async () => {
    const handoff = recordingHandoff();
    await initPoolSync({ handoff });
    await poolEnqueue([tweet('1'), tweet('2')]);
    await poolFlush();
    assert.equal(handoff.mock.callCount(), 1);
    const [name, content] = handoff.mock.calls[0].arguments;
    assert.match(name, OUTBOX_NAME);
    assert.deepEqual(lines(content).map(item => item.id), ['1', '2']);
    assert.ok(lines(content).every(item => typeof item.observation_id === 'string'));
    assert.equal(poolStatus().queued, 0);
    assert.equal(poolStatus().synced, 2);
    assert.equal(storageData.poolSealed, null);
    assert.equal(storageData.poolQueue.length, 0);
  });

  it('retries a failed handoff with the same name and bytes', async () => {
    let fail = true;
    const handoff = recordingHandoff(() => (fail ? Promise.reject(new Error('daemon down')) : Promise.resolve()));
    await initPoolSync({ handoff });
    await poolEnqueue([tweet('1')]);
    await poolFlush();
    assert.equal(poolStatus().queued, 1);
    assert.match(poolStatus().lastError, /local handoff failed: daemon down/);
    assert.equal(storageData.poolSealed.count, 1);

    // A service-worker restart between attempts keeps the sealed identity.
    _resetForTests();
    fail = false;
    await initPoolSync({ handoff });
    await waitFor(() => poolStatus().queued === 0);
    assert.equal(handoff.mock.callCount(), 2);
    const [firstName, firstContent] = handoff.mock.calls[0].arguments;
    const [retryName, retryContent] = handoff.mock.calls[1].arguments;
    assert.equal(retryName, firstName);
    assert.equal(retryContent, firstContent);
  });

  it('gives every sealed batch a later seal time', async () => {
    const handoff = recordingHandoff();
    await initPoolSync({ handoff });
    for (let i = 0; i < 3; i++) {
      await poolEnqueue([tweet(String(i))]);
      await poolFlush();
    }
    const times = handoff.mock.calls.map(call => Number(call.arguments[0].slice(0, 13)));
    assert.deepEqual([...times].sort((a, b) => a - b), times);
    assert.equal(new Set(times).size, 3);
  });

  it('splits batches that would exceed the handoff size', async () => {
    const handoff = recordingHandoff();
    await initPoolSync({ handoff });
    const big = 'x'.repeat(Math.floor(MAX_HANDOFF_BYTES / 2) + 100);
    await poolEnqueue([{ ...tweet('1'), text: big }, { ...tweet('2'), text: big }, { ...tweet('3'), text: big }]);
    await poolFlush();
    assert.deepEqual(handoff.mock.calls.map(call => lines(call.arguments[1]).length), [1, 1, 1]);
  });

  it('drops an observation that can never fit and keeps the rest', async () => {
    const handoff = recordingHandoff();
    await initPoolSync({ handoff });
    await poolEnqueue([{ ...tweet('huge'), text: 'x'.repeat(MAX_HANDOFF_BYTES) }, tweet('ok')]);
    await poolFlush();
    assert.deepEqual(handoff.mock.calls.flatMap(call => lines(call.arguments[1]).map(item => item.id)), ['ok']);
    assert.equal(poolStatus().dropped, 1);
  });

  it('keeps a new enqueue that arrives during an in-flight handoff', async () => {
    let release;
    let requested;
    const started = new Promise(resolve => { requested = resolve; });
    const handoff = recordingHandoff((_name, content) => {
      if (lines(content)[0].id === '1') {
        requested();
        return new Promise(resolve => { release = resolve; });
      }
      return Promise.reject(new Error('later'));
    });
    await initPoolSync({ handoff });
    await poolEnqueue([tweet('1')]);
    const flushing = poolFlush();
    await started;
    await poolEnqueue([tweet('2')]);
    release();
    await flushing;
    assert.deepEqual(storageData.poolQueue.map(item => item.id), ['2']);
  });

  it('keeps an acknowledged batch pending if the dequeue write fails', async () => {
    const handoff = recordingHandoff(() => {
      storageError = true;
      return Promise.resolve();
    });
    await initPoolSync({ handoff });
    await poolEnqueue([tweet('1')]);
    const original = structuredClone(storageData.poolQueue);
    await assert.rejects(poolFlush(), /storage full/);
    assert.deepEqual(storageData.poolQueue, original);
    assert.equal(poolStatus().queued, 1);
    storageError = false;
    _resetForTests();
    const retry = recordingHandoff();
    await initPoolSync({ handoff: retry });
    await waitFor(() => poolStatus().queued === 0);
    assert.equal(retry.mock.calls[0].arguments[0], handoff.mock.calls[0].arguments[0]);
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

  it('ignores a sealed batch that no longer matches the restored queue', async () => {
    storageData.poolQueue = [];
    storageData.poolSealed = { name: '1793611800000-0b7c3c55-8d0e-4b8e-9f00-3d1d6c7e2a10.jsonl', count: 3 };
    await initPoolSync({ handoff: recordingHandoff() });
    assert.equal(poolStatus().sealed, null);
  });
});

describe('pause + persistence', () => {
  it('pausing blocks handoffs until resumed', async () => {
    const handoff = recordingHandoff();
    await initPoolSync({ handoff });
    await poolEnqueue([tweet('1')]);
    assert.equal(await poolTogglePause(), true);
    await poolFlush();
    assert.equal(handoff.mock.callCount(), 0);
    assert.equal(storageData.poolPaused, true);
    assert.equal(await poolTogglePause(), false);
    await poolFlush();
    assert.equal(handoff.mock.callCount(), 1);
  });

  it('initPoolSync restores queue, pause state and stats from storage', async () => {
    storageData.poolQueue = [tweet('9')];
    storageData.poolPaused = true;
    storageData.poolStats = { synced: 4, observations: 5, sampled: 1, blocked: 0, dropped: 0, lastError: null, lastSyncAt: null };
    await initPoolSync();
    const status = poolStatus();
    assert.equal(status.queued, 1);
    assert.equal(status.paused, true);
    assert.equal(status.synced, 4);
  });
});
