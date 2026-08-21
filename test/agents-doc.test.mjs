import assert from 'node:assert/strict';
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
