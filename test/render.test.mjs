import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { table, untrusted } from '../src/core/render.js';
import { displayWidth } from '../src/core/width.js';

const VECTORS_URL = new URL('../vectors/render/hostile-names.json', import.meta.url);
const ZWJ = '‍';
const REPLACEMENT_CHAR = '�';

function loadVectors() {
  const raw = readFileSync(VECTORS_URL, 'utf8');
  return JSON.parse(raw);
}

function codePointsOf(str) {
  return [...str].map((ch) => ch.codePointAt(0));
}

function hitsAnyRange(str, ranges) {
  return codePointsOf(str).some((codePoint) => ranges.some(([lo, hi]) => codePoint >= lo && codePoint <= hi));
}

test('hostile-names vectors: sanitized output never hits a mustNotContain range, sanitizedWidth matches', () => {
  const vectors = loadVectors();
  for (const vector of vectors) {
    const out = untrusted(vector.input);
    assert.equal(hitsAnyRange(out, vector.mustNotContain), false, `${vector.id}: sanitized output still hits a control range`);
    assert.equal(displayWidth(out), vector.sanitizedWidth, `${vector.id}: sanitizedWidth mismatch`);
  }
});

test('control: the raw osc2 and csi inputs do hit [0,31] -- a zero from the sweep proves nothing unless the scanner bites', () => {
  const vectors = loadVectors();
  const osc2 = vectors.find((vector) => vector.id === 'osc2');
  const csi = vectors.find((vector) => vector.id === 'csi');

  assert.ok(hitsAnyRange(osc2.input, osc2.mustNotContain), 'raw osc2 input should hit a control range');
  assert.ok(hitsAnyRange(csi.input, csi.mustNotContain), 'raw csi input should hit a control range');
});

test('clean-pass control: an ordinary filename passes through byte-identical', () => {
  assert.equal(untrusted('plain-name.txt'), 'plain-name.txt');
});

test('marker is substitution, not deletion: ESC becomes one visible marker', () => {
  assert.equal(untrusted('\u001b'), REPLACEMENT_CHAR);
});

test('truncation cuts at grapheme boundaries by column width, never mid-grapheme', () => {
  assert.equal(untrusted('漢字漢字', { maxWidth: 5 }), '漢字…');

  const family = `\u{1F469}${ZWJ}\u{1F469}${ZWJ}\u{1F467}`;
  const clipped = untrusted(`${family}x`, { maxWidth: 4 });
  assert.ok(displayWidth(clipped) <= 4, 'clipped output must respect maxWidth');
  assert.equal(clipped.includes(ZWJ), false, 'a family emoji that does not fit must be dropped whole, never left as a bare partial ZWJ sequence');

  assert.equal(untrusted('abc', { maxWidth: 3 }), 'abc', 'exactly at maxWidth stays unmarked');
});

test('law: truncated output never exceeds maxWidth, across every vector', () => {
  const vectors = loadVectors();
  for (const vector of vectors) {
    const out = untrusted(vector.input, { maxWidth: 10 });
    assert.ok(displayWidth(out) <= 10, `${vector.id}: truncated output exceeds maxWidth`);
  }
});

test('table: padding comes from displayWidth, not String.length', () => {
  assert.equal('漢字'.length, 'ab'.length, 'control: same UTF-16 length, different display width');

  const rendered = table([
    ['漢字', 'x'],
    ['ab', 'y'],
  ]);
  const [line0, line1] = rendered.split('\n');

  const pad0 = line0.match(/^漢字( *)/)[1].length;
  const pad1 = line1.match(/^ab( *)/)[1].length;
  assert.equal(
    pad1 - pad0,
    2,
    'the "ab" cell must get exactly 2 more trailing pad spaces than the "漢字" cell -- a .length-based ' +
      'pad would have produced equal padding here and misaligned the columns',
  );

  assert.equal(displayWidth(line0), displayWidth(line1));
});
