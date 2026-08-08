import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const extensionRoot = new URL('../', import.meta.url);

test('the fresh-state page ends active runs before reloading', async () => {
  const html = await readFile(new URL('cutover.html', extensionRoot), 'utf8');
  const script = await readFile(new URL('cutover.js', extensionRoot), 'utf8');

  assert.match(html, /<script src="cutover\.js" type="module"><\/script>/);
  assert.ok(
    script.indexOf('await store.failActiveRuns(Date.now())') <
      script.indexOf('chrome.runtime.reload()'),
  );
});
