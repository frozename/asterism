import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

import { formatLs } from '../src/cli/verbs/ls.js';
import { checkSchema } from '../src/core/schema-check.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AST_BIN = path.join(ROOT, 'bin', 'ast');
const FAKE_TMUX = path.join(ROOT, 'harness', 'fake-tmux', 'tmux');
const HOSTILE = JSON.parse(await readFile(path.join(ROOT, 'vectors', 'render', 'hostile-names.json'), 'utf8'));
const SESSION_SCHEMA = JSON.parse(await readFile(path.join(ROOT, 'schema', 'session-1.json'), 'utf8'));

async function scratch(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function runAst(args, { rows = [], env: overrides = {} } = {}) {
  const tmp = await scratch('ast-ls-');
  const emptyPath = await scratch('ast-ls-path-');
  const fakeRoot = path.join(tmp, 'fake-root');
  const sessionsDir = path.join(fakeRoot, 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  await Promise.all(
    rows.map((row, index) =>
      writeFile(path.join(sessionsDir, `${String(index).padStart(4, '0')}.json`), JSON.stringify(row)),
    ),
  );
  const env = {
    PATH: emptyPath,
    HOME: tmp,
    XDG_STATE_HOME: tmp,
    TERM: 'dumb',
    ASTERISM_TEST: '1',
    ASTERISM_FAKE_ROOT: fakeRoot,
    ...overrides,
  };

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [AST_BIN, 'ls', ...args], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr, tmp, fakeRoot, env };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      tmp,
      fakeRoot,
      env,
    };
  }
}

function syntheticRecord(id, sessionId, status, lastSeen) {
  return {
    id,
    adapter: 'fake',
    agent: { sessionId },
    observed: { status, waitingFor: status === 'waiting' ? 'input' : null, lastSeen },
    flags: { writeDisabled: true },
  };
}

function codePointsOf(text) {
  return [...text].map((char) => char.codePointAt(0));
}

function hitsAnyRange(codePoints, ranges) {
  return codePoints.some((point) => ranges.some(([lo, hi]) => point >= lo && point <= hi));
}

