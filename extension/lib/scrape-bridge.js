import {
  SCRAPE_PORT_NAME,
  SCRAPE_PROTOCOL_VERSION,
  ScrapeReceiptError,
  ScrapeReceiptStore,
} from './scrape-receipts.js';

export const SCROLLER_EXTENSION_ID = 'aahdialpkbjlbfjkpamfclbnlbinekal';

export class ScrapeReceiptBridge {
  constructor({
    allowedExtensionId = SCROLLER_EXTENSION_ID,
    runtime = globalThis.chrome?.runtime,
    store = new ScrapeReceiptStore(),
  } = {}) {
    if (!runtime) throw new Error('Chrome runtime is unavailable');
    this.allowedExtensionId = allowedExtensionId;
    this.runtime = runtime;
    this.store = store;
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
          ],
          observations,
          protocolVersion: SCRAPE_PROTOCOL_VERSION,
          run,
          runId: run.runId,
          type: 'scrape:opened',
        });
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
