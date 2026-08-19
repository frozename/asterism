import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('test script uses runner discovery, not a directory entrypoint', async () => {
  const packageJson = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

  assert.equal(
    packageJson.scripts?.test,
    'node --test',
    'Passing a directory makes Node resolve it as a module specifier rather than scanning it, so the suite silently runs only what an index file imports and newly added test files are ignored.',
  );
});

test("every test file in test/ is discoverable by the runner's own pattern", async () => {
  const entries = await readdir(path.join(ROOT, 'test'));
  const testFiles = entries.filter((entry) => entry.endsWith('.test.mjs'));

  assert.ok(testFiles.length > 1, `expected more than one .test.mjs file, found ${testFiles.length}`);
  assert.equal(entries.includes('index.js'), false, 'test/index.js re-enables directory entrypoint behavior');
  assert.equal(entries.includes('index.mjs'), false, 'test/index.mjs re-enables directory entrypoint behavior');
});
