import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractGraphqlEndpoint,
  GraphqlCapture,
} from '../lib/graphql-capture.js';

describe('GraphqlCapture', () => {
  it('attaches to existing and newly navigated X tabs', async () => {
    const browser = fakeBrowser([{ id: 10, url: 'https://x.com/home' }]);
    const capture = new GraphqlCapture({
      debuggerApi: browser.debuggerApi,
      logger: quietLogger(),
      onResponse() {},
      tabs: browser.tabs,
    });
    capture.attach();
    await browser.idle();
    assert.deepEqual(browser.attachments, [10]);
    assert.deepEqual(browser.commands[0], {
      method: 'Network.enable',
      params: undefined,
      tabId: 10,
    });

    browser.updateTab(20, 'https://x.com/search?q=list%3A1');
    await browser.idle();
    assert.deepEqual(browser.attachments, [10, 20]);

    browser.updateTab(20, 'https://example.com/');
    await browser.idle();
    assert.deepEqual(browser.detachments, [20]);
  });

  it('reads a completed GraphQL response without changing the page', async () => {
    const browser = fakeBrowser();
    const received = [];
    const capture = new GraphqlCapture({
      debuggerApi: browser.debuggerApi,
      logger: quietLogger(),
      onResponse(value) {
        received.push(value);
      },
      tabs: browser.tabs,
    });
    capture.attach();
    await browser.idle();
    browser.responseBodies.set('request-1', {
      body: JSON.stringify({ data: { search_by_raw_query: {} } }),
      base64Encoded: false,
    });
    const url = 'https://x.com/i/api/graphql/hash/SearchTimeline?variables=%7B%7D';
    await browser.emitDebuggerEvent(
      { tabId: 31 },
      'Network.responseReceived',
      { requestId: 'request-1', response: { url } },
    );
    await browser.emitDebuggerEvent(
      { tabId: 31 },
      'Network.loadingFinished',
      { requestId: 'request-1' },
    );

    assert.deepEqual(received, [
      {
        data: { data: { search_by_raw_query: {} } },
        endpoint: 'SearchTimeline',
        sourceTabId: 31,
        url,
      },
    ]);
    assert.equal(browser.commands.at(-1).method, 'Network.getResponseBody');
  });

  it('ignores non-GraphQL responses and removes failed requests', async () => {
    const browser = fakeBrowser();
    const received = [];
    const capture = new GraphqlCapture({
      debuggerApi: browser.debuggerApi,
      logger: quietLogger(),
      onResponse(value) {
        received.push(value);
      },
      tabs: browser.tabs,
    });
    capture.attach();
    await browser.idle();
    await browser.emitDebuggerEvent(
      { tabId: 8 },
      'Network.responseReceived',
      { requestId: 'plain', response: { url: 'https://x.com/home' } },
    );
    await browser.emitDebuggerEvent(
      { tabId: 8 },
      'Network.loadingFinished',
      { requestId: 'plain' },
    );
    await browser.emitDebuggerEvent(
      { tabId: 8 },
      'Network.responseReceived',
      {
        requestId: 'failed',
        response: {
          url: 'https://x.com/i/api/graphql/hash/ListLatestTweetsTimeline',
        },
      },
    );
    await browser.emitDebuggerEvent(
      { tabId: 8 },
      'Network.loadingFailed',
      { requestId: 'failed' },
    );
    await browser.emitDebuggerEvent(
      { tabId: 8 },
      'Network.loadingFinished',
      { requestId: 'failed' },
    );
    assert.deepEqual(received, []);
  });
});

describe('extractGraphqlEndpoint', () => {
  it('extracts the operation name from X GraphQL URLs', () => {
    assert.equal(
      extractGraphqlEndpoint(
        'https://x.com/i/api/graphql/hash/ListLatestTweetsTimeline?variables=%7B%7D',
      ),
      'ListLatestTweetsTimeline',
    );
    assert.equal(extractGraphqlEndpoint('https://x.com/home'), undefined);
    assert.equal(extractGraphqlEndpoint('invalid'), undefined);
  });
});

function fakeBrowser(existingTabs = []) {
  const debuggerEventListeners = [];
  const debuggerDetachListeners = [];
  const tabUpdateListeners = [];
  const tabRemoveListeners = [];
  const pending = [];
  const state = {
    attachments: [],
    commands: [],
    detachments: [],
    responseBodies: new Map(),
  };
  state.debuggerApi = {
    async attach(source) {
      state.attachments.push(source.tabId);
    },
    async detach(source) {
      state.detachments.push(source.tabId);
      for (const listener of debuggerDetachListeners) listener(source, 'canceled_by_user');
    },
    onDetach: {
      addListener(listener) {
        debuggerDetachListeners.push(listener);
      },
    },
    onEvent: {
      addListener(listener) {
        debuggerEventListeners.push(listener);
      },
    },
    async sendCommand(source, method, params) {
      state.commands.push({ method, params, tabId: source.tabId });
      if (method === 'Network.getResponseBody') {
        return state.responseBodies.get(params.requestId);
      }
      return {};
    },
  };
  state.tabs = {
    onRemoved: {
      addListener(listener) {
        tabRemoveListeners.push(listener);
      },
    },
    onUpdated: {
      addListener(listener) {
        tabUpdateListeners.push(listener);
      },
    },
    async query() {
      return existingTabs;
    },
  };
  state.emitDebuggerEvent = async (...args) => {
    for (const listener of debuggerEventListeners) {
      const result = listener(...args);
      if (result instanceof Promise) pending.push(result);
    }
    await state.idle();
  };
  state.idle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.all(pending.splice(0));
  };
  state.updateTab = (tabId, url) => {
    for (const listener of tabUpdateListeners) {
      listener(tabId, { url }, { id: tabId, url });
    }
  };
  return state;
}

function quietLogger() {
  return { error() {}, warn() {} };
}
