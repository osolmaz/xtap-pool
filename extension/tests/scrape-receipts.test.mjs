import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { indexedDB } from 'fake-indexeddb';
import {
  extractListId,
  ScrapeReceiptStore,
} from '../lib/scrape-receipts.js';
import {
  SCROLLER_EXTENSION_ID,
  ScrapeReceiptBridge,
} from '../lib/scrape-bridge.js';

const LIST_A = '2080606393175064669';
const LIST_B = '2080606393175064670';

function tweet(id, createdAt = '2026-08-06T10:00:00.000Z') {
  return {
    captured_at: '2026-08-06T10:01:00.000Z',
    created_at: createdAt,
    id,
  };
}

function databaseName() {
  return `xtap-scrape-test-${crypto.randomUUID()}`;
}

function listUrl(listId = LIST_A) {
  const variables = encodeURIComponent(JSON.stringify({ listId }));
  return `https://x.com/i/api/graphql/hash/ListLatestTweetsTimeline?variables=${variables}`;
}

describe('ScrapeReceiptStore', () => {
  it('persists list coverage and replays ordered run observations', async () => {
    const name = databaseName();
    const store = new ScrapeReceiptStore(indexedDB, name);
    await store.recordTimeline({
      endpoint: 'ListLatestTweetsTimeline',
      listId: LIST_A,
      observedAtMs: 1_000,
      tweets: [tweet('1')],
    });

    const run = await store.beginRun({
      listId: LIST_A,
      runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      startedAtMs: 2_000,
    });
    assert.equal(run.knownListCount, 1);
    assert.equal(run.baselineSequence, 1);

    const observations = await store.recordTimeline({
      endpoint: 'ListLatestTweetsTimeline',
      listId: LIST_A,
      observedAtMs: 3_000,
      tweets: [tweet('1'), tweet('2')],
    });
    assert.deepEqual(
      observations.map(({ cursor, knownBeforeRun, tweetId }) => ({
        cursor,
        knownBeforeRun,
        tweetId,
      })),
      [
        { cursor: 1, knownBeforeRun: true, tweetId: '1' },
        { cursor: 2, knownBeforeRun: false, tweetId: '2' },
      ],
    );

    await store.close();
    const reopened = new ScrapeReceiptStore(indexedDB, name);
    const replay = await reopened.readObservations(run.runId, 1);
    assert.equal(replay.length, 1);
    assert.equal(replay[0].tweetId, '2');
    assert.equal((await reopened.getRun(run.runId)).lastCursor, 2);
  });

  it('tracks prior coverage per list instead of globally', async () => {
    const store = new ScrapeReceiptStore(indexedDB, databaseName());
    await store.recordTimeline({
      endpoint: 'ListLatestTweetsTimeline',
      listId: LIST_B,
      observedAtMs: 1_000,
      tweets: [tweet('shared')],
    });
    const run = await store.beginRun({
      listId: LIST_A,
      runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      startedAtMs: 2_000,
    });
    assert.equal(run.knownListCount, 0);

    const [observation] = await store.recordTimeline({
      endpoint: 'ListLatestTweetsTimeline',
      listId: LIST_A,
      observedAtMs: 3_000,
      tweets: [tweet('shared')],
    });
    assert.equal(observation.knownBeforeRun, false);
  });

  it('makes reopen idempotent and rejects a competing active run', async () => {
    const store = new ScrapeReceiptStore(indexedDB, databaseName());
    const input = {
      listId: LIST_A,
      runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      startedAtMs: 2_000,
    };
    const first = await store.beginRun(input);
    assert.deepEqual(await store.beginRun(input), first);

    await assert.rejects(
      store.beginRun({
        listId: LIST_B,
        runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        startedAtMs: 3_000,
      }),
      /already active/,
    );

    const finished = await store.finishRun(first.runId, 'completed', 4_000);
    assert.equal(finished.state, 'completed');
    const next = await store.beginRun({
      listId: LIST_B,
      runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      startedAtMs: 3_000,
    });
    assert.equal(next.state, 'running');
  });
});

describe('extractListId', () => {
  it('reads the list ID only from list-timeline requests', () => {
    assert.equal(extractListId('ListLatestTweetsTimeline', listUrl()), LIST_A);
    assert.equal(extractListId('HomeTimeline', listUrl()), undefined);
    assert.equal(
      extractListId(
        'ListLatestTweetsTimeline',
        'https://x.com/i/api/graphql/hash/ListLatestTweetsTimeline?variables=nope',
      ),
      undefined,
    );
  });
});

describe('ScrapeReceiptBridge', () => {
  it('rejects unknown extensions and streams observations to the scroller', async () => {
    const store = new ScrapeReceiptStore(indexedDB, databaseName());
    const runtime = { onConnectExternal: { addListener() {} } };
    const bridge = new ScrapeReceiptBridge({ runtime, store });

    const rejected = fakePort('wrong-extension');
    bridge.accept(rejected.port);
    assert.equal(rejected.disconnected, true);

    const accepted = fakePort(SCROLLER_EXTENSION_ID);
    bridge.accept(accepted.port);
    accepted.receive({
      afterCursor: 0,
      listId: LIST_A,
      protocolVersion: 1,
      runId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      startedAtMs: 1_000,
      type: 'scrape:open',
    });
    await waitFor(() => accepted.sent.some((message) => message.type === 'scrape:opened'));

    await bridge.recordGraphqlResponse({
      endpoint: 'ListLatestTweetsTimeline',
      requestUrl: listUrl(),
      tweets: [tweet('9')],
    });
    const streamed = accepted.sent.find(
      (message) => message.type === 'scrape:observations',
    );
    assert.equal(streamed.observations[0].tweetId, '9');
  });
});

function fakePort(senderId) {
  const messageListeners = [];
  const disconnectListeners = [];
  const state = {
    disconnected: false,
    sent: [],
  };
  state.port = {
    disconnect() {
      state.disconnected = true;
      for (const listener of disconnectListeners) listener();
    },
    name: 'xtap-scrape-v1',
    onDisconnect: {
      addListener(listener) {
        disconnectListeners.push(listener);
      },
    },
    onMessage: {
      addListener(listener) {
        messageListeners.push(listener);
      },
    },
    postMessage(message) {
      state.sent.push(message);
    },
    sender: { id: senderId },
  };
  state.receive = (message) => {
    for (const listener of messageListeners) listener(message);
  };
  return state;
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for message');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
