import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const manifestUrl = new URL('../manifest.json', import.meta.url);

test('passive unified capture ships with a new extension version', async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  assert.equal(manifest.version, '0.21.0');
  assert.ok(manifest.permissions.includes('debugger'));
  assert.equal(
    manifest.content_scripts.some((entry) =>
      entry.matches.some((pattern) => pattern.includes('x.com')),
    ),
    false,
  );
});
