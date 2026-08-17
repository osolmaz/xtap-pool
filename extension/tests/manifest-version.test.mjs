import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const manifestUrl = new URL('../manifest.json', import.meta.url);

test('upstream sync preserves passive capture permissions', async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  assert.equal(manifest.version, '0.25.0');
  assert.ok(manifest.permissions.includes('debugger'));
  assert.equal(
    manifest.content_scripts.some((entry) =>
      entry.matches.some((pattern) => pattern.includes('x.com')),
    ),
    false,
  );
});
