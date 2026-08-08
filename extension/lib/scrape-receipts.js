const DATABASE_NAME = 'xtap-scrape-receipts';
const DATABASE_VERSION = 1;
const META_SEQUENCE = 'captureSequence';
const MAX_ACTIVE_RUNS = 2;

export const SCRAPE_PROTOCOL_VERSION = 1;
export const SCRAPE_PORT_NAME = 'xtap-scrape-v1';

export class ScrapeReceiptStore {
  constructor(indexedDBFactory = globalThis.indexedDB, databaseName = DATABASE_NAME) {
    if (!indexedDBFactory) throw new Error('IndexedDB is unavailable');
    this.indexedDB = indexedDBFactory;
    this.databaseName = databaseName;
    this.databasePromise = null;
  }

  async beginRun({ runId, listId, sourceTabId, startedAtMs }) {
    validateRunInput({ runId, listId, sourceTabId, startedAtMs });
    const database = await this.open();
    const transaction = database.transaction(
      ['listReceipts', 'meta', 'runs'],
      'readwrite',
    );
    const listReceipts = transaction.objectStore('listReceipts');
    const meta = transaction.objectStore('meta');
    const runs = transaction.objectStore('runs');

    const allRuns = await request(runs.getAll());
    const existing = allRuns.find((run) => run.runId === runId);
    if (existing) {
      if (existing.listId !== listId || existing.startedAtMs !== startedAtMs) {
        transaction.abort();
        throw new Error('run ID already belongs to different parameters');
      }
      if (existing.state === 'running' && existing.sourceTabId !== sourceTabId) {
        const sourceInUse = allRuns.some(
          (run) =>
            run.runId !== runId &&
            run.state === 'running' &&
            run.sourceTabId === sourceTabId,
        );
        if (sourceInUse) {
          transaction.abort();
          throw new Error(`source tab ${sourceTabId} already belongs to an active scrape run`);
        }
        existing.sourceTabId = sourceTabId;
        existing.updatedAtMs = Date.now();
        runs.put(existing);
      }
      await transactionDone(transaction);
      return existing;
    }

    const activeRuns = allRuns.filter((run) => run.state === 'running');
    if (activeRuns.some((run) => run.sourceTabId === sourceTabId)) {
      transaction.abort();
      throw new Error(`source tab ${sourceTabId} already belongs to an active scrape run`);
    }
    if (activeRuns.length >= MAX_ACTIVE_RUNS) {
      transaction.abort();
      throw new Error('xTap already has two active scrape runs');
    }

    const baselineSequence = (await readMeta(meta, META_SEQUENCE)) ?? 0;
    const knownListCount = await request(
      listReceipts.index('listId').count(listId),
    );
    const run = {
      baselineSequence,
      knownListCount,
      lastCursor: 0,
      listId,
      protocolVersion: SCRAPE_PROTOCOL_VERSION,
      runId,
      sourceTabId,
      startedAtMs,
      state: 'running',
      updatedAtMs: Date.now(),
    };
    runs.put(run);
    await transactionDone(transaction);
    return run;
  }

