import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  SCOPE_VOCABULARY,
  validateCommitMessage,
} from '../harness/commitlint.mjs';
import { procexec } from '../src/io/procexec.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXEC_ENV = { PATH: process.env.PATH ?? '' };
const HISTORY_LOG_FORMAT = '--format=tformat:%B';
const HISTORY_LOG_ARGS = Object.freeze(['log', '-z', HISTORY_LOG_FORMAT]);

function assertVectorPair({ name, rejected, code, accepted }) {
  test(`${name} is rejected beside an accepting control`, () => {
    const bad = validateCommitMessage(rejected);
    const good = validateCommitMessage(accepted);

    assert.equal(bad.valid, false, `${JSON.stringify(rejected)} should be rejected`);
    assert.ok(
      bad.violations.some((violation) => violation.code === code),
      `${JSON.stringify(rejected)} should report ${code}: ${JSON.stringify(bad.violations)}`,
    );
    assert.deepEqual(good, { valid: true, violations: [] }, `${JSON.stringify(accepted)} should pass`);
  });
}

for (const vector of [
  {
    name: 'missing scope',
    rejected: 'feat: add ast new',
    code: 'scope.required',
    accepted: 'feat(cli): add ast new',
  },
  {
    name: 'malformed header',
    rejected: 'feat(cli) add ast new',
    code: 'header.format',
    accepted: 'feat(cli): add ast new',
  },
  {
    name: 'unknown type',
    rejected: 'feature(cli): add ast new',
    code: 'type.unknown',
    accepted: 'feat(cli): add ast new',
  },
  {
    name: 'capitalised subject',
    rejected: 'feat(cli): Add ast new',
    code: 'subject.lowercase',
    accepted: 'feat(cli): add ast new',
  },
  {
    name: 'trailing period',
    rejected: 'feat(cli): add ast new.',
    code: 'subject.period',
    accepted: 'feat(cli): add ast new',
  },
  {
    name: 'over-length header',
    rejected: `feat(cli): ${'a'.repeat(62)}`,
    code: 'header.length',
    accepted: `feat(cli): ${'a'.repeat(61)}`,
  },
  {
    name: 'over-length subject',
    rejected: `feat(cli): ${'a'.repeat(73)}`,
    code: 'subject.length',
    accepted: `feat(cli): ${'a'.repeat(61)}`,
  },
  {
    name: 'missing blank line before body',
    rejected: 'feat(cli): add ast new\nBody starts immediately',
    code: 'body.blank-line',
    accepted: 'feat(cli): add ast new\n\nBody follows a blank line',
  },
  {
    name: 'empty subject',
    rejected: 'feat(cli): ',
    code: 'subject.empty',
    accepted: 'feat(cli): add ast new',
  },
  {
    name: 'unknown scope',
    rejected: 'feat(product): add ast new',
    code: 'scope.unknown',
    accepted: 'feat(core): add ast new',
  },
  {
    name: 'non-imperative subject',
    rejected: 'feat(cli): added ast new',
    code: 'subject.imperative',
    accepted: 'feat(cli): add ast new',
  },
  {
    name: 'third-person subject',
    rejected: 'feat(cli): adds ast new',
    code: 'subject.imperative',
    accepted: 'feat(cli): add ast new',
  },
  {
    name: 'over-length body line',
    rejected: `docs(docs): describe commits\n\n${'b'.repeat(101)}`,
    code: 'body.line-length',
    accepted: `docs(docs): describe commits\n\n${'b'.repeat(100)}`,
  },
]) {
  assertVectorPair(vector);
}

test('breaking marker and every declared type are accepted controls', () => {
  const types = ['feat', 'fix', 'refactor', 'test', 'docs', 'chore', 'perf', 'build', 'ci'];

  for (const type of types) {
    assert.deepEqual(validateCommitMessage(`${type}(test)!: exercise breaking control`), {
      valid: true,
      violations: [],
    });
  }
});

test('scope vocabulary is derived from every current src directory plus repository scopes', async () => {
  const entries = await readdir(path.join(ROOT, 'src'), { withFileTypes: true });
  const srcScopes = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

  assert.ok(srcScopes.length > 0, 'src/ must expose at least one directory-backed scope control');
  for (const scope of [...srcScopes, 'bin', 'harness', 'test', 'ci', 'docs']) {
    assert.ok(SCOPE_VOCABULARY.includes(scope), `${scope} should be in the derived scope vocabulary`);
    assert.equal(validateCommitMessage(`chore(${scope}): exercise derived scope`).valid, true);
  }
});

test('violations are structured and specific', () => {
  const result = validateCommitMessage('feature(product): Added a thing.');

  assert.equal(result.valid, false);
  assert.ok(result.violations.length >= 4);
  for (const violation of result.violations) {
    assert.deepEqual(Object.keys(violation).sort(), ['code', 'message']);
    assert.equal(typeof violation.message, 'string');
    assert.ok(violation.message.length > 0);
  }
});

