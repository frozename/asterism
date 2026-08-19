import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { buildTmuxPlan, socketLabel } from '../src/capture/tmux.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AST_BIN = path.join(ROOT, 'bin', 'ast');

const REGISTRY_IDLE_CELL = 'claude/registry/idle'; // quarantine-exempt: real registered cell id this test captures end to end.
const REGISTRY_BUSY_CELL = 'claude/registry/busy'; // quarantine-exempt: real registered cell id this test captures end to end.
const HELP_CELL = 'claude/help'; // quarantine-exempt: real registered cell id asserted in `ast fixture list` output.
const ADAPTER_CONFIG_DIRNAME = '.claude'; // quarantine-exempt: real config dirname the file-source recipe under test reads.

async function runAst(args, { cwd, env }) {
  try {
    const { stdout, stderr } = await execFileAsync(AST_BIN, args, { cwd, env, encoding: 'utf8' });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function baseEnv(home) {
  return { PATH: process.env.PATH ?? '', HOME: home, TERM: 'dumb', LANG: 'C' };
}

function makeTempHome() {
  return mkdtempSync(path.join(os.tmpdir(), 'ast-fixture-home-'));
}

function makeCwdWithFixtures() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'ast-fixture-cwd-'));
  mkdirSync(path.join(cwd, 'fixtures'));
  return cwd;
}

test('captures a file-source cell, scrubs it, and writes raw + meta.json relative to cwd', async () => {
  const home = makeTempHome();
  const sessionsDir = path.join(home, ADAPTER_CONFIG_DIRNAME, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });

  const fakeUserPath = '/Users/fixture-fake-user/project/thing.js';
  const fakeUuid = '6f9619ff-8b86-d011-b42d-00c04fc964ff';
  writeFileSync(path.join(sessionsDir, '111.json'), JSON.stringify({ cwd: fakeUserPath, id: '111' }));
  writeFileSync(path.join(sessionsDir, '222.json'), JSON.stringify({ session: fakeUuid, id: '222' }));

  const cwd = makeCwdWithFixtures();
  const { code, stdout, stderr } = await runAst(
    ['fixture', 'capture', REGISTRY_IDLE_CELL, '--home', home, '--provoked-by', 'test fixture'],
    { cwd, env: baseEnv(home) },
  );

  assert.equal(code, 0, `expected exit 0, got ${code}; stderr: ${stderr}`);
  assert.match(
    stdout,
    new RegExp(`^captured ${REGISTRY_IDLE_CELL.replace(/\//g, '\\/')} \\(\\d+ bytes, \\d+ redactions\\) -> fixtures/${REGISTRY_IDLE_CELL.replace(/\//g, '\\/')}/\\n$`),
  );

  const cellDir = path.join(cwd, 'fixtures', ...REGISTRY_IDLE_CELL.split('/'));
  const raw = readFileSync(path.join(cellDir, 'raw'));
  const meta = JSON.parse(readFileSync(path.join(cellDir, 'meta.json'), 'utf8'));

  assert.equal(meta.cell, REGISTRY_IDLE_CELL);
  assert.equal(meta.sha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(meta.bytes, raw.length);
  assert.equal(meta.provokedBy, 'test fixture');
  assert.ok(Array.isArray(meta.redactions));
  assert.ok(meta.redactions.length > 0, 'expected the fake user path and uuid to be redacted');
  assert.deepEqual(meta.kills, []);

  for (const redaction of meta.redactions) {
    const span = raw.slice(redaction.offset, redaction.offset + redaction.length).toString('utf8');
    assert.equal(span.length, redaction.length, 'placeholder must preserve the original span length');
    assert.ok(span.startsWith(`<${redaction.kind}`), `placeholder should start with <${redaction.kind}: ${span}`);
  }

  assert.equal(raw.includes(fakeUserPath), false);
  assert.equal(raw.includes(fakeUuid), false);
});

test('an unknown cell exits 2', async () => {
  const home = makeTempHome();
  const cwd = makeCwdWithFixtures();

  const { code, stderr } = await runAst(['fixture', 'capture', 'nope/not-a-cell', '--home', home], {
    cwd,
    env: baseEnv(home),
  });

  assert.equal(code, 2);
  assert.match(stderr, /unknown cell/);
});

test('a grammar-invalid cell id exits 2', async () => {
  const home = makeTempHome();
  const cwd = makeCwdWithFixtures();

  const { code, stderr } = await runAst(['fixture', 'capture', 'Not_Valid', '--home', home], {
    cwd,
    env: baseEnv(home),
  });

  assert.equal(code, 2);
  assert.match(stderr, /invalid cell id/);
});

test('an empty capture exits 1', async () => {
  const home = makeTempHome();
  const cwd = makeCwdWithFixtures();

  const { code, stderr } = await runAst(['fixture', 'capture', REGISTRY_BUSY_CELL, '--home', home], {
    cwd,
    env: baseEnv(home),
  });

  assert.equal(code, 1);
  assert.match(stderr, /0 bytes/);
});

test('ast fixture list exits 0 and lists known cells', async () => {
  const home = makeTempHome();
  const cwd = makeCwdWithFixtures();

  const { code, stdout } = await runAst(['fixture', 'list'], { cwd, env: baseEnv(home) });

  assert.equal(code, 0);
  assert.ok(stdout.includes(HELP_CELL));
  assert.ok(stdout.includes('tmux/list-panes'));
});

test('tmux argv plans use a hermetic asterism- socket, -u, -f /dev/null, ending in kill-server', () => {
  for (const cell of ['tmux/list-panes', 'tmux/list-clients', 'tmux/capture-pane/plain', 'tmux/capture-pane/escapes']) {
    const plan = buildTmuxPlan(cell, 999);
    const label = socketLabel(999);

    assert.ok(label.startsWith('asterism-'), 'socket label must start with asterism-');
    assert.ok(plan[0].includes('-u'), 'new-session invocation should include -u');
    const dashFIndex = plan[0].indexOf('-f');
    assert.ok(dashFIndex !== -1 && plan[0][dashFIndex + 1] === '/dev/null', 'new-session should use -f /dev/null');
    assert.ok(plan[0].includes(label), 'every invocation should target the hermetic socket label');

    const last = plan[plan.length - 1];
    assert.equal(last[last.length - 1], 'kill-server', 'the plan must end with kill-server');
  }
});
