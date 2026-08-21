import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARCHITECTURE_PATH = path.join(ROOT, 'ARCHITECTURE.md');
const CITATION_PATTERN = /`((?:(?:src|bin|test|harness|schema|\.github)\/[^`\s]+|AGENTS\.md|README\.md))`/g;
const MINIMUM_CITATION_COUNT = 40;

function citedPaths(markdown) {
  return [...markdown.matchAll(CITATION_PATTERN)].map((match) => match[1]);
}

function missingCitedPaths(markdown, root) {
  return citedPaths(markdown).filter((relativePath) => !existsSync(path.resolve(root, relativePath)));
}

test('ARCHITECTURE.md cites a substantial set of existing repository paths', async () => {
  let markdown = null;
  try {
    markdown = await readFile(ARCHITECTURE_PATH, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  assert.notEqual(markdown, null, 'ARCHITECTURE.md must exist');

  const citations = citedPaths(markdown);
  const uniqueCitations = new Set(citations);
  assert.ok(
    uniqueCitations.size >= MINIMUM_CITATION_COUNT,
    `expected at least ${MINIMUM_CITATION_COUNT} distinct path citations, found ${uniqueCitations.size}`,
  );

  const missing = missingCitedPaths(markdown, ROOT);
  assert.deepEqual(missing, [], `ARCHITECTURE.md cites missing paths:\n${missing.join('\n')}`);
});

test('citation parser and path check reject a synthetic missing path', () => {
  const synthetic = 'A claim enforced by `src/architecture-path-that-does-not-exist.js`.';

  assert.deepEqual(citedPaths(synthetic), ['src/architecture-path-that-does-not-exist.js']);
  assert.deepEqual(missingCitedPaths(synthetic, ROOT), ['src/architecture-path-that-does-not-exist.js']);
});
