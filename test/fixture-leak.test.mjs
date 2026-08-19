import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { findLeaks, scrub } from '../src/core/scrub.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES_DIR = path.join(ROOT, 'fixtures');
const HOME = os.homedir();
const OPTS = { home: HOME, extraRoots: [ROOT] };

test('fixtures/ exists and every committed file is free of leaks and scrub-idempotent', async () => {
  assert.ok(
    existsSync(FIXTURES_DIR),
    'fixtures/ is missing; another task creates it, and this leak test fails closed rather than skip',
  );

  const files = await listFilesRecursively(FIXTURES_DIR);
  assert.ok(files.length > 0, 'fixtures/ contains no files to walk; the leak test would prove nothing');

  for (const file of files) {
    const bytes = await readFile(file);
    const text = bytes.toString('utf8');
    const relative = path.relative(ROOT, file);

    const leaks = findLeaks(text, OPTS);
    assert.deepEqual(leaks, [], `${relative} leaks: ${JSON.stringify(leaks)}`);

    const { text: scrubbed } = scrub(text, OPTS);
    assert.equal(
      Buffer.from(scrubbed, 'utf8').equals(bytes),
      true,
      `${relative} is not idempotent under scrub`,
    );
  }
});

test('control: a synthetic buffer with the real home, a uuid, and a 32-char random token reports three leaks of the right kinds', () => {
  const token = 'aZ9qW3eR7tY1uI5oP2sD8fG4jK6lH0nQ';
  assert.equal(token.length, 32);

  const synthetic = `home=${HOME}\nid=6f9619ff-8b86-d011-b42d-00c04fc964ff\nkey=${token}\n`;

  const leaks = findLeaks(synthetic, OPTS);
  assert.equal(leaks.length, 3);
  assert.deepEqual(
    leaks.map((leak) => leak.kind).sort(),
    ['home', 'token', 'uuid'],
  );

  const { text: scrubbed, redactions } = scrub(synthetic, OPTS);
  assert.equal(scrubbed.length, synthetic.length);
  assert.equal(redactions.length, 3);
  assert.deepEqual(findLeaks(scrubbed, OPTS), []);
});

async function listFilesRecursively(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(full)));
    } else if (entry.isFile()) {
      files.push(full);
    } else {
      throw new Error(`${full}: refusing to silently skip a non-file, non-directory fixtures entry`);
    }
  }

  return files;
}
