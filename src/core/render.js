import { displayWidth }
  from
    './width.js';

const REPLACEMENT_CHAR = '�';
const ELLIPSIS = '…';
const COLUMN_SEPARATOR = '  ';

// Threat T13: `ast ls` prints agent-controlled names. A name carrying OSC/CSI
// bytes can rewrite the user's terminal or spoof a prompt, so every control
// code point is replaced with a visible marker -- never passed through, never
// silently dropped.
function isControlCodePoint(codePoint) {
  if (codePoint <= 0x1f) return true;
  if (codePoint === 0x7f) return true;
  if (codePoint >= 0x80 && codePoint <= 0x9f) return true;
  return false;
}

/** @param {unknown} value @param {{ maxWidth?: number }} [options] */
export function untrusted(value, { maxWidth } = {}) {
  const coerced = String(value);
  let sanitized = '';
  for (const ch of coerced) {
    sanitized += isControlCodePoint(ch.codePointAt(0)) ? REPLACEMENT_CHAR : ch;
  }

  if (typeof maxWidth === 'number' && displayWidth(sanitized) > maxWidth) {
    sanitized = truncateToWidth(sanitized, maxWidth);
  }

  return sanitized;
}

// Cuts at Intl.Segmenter grapheme boundaries, never inside one: a family
// emoji that does not fit is dropped whole rather than left as a bare,
// partial ZWJ sequence.
function truncateToWidth(sanitized, maxWidth) {
  if (maxWidth < displayWidth(ELLIPSIS)) return '';

  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(sanitized)].map(
    (entry) => entry.segment,
  );
  const ellipsisWidth = displayWidth(ELLIPSIS);

  let kept = '';
  let width = 0;
  for (const grapheme of graphemes) {
    const graphemeWidth = displayWidth(grapheme);
    if (width + graphemeWidth + ellipsisWidth > maxWidth) break;
    kept += grapheme;
    width += graphemeWidth;
  }

  return `${kept}${ELLIPSIS}`;
}

export function table(rows, cols = []) {
  const rendered = rows.map((row) => row.map((cell, colIndex) => untrusted(cell, cols[colIndex] ?? {})));

  let columnCount = 0;
  for (const row of rendered) columnCount = Math.max(columnCount, row.length);

  const columnWidths = [];
  for (let col = 0; col < columnCount; col += 1) {
    let width = 0;
    for (const row of rendered) width = Math.max(width, displayWidth(row[col] ?? ''));
    columnWidths[col] = width;
  }

  return rendered
    .map((row) =>
      row.map((cell, colIndex) => cell + ' '.repeat(columnWidths[colIndex] - displayWidth(cell))).join(COLUMN_SEPARATOR),
    )
    .join('\n');
}
