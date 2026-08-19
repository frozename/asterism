import assert from 'node:assert/strict';
import test from 'node:test';
import { findLeaks, scrub } from '../src/core/scrub.js';

const HOME = '/Users/asterism-test-user';
const REPO_ROOT = '/Volumes/build-cache/asterism-checkout';
const OPTS = { home: HOME, extraRoots: [REPO_ROOT] };

const KIND_SAMPLES = [
  ['home', `the operator's home is ${HOME} today`],
  ['userpath', 'a stray path: /Users/someone-else/project/file.js seen'],
  ['tmppath', 'scratch dir /tmp/asterism-run-8821/socket.sock used'],
  ['uuid', 'session id 6f9619ff-8b86-d011-b42d-00c04fc964ff logged'],
  ['hex', `digest ${'deadbeef'.repeat(5)} recorded`],
  ['token', 'bearer aB3xQ9zK2mN7pR5tY8wZ1cD4 attached'],
  ['root', `checkout at ${REPO_ROOT}/src/index.js built`],
];

for (const [kind, text] of KIND_SAMPLES) {
  test(`findLeaks detects ${kind} and scrub redacts it to the same length`, () => {
    const leaks = findLeaks(text, OPTS);
    assert.equal(leaks.length, 1, `expected exactly one leak in: ${text}`);
    assert.equal(leaks[0].kind, kind);

    const { text: scrubbed, redactions } = scrub(text, OPTS);
    assert.equal(scrubbed.length, text.length);
    assert.deepEqual(redactions, leaks);

    const replaced = scrubbed.slice(leaks[0].offset, leaks[0].offset + leaks[0].length);
    assert.equal(replaced.length, leaks[0].length);
    assert.ok(replaced.startsWith(`<${kind}`), `placeholder should start with <${kind}: ${replaced}`);
  });
}

test('idempotence and no-leaks-after-scrub over a composite input', () => {
  const composite = KIND_SAMPLES.map(([, text]) => text).join('\n');

  const first = scrub(composite, OPTS);
  assert.equal(first.text.length, composite.length);
  assert.ok(first.redactions.length >= KIND_SAMPLES.length);

  const second = scrub(first.text, OPTS);
  assert.equal(second.text, first.text);
  assert.deepEqual(second.redactions, []);

  assert.deepEqual(findLeaks(first.text, OPTS), []);
});

test('a clean paragraph with ordinary words, a short hex id, and a relative path produces zero leaks', () => {
  const clean =
    'The quick brown fox jumps over the lazy dog. Commit abc123 touched ' +
    'src/index.js and ../relative/path/thing.js. Nothing sensitive here, ' +
    'just prose about a small project and its short id ab12cd34.';

  assert.deepEqual(findLeaks(clean, OPTS), []);
  const { text, redactions } = scrub(clean, OPTS);
  assert.equal(text, clean);
  assert.deepEqual(redactions, []);
});

test('placeholder output never re-flags, including a short span that truncates the tag', () => {
  for (const [kind, text] of KIND_SAMPLES) {
    const { text: scrubbed } = scrub(text, OPTS);
    assert.deepEqual(findLeaks(scrubbed, OPTS), [], `${kind} placeholder should not re-flag`);
  }

  const tinyHome = { home: '/h', extraRoots: [] };
  const { text: scrubbedTiny } = scrub('cwd is /h now', tinyHome);
  assert.equal(scrubbedTiny.length, 'cwd is /h now'.length);
  assert.deepEqual(findLeaks(scrubbedTiny, tinyHome), []);
});

test('overlapping candidates resolve to the earliest-starting, then longest, match', () => {
  const text = `nested path ${HOME}/project/deep/file.js end`;
  const leaks = findLeaks(text, OPTS);
  assert.equal(leaks.length, 1);
  assert.equal(leaks[0].kind, 'userpath');
  assert.ok(leaks[0].length > HOME.length, 'the longer userpath match should win over the shorter home match');

  const { text: scrubbed } = scrub(text, OPTS);
  assert.equal(scrubbed.includes(HOME), false, 'the home value must not survive inside the winning redaction');
});
