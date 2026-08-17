import {
  SCRAPE_PORT_NAME,
  SCRAPE_PROTOCOL_VERSION,
  ScrapeReceiptError,
  ScrapeReceiptStore,
} from './scrape-receipts.js';

export const SCROLLER_EXTENSION_ID = 'aahdialpkbjlbfjkpamfclbnlbinekal';

const CAPTURE_ATTACH_ATTEMPTS = 5;
const CAPTURE_ATTACH_RETRY_MS = 200;

export class ScrapeReceiptBridge {
  constructor({
    allowedExtensionId = SCROLLER_EXTENSION_ID,
    ensureSourceCapture,
    runtime = globalThis.chrome?.runtime,
    store = new ScrapeReceiptStore(),
    wait = defaultWait,
  } = {}) {
    if (!runtime) throw new Error('Chrome runtime is unavailable');
    this.allowedExtensionId = allowedExtensionId;
    this.ensureSourceCapture = ensureSourceCapture;
    this.runtime = runtime;
    this.store = store;
    this.wait = wait;
    this.connections = new Set();
    this.cutoverClearPromise = null;
  }

  attach() {
    this.runtime.onConnectExternal.addListener((port) => {
      this.accept(port);
    });
    void this.ensureCutoverCleared().catch(() => {
      // A later handshake retries and reports a persistent IndexedDB failure.
    });
  }

  async ensureCutoverCleared() {
    if (this.cutoverClearPromise) return this.cutoverClearPromise;
    const clearing = this.store.finishCutover();
    this.cutoverClearPromise = clearing;
    try {
      await clearing;
    } catch (error) {
      if (this.cutoverClearPromise === clearing) this.cutoverClearPromise = null;
      throw error;
    }
  }

  async finishSourceTab(sourceTabId, finishedAtMs = Date.now()) {
    return this.store.finishRunsForSourceTab(sourceTabId, finishedAtMs);
  }

  async recordGraphqlResponse({ endpoint, requestUrl, sourceTabId, tweets }) {
    const observations = await this.store.recordTimeline({
      endpoint,
      observedAtMs: Date.now(),
      requestUrl,
      sourceTabId,
      tweets,
    });
    if (observations.length === 0) return observations;

    const runId = observations[0].runId;
    const message = {
      observations,
      protocolVersion: SCRAPE_PROTOCOL_VERSION,
      runId,
      type: 'scrape:observations',
    };
    for (const connection of this.connections) {
      if (connection.runId === runId) post(connection.port, message);
    }
    return observations;
  }

  accept(port) {
    if (
      port.name !== SCRAPE_PORT_NAME ||
      port.sender?.id !== this.allowedExtensionId
    ) {
      port.disconnect();
      return;
    }

    const connection = { port, runId: undefined };
    this.connections.add(connection);
    port.onDisconnect.addListener(() => {
      this.connections.delete(connection);
    });
    port.onMessage.addListener((message) => {
      void this.handleMessageAfterCutover(connection, message);
    });
  }

  async handleMessageAfterCutover(connection, message) {
    try {
      await this.ensureCutoverCleared();
    } catch (error) {
      post(connection.port, scrapeError(message, error));
      return;
    }
    await this.handleMessage(connection, message);
  }

  async handleMessage(connection, message) {
    try {
      if (message?.protocolVersion !== SCRAPE_PROTOCOL_VERSION) {
        throw new Error('unsupported scrape protocol version');
      }
      if (message.type === 'scrape:open') {
        connection.runId = message.runId;
        if (!(await this.ensureCapture(message.sourceTabId))) {
          throw new ScrapeReceiptError(
            'internal-error',
            `xTap passive capture is unavailable for source tab ${message.sourceTabId}`,
          );
        }
        const run = await this.store.beginRun({
          listId: message.listId,
          runId: message.runId,
          sourceTabId: message.sourceTabId,
          startedAtMs: message.startedAtMs,
        });
        const observations = await this.store.readObservations(
          run.runId,
          normalizeCursor(message.afterCursor),
        );
        post(connection.port, {
          capabilities: [
            'search-timeline-observations',
            'typed-errors',
            'run-leases',
          ],
          observations,
          protocolVersion: SCRAPE_PROTOCOL_VERSION,
          run,
          runId: run.runId,
          type: 'scrape:opened',
        });
        return;
      }

      if (message.type === 'scrape:heartbeat') {
        await this.store.renewRun(
          message.runId,
          message.sourceTabId,
          message.renewedAtMs,
        );
        return;
      }

      if (message.type === 'scrape:finish') {
        const run = await this.store.finishRun(
          message.runId,
          message.state,
          message.finishedAtMs,
        );
        post(connection.port, {
          protocolVersion: SCRAPE_PROTOCOL_VERSION,
          run,
          runId: run.runId,
          type: 'scrape:finished',
        });
        return;
      }

      throw new Error('unknown scrape protocol message');
    } catch (error) {
      post(connection.port, scrapeError(message, error));
    }
  }

  async ensureCapture(sourceTabId) {
    if (!this.ensureSourceCapture) return true;
    for (let attempt = 1; attempt <= CAPTURE_ATTACH_ATTEMPTS; attempt += 1) {
      if (await this.ensureSourceCapture(sourceTabId)) return true;
      if (attempt < CAPTURE_ATTACH_ATTEMPTS) {
        await this.wait(CAPTURE_ATTACH_RETRY_MS);
      }
    }
    return false;
  }
}

function defaultWait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function normalizeCursor(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function scrapeError(message, error) {
  const failure = protocolFailure(error);
  return {
    error: failure.message,
    errorCode: failure.code,
    protocolVersion: SCRAPE_PROTOCOL_VERSION,
    runId: typeof message?.runId === 'string' ? message.runId : '',
    type: 'scrape:error',
  };
}

function protocolFailure(error) {
  if (error instanceof ScrapeReceiptError) {
    return { code: error.code, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = message.startsWith('invalid ') ||
    message === 'unsupported scrape protocol version' ||
    message === 'unknown scrape protocol message'
    ? 'invalid-request'
    : 'internal-error';
  return { code, message };
}

function post(port, message) {
  try {
    port.postMessage(message);
  } catch {
    // A disconnected client will reconnect and replay from its cursor.
  }
}
