const DEBUGGER_PROTOCOL_VERSION = '1.3';
const GRAPHQL_PATH = '/i/api/graphql/';
const X_URL_PATTERNS = ['*://*.x.com/*', '*://*.twitter.com/*'];

export class GraphqlCapture {
  constructor({
    debuggerApi = globalThis.chrome?.debugger,
    tabs = globalThis.chrome?.tabs,
    onResponse,
    logger = console,
  } = {}) {
    if (!debuggerApi || !tabs) throw new Error('Chrome debugger capture is unavailable');
    if (typeof onResponse !== 'function') throw new Error('GraphQL response handler is required');
    this.debuggerApi = debuggerApi;
    this.tabs = tabs;
    this.onResponse = onResponse;
    this.logger = logger;
    this.attachedTabs = new Set();
    this.attachments = new Map();
    this.pendingResponses = new Map();
  }

  attach() {
    this.debuggerApi.onEvent.addListener((source, method, params) => {
      void this.handleEvent(source, method, params).catch((error) => {
        this.logger.error('[xTap] Passive GraphQL capture failed:', error);
      });
    });
    this.debuggerApi.onDetach.addListener((source) => {
      if (source.tabId === undefined) return;
      this.attachedTabs.delete(source.tabId);
      this.attachments.delete(source.tabId);
      this.deletePendingForTab(source.tabId);
    });
    this.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      const url = changeInfo.url ?? tab.url;
      if (isXUrl(url)) void this.ensureAttached(tabId);
      else if (changeInfo.url) void this.detachTab(tabId);
    });
    this.tabs.onRemoved.addListener((tabId) => {
      this.attachedTabs.delete(tabId);
      this.attachments.delete(tabId);
      this.deletePendingForTab(tabId);
    });
    void this.attachExistingTabs();
  }

  async attachExistingTabs() {
    const tabs = await this.tabs.query({ url: X_URL_PATTERNS });
    await Promise.all(
      tabs
        .map((tab) => tab.id)
        .filter((tabId) => Number.isSafeInteger(tabId))
        .map((tabId) => this.ensureAttached(tabId)),
    );
  }

  async ensureAttached(tabId) {
    if (!Number.isSafeInteger(tabId) || tabId < 0 || this.attachedTabs.has(tabId)) return;
    const pending = this.attachments.get(tabId);
    if (pending) return pending;
    const attaching = this.attachTab(tabId).finally(() => {
      if (this.attachments.get(tabId) === attaching) this.attachments.delete(tabId);
    });
    this.attachments.set(tabId, attaching);
    return attaching;
  }

  async attachTab(tabId) {
    let attachedHere = false;
    try {
      await this.debuggerApi.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
      attachedHere = true;
    } catch (error) {
      if (!isAlreadyAttachedError(error)) {
        this.logger.warn(`[xTap] Could not observe X tab ${tabId}: ${errorMessage(error)}`);
        return;
      }
    }
    try {
      await this.debuggerApi.sendCommand({ tabId }, 'Network.enable');
      this.attachedTabs.add(tabId);
    } catch (error) {
      if (attachedHere) await this.safeDetach(tabId);
      this.logger.warn(`[xTap] Could not enable capture for X tab ${tabId}: ${errorMessage(error)}`);
    }
  }

  async detachTab(tabId) {
    if (!this.attachedTabs.has(tabId)) return;
    this.attachedTabs.delete(tabId);
    this.deletePendingForTab(tabId);
    await this.safeDetach(tabId);
  }

  async safeDetach(tabId) {
    try {
      await this.debuggerApi.detach({ tabId });
    } catch {
      // Chrome may have already detached a closed or reassigned tab.
    }
  }

  async handleEvent(source, method, params) {
    const tabId = source.tabId;
    if (!Number.isSafeInteger(tabId)) return;
    const requestId = typeof params?.requestId === 'string' ? params.requestId : undefined;
    if (!requestId) return;
    const key = responseKey(tabId, requestId);

    if (method === 'Network.responseReceived') {
      const url = params?.response?.url;
      const endpoint = extractGraphqlEndpoint(url);
      if (endpoint) this.pendingResponses.set(key, { endpoint, requestId, tabId, url });
      return;
    }
    if (method === 'Network.loadingFailed') {
      this.pendingResponses.delete(key);
      return;
    }
    if (method !== 'Network.loadingFinished') return;

    const pending = this.pendingResponses.get(key);
    if (!pending) return;
    this.pendingResponses.delete(key);
    const body = await this.debuggerApi.sendCommand(
      { tabId },
      'Network.getResponseBody',
      { requestId },
    );
    const text = decodeResponseBody(body);
    const data = JSON.parse(text);
    await this.onResponse({
      data,
      endpoint: pending.endpoint,
      sourceTabId: tabId,
      url: pending.url,
    });
  }

  deletePendingForTab(tabId) {
    const prefix = `${tabId}:`;
    for (const key of this.pendingResponses.keys()) {
      if (key.startsWith(prefix)) this.pendingResponses.delete(key);
    }
  }
}

export function extractGraphqlEndpoint(url) {
  if (typeof url !== 'string') return undefined;
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.includes(GRAPHQL_PATH)) return undefined;
    const parts = parsed.pathname.split('/');
    const graphqlIndex = parts.indexOf('graphql');
    const endpoint = graphqlIndex >= 0 ? parts[graphqlIndex + 2] : undefined;
    return typeof endpoint === 'string' && endpoint.length > 0 ? endpoint : undefined;
  } catch {
    return undefined;
  }
}

function decodeResponseBody(value) {
  if (!value || typeof value.body !== 'string') throw new Error('GraphQL response body is unavailable');
  return value.base64Encoded === true ? atob(value.body) : value.body;
}

function isXUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const hostname = new URL(value).hostname;
    return hostname === 'x.com' || hostname.endsWith('.x.com') ||
      hostname === 'twitter.com' || hostname.endsWith('.twitter.com');
  } catch {
    return false;
  }
}

function isAlreadyAttachedError(error) {
  return errorMessage(error).toLowerCase().includes('another debugger is already attached');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function responseKey(tabId, requestId) {
  return `${tabId}:${requestId}`;
}
