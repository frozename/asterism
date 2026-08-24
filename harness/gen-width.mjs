#!/usr/bin/env node
// Generates src/core/width.js: a per-code-point terminal-column-width table.
//
// Two derivation paths for the WIDE (East-Asian-Width W/F) half of the table:
//   - UCD path: given a local EastAsianWidth.txt, parse its W/F ranges directly
//     and stamp the version out of the file's own header comment.
//   - Fallback (no file given, no network -- a worktree has none): approximate
//     wide via V8 Unicode property escapes -- Script=Han/Hangul/Hiragana/Katakana,
//     Emoji_Presentation minus the regional-indicator block, plus three explicit
//     wide blocks (fullwidth forms, CJK symbols/punctuation). East_Asian_Width
//     itself is not a property-escape property, so this is a recorded deviation
//     from the true UCD table, not the table itself.
//
// The ZERO-width half (general categories Mn, Me, Cf, plus the explicit
// U+200B-U+200F run) is always derived via property escapes on both paths --
// EastAsianWidth.txt carries no general-category data to parse.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_CODEPOINT = 0x10ffff;
const SURROGATE_LO = 0xd800;
const SURROGATE_HI = 0xdfff;
const REGIONAL_INDICATOR_LO = 0x1f1e6;
const REGIONAL_INDICATOR_HI = 0x1f1ff;
const ZERO_WIDTH_EXPLICIT_LO = 0x200b;
const ZERO_WIDTH_EXPLICIT_HI = 0x200f;
const EXPLICIT_WIDE_BLOCKS = Object.freeze([
  [0x3000, 0x303e],
  [0xff01, 0xff60],
  [0xffe0, 0xffe6],
]);

const RE_HAN = /\p{Script=Han}/gu;
const RE_HANGUL = /\p{Script=Hangul}/gu;
const RE_HIRAGANA = /\p{Script=Hiragana}/gu;
const RE_KATAKANA = /\p{Script=Katakana}/gu;
const RE_EMOJI_PRESENTATION = /\p{Emoji_Presentation}/gu;
const RE_MN = /\p{Mn}/gu;
const RE_ME = /\p{Me}/gu;
const RE_CF = /\p{Cf}/gu;

/** @param {{ ucdText?: string, unicodeVersion?: string }} [options] */
export function generateWidthModule({ ucdText, unicodeVersion } = {}) {
  const usingUcd = typeof ucdText === 'string' && ucdText.length > 0;
  const haystack = scalarHaystack();

  const wideCodePoints = usingUcd ? deriveWideFromUcd(ucdText) : deriveWideFallback(haystack);
  const zeroCodePoints = deriveZeroFallback(haystack);

  const version =
    typeof unicodeVersion === 'string' && unicodeVersion.length > 0
      ? unicodeVersion
      : usingUcd
        ? deriveVersionFromHeader(ucdText)
        : null;
  if (version === null) {
    throw new Error('gen-width: unicodeVersion is required when ucdText is not supplied');
  }

  return renderModule({
    unicodeVersion: version,
    wideRanges: toRanges(wideCodePoints),
    zeroRanges: toRanges(zeroCodePoints),
    usingUcd,
  });
}

// One instance of every valid Unicode scalar value, in order. Scanning this
// once with each property-escape regex (native code, `matchAll`) is far
// cheaper than testing every code point against every property one at a time.
function scalarHaystack() {
  const parts = [];
  for (let cp = 0; cp <= MAX_CODEPOINT; cp += 1) {
    if (cp >= SURROGATE_LO && cp <= SURROGATE_HI) continue;
    parts.push(String.fromCodePoint(cp));
  }
  return parts.join('');
}

function matchedCodePoints(haystack, regex) {
  const codePoints = new Set();
  for (const match of haystack.matchAll(regex)) {
    codePoints.add(match[0].codePointAt(0));
  }
  return codePoints;
}

function deriveWideFallback(haystack) {
  const wide = new Set();

  for (const [lo, hi] of EXPLICIT_WIDE_BLOCKS) {
    for (let cp = lo; cp <= hi; cp += 1) wide.add(cp);
  }
  for (const cp of matchedCodePoints(haystack, RE_HAN)) wide.add(cp);
  for (const cp of matchedCodePoints(haystack, RE_HANGUL)) wide.add(cp);
  for (const cp of matchedCodePoints(haystack, RE_HIRAGANA)) wide.add(cp);
  for (const cp of matchedCodePoints(haystack, RE_KATAKANA)) wide.add(cp);

  // Regional indicators carry Emoji_Presentation but must stay width 1 each --
  // that is the only way a flag pair renders 2, not the emoji width 2.
  for (const cp of matchedCodePoints(haystack, RE_EMOJI_PRESENTATION)) {
    if (cp >= REGIONAL_INDICATOR_LO && cp <= REGIONAL_INDICATOR_HI) continue;
    wide.add(cp);
  }

  return wide;
}