test('CLI accepts stdin and rejects it with specific violations plus one example', async () => {
  const accepted = await procexec(['node', 'harness/commitlint.mjs'], {
    cwd: ROOT,
    env: EXEC_ENV,
    input: 'feat(cli): add ast new\n',
  });
  const rejected = await procexec(['node', 'harness/commitlint.mjs'], {
    cwd: ROOT,
    env: EXEC_ENV,
    input: 'feat: Add ast new.\n',
  });

  assert.equal(accepted.code, 0);
  assert.equal(accepted.stdout.toString('utf8'), '');
  assert.equal(accepted.stderr.toString('utf8'), '');
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr.toString('utf8'), /scope is required/);
  assert.match(rejected.stderr.toString('utf8'), /example: feat\(cli\): add ast new/);
});

test('commit-msg hook validates a file and is executable', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'asterism-commit-msg-'));
  const messagePath = path.join(temp, 'COMMIT_EDITMSG');
  const hookPath = path.join(ROOT, '.githooks', 'commit-msg');

  await writeFile(messagePath, 'feat(cli): add ast new\n');
  const accepted = await procexec(['/bin/sh', hookPath, messagePath], { cwd: ROOT, env: EXEC_ENV });

  await writeFile(messagePath, 'feat: Add ast new.\n');
  const rejected = await procexec(['/bin/sh', hookPath, messagePath], { cwd: ROOT, env: EXEC_ENV });

  assert.notEqual((await stat(hookPath)).mode & 0o111, 0, 'commit-msg hook should be executable');
  assert.equal(accepted.code, 0);
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr.toString('utf8'), /scope is required/);
  assert.match(rejected.stderr.toString('utf8'), /example: feat\(cli\): add ast new/);
});

test('commit-msg hook fails closed with a clear error when node is missing', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'asterism-commit-msg-no-node-'));
  const messagePath = path.join(temp, 'COMMIT_EDITMSG');
  const hookPath = path.join(ROOT, '.githooks', 'commit-msg');
  await writeFile(messagePath, 'feat(cli): add ast new\n');

  const result = await procexec(['/bin/sh', hookPath, messagePath], {
    cwd: ROOT,
    env: { PATH: '' },
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr.toString('utf8'), /node was not found on PATH/);
});

test('git commit -v scissors and diff content are ignored as non-authored body', () => {
  const message = [
    'feat(cli): accept verbose commit messages',
    '',
    'Keep the authored body short.',
    '',
    '# ------------------------ >8 ------------------------',
    '# Do not modify or remove the line above.',
    '# Everything below it will be ignored.',
    '#',
    '# On branch main',
    '# Changes to be committed:',
    '#\tmodified:   README.md',
    '#',
    'diff --git a/README.md b/README.md',
    'index e79c5e8..6ce46a4 100644',
    '--- a/README.md',
    '+++ b/README.md',
    '@@ -1 +1,2 @@',
    ' initial',
    `+diff-line-${'x'.repeat(140)}`,
    '',
  ].join('\n');

  assert.deepEqual(validateCommitMessage(message), { valid: true, violations: [] });
});

test('default git comment lines are ignored as non-authored body', () => {
  const message = [
    'feat(cli): accept commit template comments',
    '',
    'Keep the authored body short.',
    '# On branch main',
    `# ${'x'.repeat(120)}`,
    '',
  ].join('\n');

  assert.deepEqual(validateCommitMessage(message), { valid: true, violations: [] });
  assert.deepEqual(validateCommitMessage(message, { commentChar: '' }), { valid: true, violations: [] });
  assert.deepEqual(validateCommitMessage(message, { commentChar: 'auto' }), { valid: true, violations: [] });
});

test('configured git comment char controls which comment lines are ignored', () => {
  const semicolonComment = [
    'feat(cli): accept custom comment chars',
    '',
    'Keep the authored body short.',
    '; On branch main',
    `; ${'x'.repeat(120)}`,
    '',
  ].join('\n');
  const hashBody = [
    'feat(cli): reject hash body under semicolon comments',
    '',
    'Keep the authored body short.',
    `# ${'x'.repeat(120)}`,
    '',
  ].join('\n');

  assert.deepEqual(validateCommitMessage(semicolonComment, { commentChar: ';' }), { valid: true, violations: [] });

  const result = validateCommitMessage(hashBody, { commentChar: ';' });
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((violation) => violation.code === 'body.line-length'));
});

