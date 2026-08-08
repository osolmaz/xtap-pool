import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const extensionRoot = new URL('../', import.meta.url);

test('the extension-owned reload page invokes the Chrome reload API', async () => {
  const html = await readFile(new URL('reload.html', extensionRoot), 'utf8');
  const script = await readFile(new URL('reload.js', extensionRoot), 'utf8');

  assert.match(html, /<script src="reload\.js"><\/script>/);
  assert.equal(script.trim(), 'chrome.runtime.reload();');
});
