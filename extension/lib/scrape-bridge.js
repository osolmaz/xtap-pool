import {
  extractListId,
  SCRAPE_PORT_NAME,
  SCRAPE_PROTOCOL_VERSION,
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
  }

  attach() {
    this.runtime.onConnectExternal.addListener((port) => {
      this.accept(port);
    });
  }

  async recordGraphqlResponse({ endpoint, requestUrl, tweets }) {
    const listId = extractListId(endpoint, requestUrl);
    if (!listId) return [];
    const observations = await this.store.recordTimeline({
      endpoint,
      listId,
      observedAtMs: Date.now(),
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
      void this.handleMessage(connection, message);
    });
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
          startedAtMs: message.startedAtMs,
        });
        const observations = await this.store.readObservations(
          run.runId,
          normalizeCursor(message.afterCursor),
        );
        post(connection.port, {
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
      post(connection.port, {
        error: error instanceof Error ? error.message : String(error),
        protocolVersion: SCRAPE_PROTOCOL_VERSION,
        runId: typeof message?.runId === 'string' ? message.runId : '',
        type: 'scrape:error',
      });
    }
  }
}

function normalizeCursor(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function post(port, message) {
  try {
    port.postMessage(message);
  } catch {
    // A disconnected client will reconnect and replay from its cursor.
  }
}
