import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const manifestUrl = new URL('../manifest.json', import.meta.url);

test('concurrent scrape support ships with a new extension version', async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  assert.equal(manifest.version, '0.20.1');
});