function deriveZeroFallback(haystack) {
  const zero = new Set();

  for (let cp = ZERO_WIDTH_EXPLICIT_LO; cp <= ZERO_WIDTH_EXPLICIT_HI; cp += 1) zero.add(cp);
  for (const cp of matchedCodePoints(haystack, RE_MN)) zero.add(cp);
  for (const cp of matchedCodePoints(haystack, RE_ME)) zero.add(cp);
  for (const cp of matchedCodePoints(haystack, RE_CF)) zero.add(cp);

  return zero;
}

function deriveWideFromUcd(ucdText) {
  const wide = new Set();

  for (const rawLine of ucdText.split(/\r?\n/)) {
    const withoutComment = rawLine.split('#')[0].trim();
    if (withoutComment.length === 0) continue;

    const [rangeField, categoryField] = withoutComment.split(';').map((part) => part.trim());
    if (categoryField !== 'W' && categoryField !== 'F') continue;

    const [loHex, hiHex] = rangeField.split('..');
    const lo = Number.parseInt(loHex, 16);
    const hi = hiHex !== undefined ? Number.parseInt(hiHex, 16) : lo;
    for (let cp = lo; cp <= hi; cp += 1) wide.add(cp);
  }

  return wide;
}

function deriveVersionFromHeader(ucdText) {
  const headerLines = ucdText.split(/\r?\n/).slice(0, 10);
  for (const line of headerLines) {
    const match = line.match(/(\d+\.\d+\.\d+)/);
    if (match) return match[1];
  }
  throw new Error("gen-width: could not derive a Unicode version out of the EastAsianWidth.txt header");
}

function toRanges(codePoints) {
  const sorted = [...codePoints].sort((a, b) => a - b);
  const ranges = [];
  let index = 0;

  while (index < sorted.length) {
    const lo = sorted[index];
    let hi = lo;
    let next = index + 1;
    while (next < sorted.length && sorted[next] === hi + 1) {
      hi = sorted[next];
      next += 1;
    }
    ranges.push([lo, hi]);
    index = next;
  }

  return ranges;
}

function toHex(codePoint) {
  return `0x${codePoint.toString(16)}`;
}

function renderRangeArray(ranges) {
  if (ranges.length === 0) return 'Object.freeze([])';
  const body = ranges.map(([lo, hi]) => `  Object.freeze([${toHex(lo)}, ${toHex(hi)}]),`).join('\n');
  return `Object.freeze([\n${body}\n])`;
}

function renderModule({ unicodeVersion, wideRanges, zeroRanges, usingUcd }) {
  const wideSourceNote = usingUcd
    ? 'sourced via a supplied EastAsianWidth.txt -- its W/F ranges, parsed directly'
    : 'sourced via V8 Unicode property escapes (Script=Han/Hangul/Hiragana/Katakana, ' +
      'Emoji_Presentation minus regional indicators, plus three explicit wide blocks) -- ' +
      'a recorded deviation, since East_Asian_Width itself is not a property-escape property';

  return `// Generated by harness/gen-width.mjs -- do not hand-edit; regenerate instead.
//
// Unicode version: ${unicodeVersion}.
// Wide (East-Asian-Width W/F) ranges: ${wideSourceNote}.
// Zero-width ranges (general categories Mn, Me, Cf, plus the explicit U+200B-U+200F
// run) are always derived via property escapes on either path: EastAsianWidth.txt
// carries no general-category data, so this half of the table has no true-UCD path.
//
// Width law, applied in this order: East-Asian-Width W/F -> 2; Mn/Me/Cf and
// U+200B-U+200F -> 0; everything else, including a lone regional indicator, -> 1.
// A ZWJ-joined cluster is never collapsed to one grapheme's width -- displayWidth
// sums codePointWidth over every code point, because that is what tmux itself does.

export const UNICODE_VERSION = ${JSON.stringify(unicodeVersion)};

export const WIDE_RANGES = ${renderRangeArray(wideRanges)};

export const ZERO_RANGES = ${renderRangeArray(zeroRanges)};

function inRanges(ranges, codePoint) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = ranges[mid];
    if (codePoint < range[0]) hi = mid - 1;
    else if (codePoint > range[1]) lo = mid + 1;
    else return true;
  }
  return false;
}

export function codePointWidth(codePoint) {
  if (inRanges(WIDE_RANGES, codePoint)) return 2;
  if (inRanges(ZERO_RANGES, codePoint)) return 0;
  return 1;
}

export function displayWidth(str) {
  let width = 0;
  for (const ch of str) {
    width += codePointWidth(ch.codePointAt(0));
  }
  return width;
}
`;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = process.argv[2];
  const source =
    typeof arg === 'string' && arg.length > 0
      ? generateWidthModule({ ucdText: readFileSync(path.resolve(arg), 'utf8') })
      : generateWidthModule({ unicodeVersion: process.versions.unicode });

  const outPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'core', 'width.js');
  writeFileSync(outPath, source);
  process.stdout.write(`wrote ${outPath}\n`);
}
