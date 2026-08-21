import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS_PATH = path.join(ROOT, 'AGENTS.md');
const FENCE_PATTERN = /^\s*```/;

// A command AGENTS.md prescribes has to run for whoever reads it, and the
// readers are not all standing in this working copy. A shallow CI checkout
// (`actions/checkout` defaults to `fetch-depth: 1` and leaves a detached HEAD
// with no local branch), a fresh clone, and a worktree each resolve a
// different set of refs. Every construct below names a ref the reader's clone
// may simply not have.
//
// The failure is worse than an error, because each of these is normally
// written inside a command substitution: `git merge-base main HEAD` exits 128
// with "Not a valid object name main", `$(...)` swallows it, and the outer
// `git diff --stat ..HEAD` then exits 0 having printed nothing. The reader is
// told their change is empty and commits.
const FRAGILE_REFS = Object.freeze([
  Object.freeze({ id: 'merge-base', pattern: /\bmerge-base\b/, why: 'needs a local branch the reader may not have' }),
  Object.freeze({ id: 'upstream', pattern: /@\{upstream\}/, why: 'needs a configured upstream' }),
  Object.freeze({ id: 'remote-ref', pattern: /\borigin\//, why: 'needs a remote named origin' }),
  Object.freeze({ id: 'ancestor-count', pattern: /\bHEAD~/, why: 'needs history a shallow clone does not have' }),
]);

// The zero this file asserts is only worth something if the extractor found
// commands to look at. Four is the size of the single "Before you commit"
// block; if a reorganisation drops below it, that is worth a failure.
const MINIMUM_COMMAND_COUNT = 4;

export function fencedCommands(markdown) {
  const commands = [];
  let inside = false;

  for (const line of markdown.split(/\r?\n/)) {
    if (FENCE_PATTERN.test(line)) {
      inside = !inside;
      continue;
    }
    if (inside && line.trim().length > 0) commands.push(line.trim());
  }

  return commands;
}

export function fragileRefUsages(commands) {
  const violations = [];

  for (const command of commands) {
    for (const ref of FRAGILE_REFS) {
      if (ref.pattern.test(command)) violations.push(`${ref.id}: ${command} (${ref.why})`);
    }
  }

  return violations;
}

test('every command AGENTS.md prescribes runs in a clone that lacks a local main, a remote, and history', async () => {
  const markdown = await readFile(AGENTS_PATH, 'utf8');
  const commands = fencedCommands(markdown);

  assert.ok(
    commands.length >= MINIMUM_COMMAND_COUNT,
    `extracted only ${commands.length} commands from AGENTS.md; the zero below would prove nothing`,
  );

  const violations = fragileRefUsages(commands);
  assert.deepEqual(violations, [], `AGENTS.md prescribes commands that depend on refs a reader may not have:\n${violations.join('\n')}`);
});

test('control: each fragile construct is caught, and a portable block passes', () => {
  const offenders = [
    'git diff --stat $(git merge-base main HEAD)..HEAD',
    'git log @{upstream}..HEAD',
    'git rev-list --count origin/main..main',
    'git diff --stat HEAD~3..HEAD',
  ];

  for (const offender of offenders) {
    assert.equal(fragileRefUsages([offender]).length, 1, `checker did not flag: ${offender}`);
  }

  assert.deepEqual(fragileRefUsages(['node --test', 'bun test', 'git status --short', 'git diff --stat HEAD']), []);
});

test('control: the fence extractor takes fenced lines and leaves prose alone', () => {
  const markdown = ['prose git merge-base main HEAD', '```', 'node --test', '', 'bun test', '```', 'more prose'].join('\n');

  assert.deepEqual(fencedCommands(markdown), ['node --test', 'bun test']);
  assert.deepEqual(fragileRefUsages(fencedCommands(markdown)), []);
});

// A path in backticks is normally a claim that the file enforces what the
// sentence around it says, and a claim about a file that no longer exists is
// the cheapest kind of documentation rot. Not every citation is that, though:
// some name a path to explain what would happen if it existed. Those are
// declared here with the reason, so the exemption is a decision on the record
// rather than a hole in the check.
const HYPOTHETICAL_CITATIONS = Object.freeze({
  'test/index.js':
    'named to explain what `node --test test/` would resolve the directory argument to; the file deliberately does not exist',
});

const CITATION_PATTERN = /`((?:src|bin|test|harness|schema|\.github|\.githooks)\/[^`\s]+)`/g;

// The zero below is only worth something if the extractor found citations.
const MINIMUM_CITATION_COUNT = 6;

export function citedPaths(markdown) {
  return [...markdown.matchAll(CITATION_PATTERN)].map((match) => match[1]);
}

export function deadCitations(markdown, root, hypothetical = HYPOTHETICAL_CITATIONS) {
  const dead = [];

  for (const cited of new Set(citedPaths(markdown))) {
    const declared = Object.hasOwn(hypothetical, cited);
    const present = existsSync(path.resolve(root, cited));

    if (declared && typeof hypothetical[cited] === 'string' && hypothetical[cited].trim().length > 0) continue;
    if (declared) dead.push(`${cited}: declared hypothetical without a reason`);
    else if (!present) dead.push(`${cited}: cited but absent, and not declared hypothetical`);
  }

  return dead;
}

test('every path AGENTS.md cites exists, or is declared hypothetical with a reason', async () => {
  const markdown = await readFile(AGENTS_PATH, 'utf8');
  const citations = new Set(citedPaths(markdown));

  assert.ok(
    citations.size >= MINIMUM_CITATION_COUNT,
    `extracted only ${citations.size} citations from AGENTS.md; the zero below would prove nothing`,
  );

  const dead = deadCitations(markdown, ROOT);
  assert.deepEqual(dead, [], `AGENTS.md cites paths that are neither present nor declared:\n${dead.join('\n')}`);
});

test('control: an absent citation is caught, an undeclared reason is caught, a declared one passes', () => {
  const absent = 'A claim enforced by `src/agents-doc-path-that-does-not-exist.js`.';
  assert.equal(deadCitations(absent, ROOT, {}).length, 1, 'checker did not flag an absent citation');

  assert.equal(
    deadCitations(absent, ROOT, { 'src/agents-doc-path-that-does-not-exist.js': '  ' }).length,
    1,
    'checker did not flag a hypothetical declared without a reason',
  );

  assert.deepEqual(deadCitations(absent, ROOT, { 'src/agents-doc-path-that-does-not-exist.js': 'why it is absent' }), []);
  assert.deepEqual(deadCitations('A real one: `harness/secret-scan.mjs`.', ROOT, {}), []);
});
