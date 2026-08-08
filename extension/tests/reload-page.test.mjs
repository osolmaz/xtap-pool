import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const extensionRoot = new URL('../', import.meta.url);

test('the extension-owned reload page invokes the Chrome reload API', async () => {
  const html = await readFile(new URL('reload.html', extensionRoot), 'utf8');
  const script = await readFile(new URL('reload.js', extensionRoot), 'utf8');

  assert.match(html, /<script src="reload\.js" type="module"><\/script>/);
  assert.match(script, /params\.get\('fail-active'\) === '1'/);
  assert.match(script, /await store\.beginCutover\(Date\.now\(\)\)/);
  assert.match(script, /chrome\.runtime\.reload\(\)/);
});