  async recordTimeline({ endpoint, listId, observedAtMs, sourceTabId, tweets }) {
    if (endpoint !== 'ListLatestTweetsTimeline') return [];
    if (!isListId(listId) || !Number.isFinite(observedAtMs)) return [];
    if (!isSourceTabId(sourceTabId)) return [];
    if (!Array.isArray(tweets) || tweets.length === 0) return [];

    const database = await this.open();
    const transaction = database.transaction(
      ['listReceipts', 'meta', 'observations', 'receipts', 'runs'],
      'readwrite',
    );
    const listReceipts = transaction.objectStore('listReceipts');
    const meta = transaction.objectStore('meta');
    const observations = transaction.objectStore('observations');
    const receipts = transaction.objectStore('receipts');
    const runs = transaction.objectStore('runs');

    let sequence = (await readMeta(meta, META_SEQUENCE)) ?? 0;
    const run = (await request(runs.getAll())).find(
      (candidate) =>
        candidate.state === 'running' &&
        candidate.listId === listId &&
        candidate.sourceTabId === sourceTabId,
    );
    const emitted = [];
    const batchIds = new Set();

    for (const tweet of tweets) {
      if (!isTweet(tweet) || batchIds.has(tweet.id)) continue;
      batchIds.add(tweet.id);

      let receipt = await request(receipts.get(tweet.id));
      let listReceipt = await request(listReceipts.get([listId, tweet.id]));
      if (!receipt || !listReceipt) sequence += 1;

      if (!receipt) {
        receipt = {
          endpoint,
          firstSeenAt: normalizeTimestamp(tweet.captured_at, observedAtMs),
          id: tweet.id,
          listId,
          postAt: tweet.created_at,
          sequence,
        };
        receipts.put(receipt);
      }

      if (!listReceipt) {
        listReceipt = {
          firstSeenAt: normalizeTimestamp(tweet.captured_at, observedAtMs),
          listId,
          postAt: tweet.created_at,
          sequence,
          tweetId: tweet.id,
        };
        listReceipts.put(listReceipt);
      }

      if (run) {
        run.lastCursor += 1;
        const observation = {
          captureSequence: listReceipt.sequence,
          cursor: run.lastCursor,
          knownBeforeRun: listReceipt.sequence <= run.baselineSequence,
          observedAtMs,
          postAt: tweet.created_at,
          runId: run.runId,
          tweetId: tweet.id,
        };
        observations.put(observation);
        emitted.push(observation);
      }
    }

    writeMeta(meta, META_SEQUENCE, sequence);
    if (run && emitted.length > 0) {
      run.updatedAtMs = observedAtMs;
      runs.put(run);
    }
    await transactionDone(transaction);
    return emitted;
  }

  async readObservations(runId, afterCursor = 0) {
    if (!isRunId(runId) || !Number.isSafeInteger(afterCursor) || afterCursor < 0) {
      throw new Error('invalid observation cursor');
    }
    const database = await this.open();
    const transaction = database.transaction('observations', 'readonly');
    const values = await request(
      transaction.objectStore('observations').index('runId').getAll(runId),
    );
    await transactionDone(transaction);
    return values
      .filter((entry) => entry.cursor > afterCursor)
      .sort((left, right) => left.cursor - right.cursor);
  }

  async failActiveRuns(finishedAtMs) {
    if (!Number.isFinite(finishedAtMs)) throw new Error('invalid finish time');

    const database = await this.open();
    const transaction = database.transaction('runs', 'readwrite');
    const runs = transaction.objectStore('runs');
    const activeRuns = (await request(runs.getAll())).filter(
      (run) => run.state === 'running',
    );
    for (const run of activeRuns) {
      run.finishedAtMs = finishedAtMs;
      run.state = 'failed';
      run.updatedAtMs = finishedAtMs;
      runs.put(run);
    }
    await transactionDone(transaction);
    return activeRuns.length;
  }

  async finishRun(runId, state, finishedAtMs) {
    if (!isRunId(runId)) throw new Error('invalid run ID');
    if (!['aborted', 'completed', 'failed'].includes(state)) {
      throw new Error('invalid terminal run state');
    }
    if (!Number.isFinite(finishedAtMs)) throw new Error('invalid finish time');

    const database = await this.open();
    const transaction = database.transaction('runs', 'readwrite');
    const runs = transaction.objectStore('runs');
    const run = await request(runs.get(runId));
    if (!run) {
      transaction.abort();
      throw new Error('unknown scrape run');
    }
    if (run.state !== 'running' && run.state !== state) {
      transaction.abort();
      throw new Error(`scrape run already ended as ${run.state}`);
    }

    run.finishedAtMs = finishedAtMs;
    run.state = state;
    run.updatedAtMs = finishedAtMs;
    runs.put(run);
    await transactionDone(transaction);
    return run;
  }

