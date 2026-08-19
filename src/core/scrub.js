const KIND_HOME = 'home';
const KIND_USERPATH = 'userpath';
const KIND_TMPPATH = 'tmppath';
const KIND_UUID = 'uuid';
const KIND_HEX = 'hex';
const KIND_TOKEN = 'token';
const KIND_ROOT = 'root';

const KIND_PRECEDENCE = [KIND_HOME, KIND_USERPATH, KIND_TMPPATH, KIND_UUID, KIND_HEX, KIND_TOKEN, KIND_ROOT];

// A path token runs until whitespace, a quote (' " `), or a closing bracket.
const PATH_TERMINATOR_CHARS = `\\s'"\`)\\]}>`;
const USERPATH_RE = new RegExp(`/(?:Users|home)/[^${PATH_TERMINATOR_CHARS}]+`, 'g');
const TMPPATH_RE = new RegExp(`/(?:tmp|private|var/folders)/[^${PATH_TERMINATOR_CHARS}]*`, 'g');
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX_RE = /[0-9a-fA-F]{32,}/g;
const TOKEN_RE = /[A-Za-z0-9_-]{20,}/g;
const TOKEN_MIN_ENTROPY_BITS = 3.5;

export function findLeaks(text, options = {}) {
  const { home, extraRoots = [] } = options;
  const candidates = [];

  collectLiteral(candidates, text, home, KIND_HOME);
  collectRegex(candidates, text, USERPATH_RE, KIND_USERPATH);
  collectRegex(candidates, text, TMPPATH_RE, KIND_TMPPATH);
  collectRegex(candidates, text, UUID_RE, KIND_UUID);
  collectRegex(candidates, text, HEX_RE, KIND_HEX);
  collectRegex(candidates, text, TOKEN_RE, KIND_TOKEN, isQualifyingToken);
  for (const root of extraRoots) collectLiteral(candidates, text, root, KIND_ROOT);

  return resolveOverlaps(candidates);
}

export function scrub(text, options = {}) {
  const redactions = findLeaks(text, options);
  const parts = [];
  let cursor = 0;

  for (const leak of redactions) {
    parts.push(text.slice(cursor, leak.offset));
    parts.push(placeholderFor(leak.kind, leak.length));
    cursor = leak.offset + leak.length;
  }
  parts.push(text.slice(cursor));

  return { text: parts.join(''), redactions };
}

function placeholderFor(kind, length) {
  const tag = `<${kind}>`;
  if (length >= tag.length) return tag + '_'.repeat(length - tag.length);
  return tag.slice(0, length);
}

function collectLiteral(candidates, text, needle, kind) {
  if (typeof needle !== 'string' || needle.length === 0) return;

  let offset = text.indexOf(needle);
  while (offset !== -1) {
    candidates.push({ kind, offset, length: needle.length });
    offset = text.indexOf(needle, offset + 1);
  }
}

function collectRegex(candidates, text, regex, kind, qualifies) {
  regex.lastIndex = 0;
  let match = regex.exec(text);
  while (match !== null) {
    if (!qualifies || qualifies(match[0])) {
      candidates.push({ kind, offset: match.index, length: match[0].length });
    }
    match = regex.exec(text);
  }
}

function isQualifyingToken(run) {
  if (!/[0-9]/.test(run) || !/[a-z]/.test(run) || !/[A-Z]/.test(run)) return false;
  return shannonEntropyPerChar(run) >= TOKEN_MIN_ENTROPY_BITS;
}

// A run of one repeated character has zero entropy, so this formula alone
// keeps the underscore-padded placeholders below from ever re-qualifying.
function shannonEntropyPerChar(run) {
  const counts = new Map();
  for (const char of run) counts.set(char, (counts.get(char) ?? 0) + 1);

  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / run.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function resolveOverlaps(candidates) {
  const sorted = [...candidates].sort((a, b) => {
    if (a.offset !== b.offset) return a.offset - b.offset;
    if (a.length !== b.length) return b.length - a.length;
    return KIND_PRECEDENCE.indexOf(a.kind) - KIND_PRECEDENCE.indexOf(b.kind);
  });

  const result = [];
  let coveredUntil = -1;
  for (const candidate of sorted) {
    if (candidate.offset < coveredUntil) continue;
    result.push(candidate);
    coveredUntil = candidate.offset + candidate.length;
  }
  return result;
}