test('multi-character git comment chars strip only their exact comment lines', () => {
  const message = [
    'feat(cli): accept multi-character comments',
    '',
    'Keep the authored body short.',
    `// ${'x'.repeat(120)}`,
    '',
  ].join('\n');

  assert.deepEqual(validateCommitMessage(message, { commentChar: '//' }), { valid: true, violations: [] });

  const partialPrefix = validateCommitMessage(message.replace('// ', '/ '), { commentChar: '//' });
  assert.equal(partialPrefix.valid, false);
  assert.ok(partialPrefix.violations.some((violation) => violation.code === 'body.line-length'));
});

test('comment char values that cannot delimit one message line fail loudly', () => {
  assert.throws(
    () => validateCommitMessage('feat(cli): reject invalid comment config\n', { commentChar: 42 }),
    {
      name: 'TypeError',
      message: 'validateCommitMessage: core.commentChar must be a string; commit cleanup cannot be parsed',
    },
  );
  for (const commentChar of ['//\n', '//\r']) {
    assert.throws(
      () => validateCommitMessage('feat(cli): reject invalid comment config\n', { commentChar }),
      {
        name: 'TypeError',
        message: 'validateCommitMessage: core.commentChar cannot contain newline; commit cleanup cannot be parsed',
      },
    );
  }
});

test('genuine long body line remains rejected beside verbose cleanup controls', () => {
  const result = validateCommitMessage(['feat(cli): reject real long body', '', 'x'.repeat(101), ''].join('\n'));

  assert.equal(result.valid, false);
  assert.ok(result.violations.some((violation) => violation.code === 'body.line-length'));
});

test('subject line beginning with hash is still a malformed header', () => {
  const result = validateCommitMessage('# feat(cli): reject commented subject\n');

  assert.equal(result.valid, false);
  assert.ok(result.violations.some((violation) => violation.code === 'header.format'));
});

function checkMessages(messages) {
  const failures = [];
  for (let index = 0; index < messages.length; index += 1) {
    const result = validateCommitMessage(messages[index]);
    if (!result.valid) failures.push({ index, violations: result.violations });
  }
  return failures;
}

async function readHistoryMessages(cwd, range, env = EXEC_ENV, logArgs = HISTORY_LOG_ARGS) {
  const history = await procexec(['git', ...logArgs, range], { cwd, env });
  assert.equal(history.code, 0, `git log failed: ${history.stderr.toString('utf8')}`);
  assert.equal(history.timedOut, false, 'git log timed out');
  assert.equal(history.truncated, false, 'git log exceeded the output cap');

  const output = history.stdout.toString('utf8');
  if (output.length === 0) return [];
  assert.equal(output.endsWith('\0'), true, 'git log output must terminate every commit with NUL');
  return output.slice(0, -1).split('\0');
}

async function commitMessage(repo, env, message) {
  const commit = await procexec(
    [
      'git',
      '-c',
      'user.name=Asterism Test',
      '-c',
      'user.email=asterism@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--allow-empty',
      '--quiet',
      '--message',
      message,
    ],
    { cwd: repo, env },
  );
  assert.equal(commit.code, 0, `git commit failed: ${commit.stderr.toString('utf8')}`);
}

async function initHistoryRepo(prefix) {
  const repo = await mkdtemp(path.join(os.tmpdir(), prefix));
  const env = { PATH: process.env.PATH ?? '', HOME: repo };
  const init = await procexec(['git', 'init', '--quiet', '--initial-branch', 'main'], { cwd: repo, env });
  assert.equal(init.code, 0, `git init failed: ${init.stderr.toString('utf8')}`);
  return { repo, env };
}

test('history checker catches a synthetic non-conforming message beside a conforming control', () => {
  const failures = checkMessages(['feat(cli): add ast new', 'feat: add ast new']);

  assert.equal(failures.length, 1);
  assert.equal(failures[0].index, 1);
  assert.ok(failures[0].violations.some((violation) => violation.code === 'scope.required'));
});

test('history reader reports every offender across a synthetic multi-message log', async () => {
  const { repo, env } = await initHistoryRepo('asterism-commit-history-');
  const expectedMessages = [
    'fix(harness): Adds newest offender',
    'test(test): keep newer control',
    'refactor(core): keep middle control',
    'feat: reject middle offender',
    'docs(docs): keep older control',
    'chore(harness): keep oldest control',
    'docs(docs): documented oldest offender',
  ];

  for (const message of expectedMessages.toReversed()) {
    await commitMessage(repo, env, message);
  }

  const messages = await readHistoryMessages(repo, 'HEAD', env);
  const failures = checkMessages(messages);

  assert.deepEqual(messages, expectedMessages.map((message) => `${message}\n`));
  assert.deepEqual(
    failures.map(({ index, violations }) => ({
      index,
      codes: violations.map((violation) => violation.code),
    })),
    [
      { index: 0, codes: ['subject.lowercase'] },
      { index: 3, codes: ['scope.required'] },
      { index: 6, codes: ['subject.imperative'] },
    ],
  );
});
