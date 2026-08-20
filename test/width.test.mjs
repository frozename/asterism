import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { generateWidthModule } from '../harness/gen-width.mjs';
import { codePointWidth, displayWidth, UNICODE_VERSION } from '../src/core/width.js';

const VECTORS_URL = new URL('../vectors/render/hostile-names.json', import.meta.url);

function loadVectors() {
  const raw = readFileSync(VECTORS_URL, 'utf8');
  return JSON.parse(raw);
}

test('displayWidth: the five measured tmux 3.7c values', () => {
  assert.equal(displayWidth('漢字ab'), 6);
  assert.equal(displayWidth('🔥x'), 3);
  assert.equal(displayWidth('éx'), 2);
  assert.equal(displayWidth('🇧🇷'), 2);
  assert.equal(
    displayWidth('👩‍👩‍👧'),
    6,
    'tmux sums the ZWJ-joined family emoji\'s components instead of collapsing the cluster; ' +
      'an Intl.Segmenter-grapheme approximation says 2, off by 4 columns',
  );
});

test('per-code-point law: the family emoji width equals the sum of its parts', () => {
  const sum =
    displayWidth('👩') + displayWidth('‍') + displayWidth('👩') + displayWidth('‍') + displayWidth('👧');
  assert.equal(sum, 6);
  assert.equal(sum, displayWidth('👩‍👩‍👧'));
});

test('a lone regional indicator is width 1, so a flag pair renders 2, never the emoji width 2', () => {
  assert.equal(displayWidth('🇧'), 1);
});

test('codePointWidth: spot values', () => {
  assert.equal(codePointWidth(0x6f22), 2);
  assert.equal(codePointWidth(0x1f525), 2);
  assert.equal(codePointWidth(0x0301), 0);
  assert.equal(codePointWidth(0x200d), 0);
  assert.equal(codePointWidth(0x200b), 0);
  assert.equal(codePointWidth(0x61), 1);
  assert.equal(codePointWidth(0x1f1e7), 1);
  assert.equal(codePointWidth(0xfffd), 1);
  assert.equal(codePointWidth(0x2026), 1);
});

test('hostile-names vectors: file parses, 12 unique ids, every non-null inputWidth matches displayWidth', () => {
  const vectors = loadVectors();
  assert.equal(vectors.length, 12);

  const ids = new Set();
  for (const vector of vectors) {
    assert.equal(ids.has(vector.id), false, `duplicate vector id "${vector.id}"`);
    ids.add(vector.id);

    if (vector.inputWidth !== null) {
      assert.equal(displayWidth(vector.input), vector.inputWidth, `${vector.id}: inputWidth mismatch`);
    }
  }
  assert.equal(ids.size, 12);
});

test('UNICODE_VERSION is a non-empty version string', () => {
  assert.equal(typeof UNICODE_VERSION, 'string');
  assert.ok(UNICODE_VERSION.length > 0);
  assert.match(UNICODE_VERSION, /^\d+(\.\d+){0,2}$/);
});

test('generator pin: fallback output for a dummy version stamps it and never emits a from-quote import token', () => {
  const source = generateWidthModule({ unicodeVersion: '999.999.999' });
  assert.ok(source.includes('999.999.999'), 'output should carry the dummy version stamp');
  assert.equal(source.includes("from '"), false, 'regeneration must never trip the purity import sweep');
  assert.equal(source.includes('from "'), false, 'regeneration must never trip the purity import sweep');
});