test('ast ls never invokes tmux while a PATH control proves the shim is executable', async () => {
  const tmp = await scratch('ast-ls-no-tmux-');
  const shimDir = path.join(tmp, 'bin');
  const fakeRoot = path.join(tmp, 'fake-root');
  const sessionsDir = path.join(fakeRoot, 'sessions');
  const fixturesDir = path.join(tmp, 'tmux-fixtures');
  const logPath = path.join(tmp, 'tmux.log');
  await mkdir(shimDir);
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(fixturesDir);
  await writeFile(path.join(fixturesDir, 'list-panes.out'), '');
  await writeFile(path.join(sessionsDir, '0000.json'), JSON.stringify({ id: 'fake-0001', status: 'idle' }));
  const wrapper = path.join(shimDir, 'tmux');
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_TMUX}" "$@"\n`);
  await chmod(wrapper, 0o755);
  const env = {
    PATH: shimDir,
    HOME: tmp,
    XDG_STATE_HOME: tmp,
    TERM: 'dumb',
    ASTERISM_TEST: '1',
    ASTERISM_FAKE_ROOT: fakeRoot,
    ASTERISM_FAKE_TMUX_LOG: logPath,
    ASTERISM_FAKE_TMUX_FIXTURES: fixturesDir,
  };

  const { stdout } = await execFileAsync(process.execPath, [AST_BIN, 'ls'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.match(stdout, /^1 session/);
  await assert.rejects(() => readFile(logPath));

  await execFileAsync('tmux', ['list-panes'], { env, encoding: 'utf8' });
  assert.equal((await readFile(logPath, 'utf8')).trim().split('\n').length, 1);
});

test('blocked-first order, singular header, waiting exit count, and cap are observable', async () => {
  const mixed = await runAst([], {
    rows: [
      { id: 'idle-one', status: 'idle' },
      { id: 'waiting-one', status: 'waiting', waitingFor: 'approval' },
      { id: 'busy-one', status: 'busy' },
    ],
  });
  assert.equal(mixed.code, 1);
  const mixedLines = mixed.stdout.trimEnd().split('\n');
  assert.equal(mixedLines[0], '3 sessions · 1 needs you');
  assert.ok(mixedLines[1].includes('waiting-one'));

  const idle = await runAst([], { rows: [{ id: 'idle-one', status: 'idle' }] });
  assert.equal(idle.code, 0);
  assert.equal(idle.stdout.split('\n')[0], '1 session · 0 need you');

  const capped = await runAst([], {
    rows: Array.from({ length: 130 }, (_, index) => ({ id: `waiting-${index}`, status: 'waiting' })),
  });
  assert.equal(capped.code, 125);
  assert.equal(capped.stdout.split('\n')[0], '130 sessions · 130 need you');
});

test('formatLs sorts deliberately shuffled records blocked first', () => {
  const output = formatLs([
    syntheticRecord('idle-id', 'idle-session', 'idle', 3),
    syntheticRecord('busy-id', 'busy-session', 'busy', 2),
    syntheticRecord('waiting-id', 'waiting-session', 'waiting', 1),
  ]);
  const lines = output.trimEnd().split('\n');
  assert.ok(lines[1].includes('waiting-session'));
  assert.ok(lines[2].includes('busy-session'));
  assert.ok(lines[3].includes('idle-session'));
});

test('json includes fake sessions only when the fake root is registered', async () => {
  const present = await runAst(['--json'], { rows: [{ id: 'fake-0001', status: 'idle' }] });
  assert.ok(JSON.parse(present.stdout).sessions.some((entry) => entry.adapter === 'fake'));

  const absent = await runAst(['--json'], {
    rows: [{ id: 'fake-0001', status: 'idle' }],
    env: { ASTERISM_FAKE_ROOT: undefined },
  });
  assert.equal(JSON.parse(absent.stdout).sessions.some((entry) => entry.adapter === 'fake'), false);
});

test('null status renders unknown and writes exactly one canary', async () => {
  const result = await runAst([], {
    rows: [
      { id: 'fake-0001', status: 'idle' },
      { id: 'fake-0002', status: null },
    ],
  });
  const unknownLine = result.stdout.split('\n').find((line) => line.includes('fake-0002'));
  const idleLine = result.stdout.split('\n').find((line) => line.includes('fake-0001'));
  assert.match(unknownLine, /^unknown\s/);
  assert.doesNotMatch(unknownLine, /^busy\s/);
  assert.match(idleLine, /^idle\s/);
  const canaries = await import('node:fs/promises').then(({ readdir }) => readdir(path.join(result.tmp, 'asterism', 'unknown')));
  assert.equal(canaries.length, 1);
});

test('every hostile session name is sanitized on each rendered table line', async () => {
  const result = await runAst([], {
    rows: HOSTILE.map((entry) => ({ id: entry.input, status: 'idle' })),
  });
  assert.equal(result.code, 0);
  const lines = result.stdout.trimEnd().split('\n');
  const ranges = HOSTILE.flatMap((entry) => entry.mustNotContain);
  for (const line of lines) assert.equal(hitsAnyRange(codePointsOf(line), ranges), false, JSON.stringify(line));
  const osc2 = HOSTILE.find((entry) => entry.id === 'osc2');
  assert.equal(hitsAnyRange(codePointsOf(osc2.input), osc2.mustNotContain), true);
});

test('json stdout and persisted seam index validate against the session schema', async () => {
  const jsonResult = await runAst(['--json'], { rows: [{ id: 'fake-0001', status: 'idle' }] });
  const document = JSON.parse(jsonResult.stdout);
  assert.equal(checkSchema(SESSION_SCHEMA, document).ok, true);
  const broken = structuredClone(document);
  delete broken.sessions[0].id;
  assert.equal(checkSchema(SESSION_SCHEMA, broken).ok, false);

  const tableResult = await runAst([], { rows: [{ id: 'fake-0001', status: 'idle' }] });
  const indexPath = path.join(tableResult.tmp, 'asterism', 'index.json');
  const indexInfo = await stat(indexPath);
  assert.equal(indexInfo.mode & 0o777, 0o600);
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  assert.equal(Number.isNaN(Date.parse(index.writtenAt)), false);
  assert.equal(checkSchema(SESSION_SCHEMA, index).ok, true);
});

test('watch iteration cap renders once with normal exit and SIGINT stops an uncapped watch at zero', async () => {
  const capped = await runAst(['--watch', '--watch-iterations', '1'], {
    rows: [{ id: 'waiting-one', status: 'waiting' }],
  });
  assert.equal(capped.code, 1);
  assert.equal(capped.stdout.match(/1 session · 1 needs you/g)?.length, 1);

  const tmp = await scratch('ast-ls-watch-');
  const emptyPath = await scratch('ast-ls-watch-path-');
  const fakeRoot = path.join(tmp, 'fake-root');
  await mkdir(path.join(fakeRoot, 'sessions'), { recursive: true });
  await writeFile(path.join(fakeRoot, 'sessions', '0000.json'), JSON.stringify({ id: 'watch-me', status: 'idle' }));
  const env = {
    PATH: emptyPath,
    HOME: tmp,
    XDG_STATE_HOME: tmp,
    TERM: 'dumb',
    ASTERISM_TEST: '1',
    ASTERISM_FAKE_ROOT: fakeRoot,
  };
  const child = spawn(process.execPath, [AST_BIN, 'ls', '--watch'], { cwd: ROOT, env });
  let stdout = '';
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('watch did not render before timeout'));
    }, 5000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.includes('watch-me')) child.kill('SIGINT');
    });
    child.once('error', reject);
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  assert.match(stdout, /watch-me/);
  assert.equal(code, 0);
});

test('ast ls completes within the CI diagnostic bound', async () => {
  const start = performance.now();
  const result = await runAst([], {
    rows: [
      { id: 'one', status: 'idle' },
      { id: 'two', status: 'busy' },
      { id: 'three', status: 'waiting' },
    ],
  });
  const elapsed = performance.now() - start;
  console.error(`ast ls elapsed ${Math.round(elapsed)} ms (budget 150, ci bound 400)`);
  assert.equal(result.code, 1);
  assert.ok(elapsed < 400, `elapsed ${elapsed}ms exceeded the 400ms CI bound`);
  if (process.env.ASTERISM_BENCH === '1') assert.ok(elapsed < 150, `elapsed ${elapsed}ms exceeded the 150ms budget`);
});