  async getRun(runId) {
    const database = await this.open();
    const transaction = database.transaction('runs', 'readonly');
    const run = await request(transaction.objectStore('runs').get(runId));
    await transactionDone(transaction);
    return run;
  }

  async open() {
    if (this.databasePromise) return this.databasePromise;
    const opening = new Promise((resolve, reject) => {
      const openRequest = this.indexedDB.open(this.databaseName, DATABASE_VERSION);
      let settled = false;
      openRequest.onupgradeneeded = () => createSchema(openRequest.result);
      openRequest.onsuccess = () => {
        if (settled) {
          openRequest.result.close();
          return;
        }
        settled = true;
        resolve(openRequest.result);
      };
      openRequest.onerror = () => {
        settled = true;
        reject(openRequest.error ?? new Error('failed to open receipt database'));
      };
      openRequest.onblocked = () => {
        settled = true;
        reject(new Error('receipt database upgrade is blocked'));
      };
    });
    this.databasePromise = opening;
    opening.catch(() => {
      if (this.databasePromise === opening) this.databasePromise = null;
    });
    return opening;
  }

  async close() {
    if (!this.databasePromise) return;
    const database = await this.databasePromise;
    database.close();
    this.databasePromise = null;
  }
}

export function extractListId(endpoint, requestUrl) {
  if (endpoint !== 'ListLatestTweetsTimeline' || typeof requestUrl !== 'string') {
    return undefined;
  }
  try {
    const variables = new URL(requestUrl).searchParams.get('variables');
    if (!variables) return undefined;
    const parsed = JSON.parse(variables);
    return isListId(parsed?.listId) ? parsed.listId : undefined;
  } catch {
    return undefined;
  }
}

function createSchema(database) {
  if (!database.objectStoreNames.contains('receipts')) {
    const receipts = database.createObjectStore('receipts', { keyPath: 'id' });
    receipts.createIndex('sequence', 'sequence', { unique: true });
  }
  if (!database.objectStoreNames.contains('listReceipts')) {
    const listReceipts = database.createObjectStore('listReceipts', {
      keyPath: ['listId', 'tweetId'],
    });
    listReceipts.createIndex('listId', 'listId', { unique: false });
  }
  if (!database.objectStoreNames.contains('runs')) {
    database.createObjectStore('runs', { keyPath: 'runId' });
  }
  if (!database.objectStoreNames.contains('observations')) {
    const observations = database.createObjectStore('observations', {
      keyPath: ['runId', 'cursor'],
    });
    observations.createIndex('runId', 'runId', { unique: false });
  }
  if (!database.objectStoreNames.contains('meta')) {
    database.createObjectStore('meta', { keyPath: 'key' });
  }
}

function request(idbRequest) {
  return new Promise((resolve, reject) => {
    idbRequest.onsuccess = () => resolve(idbRequest.result);
    idbRequest.onerror = () => reject(idbRequest.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

async function readMeta(store, key) {
  const entry = await request(store.get(key));
  return entry?.value;
}

function writeMeta(store, key, value) {
  store.put({ key, value });
}

function validateRunInput({ runId, listId, sourceTabId, startedAtMs }) {
  if (!isRunId(runId)) throw new Error('invalid run ID');
  if (!isListId(listId)) throw new Error('invalid list ID');
  if (!isSourceTabId(sourceTabId)) throw new Error('invalid source tab ID');
  if (!Number.isFinite(startedAtMs)) throw new Error('invalid start time');
}

function isRunId(value) {
  return typeof value === 'string' && /^[0-9a-f-]{16,64}$/i.test(value);
}

function isListId(value) {
  return typeof value === 'string' && /^\d{4,25}$/.test(value);
}

function isSourceTabId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isTweet(value) {
  return (
    value &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.created_at === 'string' &&
    Number.isFinite(Date.parse(value.created_at))
  );
}

function normalizeTimestamp(value, fallbackMs) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? value
    : new Date(fallbackMs).toISOString();
}
