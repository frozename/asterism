import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIM_DIR = path.join(ROOT, 'harness', 'fake-tmux');

async function runTmux(argv, envOverrides = {}) {
  const env = { PATH: `${SHIM_DIR}:${process.env.PATH}`, TERM: 'dumb', ...envOverrides };

  try {
    const { stdout, stderr } = await execFileAsync('tmux', argv, { cwd: ROOT, encoding: 'buffer', env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? Buffer.alloc(0),
      stderr: error.stderr ?? Buffer.alloc(0),
    };
  }
}

function tmpDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('argv is logged byte-exact, including -u, -L, and #-bearing format args, and the log has exactly one line', async () => {
  const logPath = path.join(tmpDir('fake-tmux-log-'), 'log.jsonl');
  const fixturesDir = tmpDir('fake-tmux-fixtures-');
  writeFileSync(path.join(fixturesDir, 'list-panes.out'), 'unused for this test');

  const argv = ['-u', '-L', 'asterism-test-x', 'list-panes', '-a', '-F', '#{pane_id}|#{pane_pid}'];
  const { code } = await runTmux(argv, {
    ASTERISM_FAKE_TMUX_LOG: logPath,
    ASTERISM_FAKE_TMUX_FIXTURES: fixturesDir,
  });
  assert.equal(code, 0);

  const lines = readFileSync(logPath, 'utf8').split('\n').filter((line) => line.length > 0);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]).argv, argv);
});

test('replay writes fixture bytes verbatim to stdout and exits 0, or the fixture .rc code when present', async () => {
  const logPath = path.join(tmpDir('fake-tmux-log-'), 'log.jsonl');
  const fixturesDir = tmpDir('fake-tmux-fixtures-');
  const env = { ASTERISM_FAKE_TMUX_LOG: logPath, ASTERISM_FAKE_TMUX_FIXTURES: fixturesDir };

  const outBytes = Buffer.from([0x68, 0x69, 0x09, 0xc3, 0xa9, 0xff, 0x0a]); // "hi\t" + e-acute + a raw 0xff byte + "\n"
  writeFileSync(path.join(fixturesDir, 'list-panes.out'), outBytes);

  const replayed = await runTmux(['list-panes'], env);
  assert.equal(replayed.code, 0);
  assert.ok(Buffer.compare(replayed.stdout, outBytes) === 0, 'stdout should be byte-identical to the fixture');

  writeFileSync(path.join(fixturesDir, 'list-panes.rc'), '1');
  const withRc = await runTmux(['list-panes'], env);
  assert.equal(withRc.code, 1);
  assert.ok(Buffer.compare(withRc.stdout, outBytes) === 0, 'stdout should still replay while a non-zero .rc is set');
});

test('fixture-key derivation skips leading global options and their values', async () => {
  const logPath = path.join(tmpDir('fake-tmux-log-'), 'log.jsonl');
  const fixturesDir = tmpDir('fake-tmux-fixtures-');
  const env = { ASTERISM_FAKE_TMUX_LOG: logPath, ASTERISM_FAKE_TMUX_FIXTURES: fixturesDir };

  writeFileSync(path.join(fixturesDir, 'display-message.out'), 'hi\n');

  const { code, stdout } = await runTmux(['-L', 'x', '-f', '/dev/null', 'display-message', '-p', 'hi'], env);
  assert.equal(code, 0);
  assert.equal(stdout.toString('utf8'), 'hi\n');
});

test('a missing fixture exits 127 with a message naming the derived key', async () => {
  const logPath = path.join(tmpDir('fake-tmux-log-'), 'log.jsonl');
  const fixturesDir = tmpDir('fake-tmux-fixtures-'); // deliberately empty
  const env = { ASTERISM_FAKE_TMUX_LOG: logPath, ASTERISM_FAKE_TMUX_FIXTURES: fixturesDir };

  const { code, stderr } = await runTmux(['kill-server'], env);
  assert.equal(code, 127);
  assert.equal(stderr.toString('utf8'), 'fake-tmux: no fixture for kill-server\n');
});

test('-V prints the version and exits 0 without requiring a fixtures directory', async () => {
  const logPath = path.join(tmpDir('fake-tmux-log-'), 'log.jsonl');

  const { code, stdout } = await runTmux(['-V'], { ASTERISM_FAKE_TMUX_LOG: logPath });
  assert.equal(code, 0);
  assert.equal(stdout.toString('utf8'), 'tmux 3.7c\n');

  const overridden = await runTmux(['-V'], { ASTERISM_FAKE_TMUX_LOG: logPath, ASTERISM_FAKE_TMUX_VERSION: '9.9z' });
  assert.equal(overridden.stdout.toString('utf8'), 'tmux 9.9z\n');
});

test('an unset log variable exits 70 with a message and produces no fixture output', async () => {
  const { code, stdout, stderr } = await runTmux(['-V'], {});
  assert.equal(code, 70);
  assert.equal(stderr.toString('utf8'), 'fake-tmux: ASTERISM_FAKE_TMUX_LOG is not set\n');
  assert.equal(stdout.length, 0);
});

test('control: logging is scoped to the configured path only, not to some other path', async () => {
  const logPath = path.join(tmpDir('fake-tmux-log-'), 'log.jsonl');
  const otherLogPath = path.join(tmpDir('fake-tmux-log-'), 'log.jsonl'); // a different temp dir, never passed as env

  const { code } = await runTmux(['-V'], { ASTERISM_FAKE_TMUX_LOG: logPath });
  assert.equal(code, 0);
  assert.ok(existsSync(logPath), 'the configured log path should have been written');
  assert.equal(existsSync(otherLogPath), false, 'an unrelated temp path must stay untouched');
});
