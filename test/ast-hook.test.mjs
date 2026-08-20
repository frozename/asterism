import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildRegistry } from '../src/adapters/index.js';
import { STRONG_WITNESSES } from '../src/core/binding.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_BIN = path.join(ROOT, 'bin', 'ast-hook');
const registry = buildRegistry({ ASTERISM_FAKE_ROOT: path.join(ROOT, 'vectors', 'fake') });
const vendorId = [...registry.keys()].find((id) => id !== 'fake');
const vendor = registry.get(vendorId);
const sessionPayload = JSON.parse(
  await readFile(path.join(ROOT, 'vectors', vendorId, 'hook', 'session-start.json'), 'utf8'),
);
const notificationPayload = JSON.parse(
  await readFile(path.join(ROOT, 'vectors', vendorId, 'hook', 'notification.json'), 'utf8'),
);

async function makeHarness() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterism-hook-test-'));
  const home = path.join(root, 'home');
  const stateHome = path.join(root, 'state');
  const shimDir = path.join(root, 'bin');
  const emptyBin = path.join(root, 'empty-bin');
  const callLog = path.join(root, 'calls.log');
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(stateHome, { recursive: true }),
    mkdir(shimDir, { recursive: true }),
    mkdir(emptyBin, { recursive: true }),
  ]);

  const shim =
    '#!/bin/sh\n' +
    `printf 'CALL' >> "${callLog}"\n` +
    `for arg in "$@"; do printf '\\t%s' "$arg" >> "${callLog}"; done\n` +
    `printf '\\n' >> "${callLog}"\n`;
  for (const name of ['osascript', 'notify-send']) {
    const file = path.join(shimDir, name);
    await writeFile(file, shim);
    await chmod(file, 0o755);
  }
  const nodeExecutable = typeof globalThis.Bun === 'undefined' ? process.execPath : globalThis.Bun.which('node');
  assert.ok(nodeExecutable, 'the test runner could not locate node for the guest shebang');
  const nodeShim = path.join(shimDir, 'node');
  await writeFile(nodeShim, `#!/bin/sh\n"${nodeExecutable}" "$@"\n`);
  await chmod(nodeShim, 0o755);

  return {
    root,
    home,
    stateHome,
    stateDir: path.join(stateHome, 'asterism'),
    shimDir,
    emptyBin,
    callLog,
  };
}

async function runGuest(harness, event, payload, options = {}) {
  const adapterId = options.adapterId ?? vendorId;
  const useNode = options.useNode ?? false;
  const command = useNode ? process.execPath : HOOK_BIN;
  const args = useNode ? [HOOK_BIN, adapterId, event] : [adapterId, event];
  const env = {
    PATH: useNode ? harness.emptyBin : `${harness.shimDir}${path.delimiter}${path.dirname(process.execPath)}`,
    HOME: harness.home,
    TERM: 'dumb',
    XDG_STATE_HOME: harness.stateHome,
    ...options.env,
  };

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload));
  });
}

async function names(dir) {
  try {
    return await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function numberedRows(harness, sessionId) {
  return (await names(path.join(harness.stateDir, 'inbox', sessionId))).filter((name) => /^\d+\.json$/.test(name)).sort();
}

async function callLines(harness) {
  try {
    return (await readFile(harness.callLog, 'utf8')).trimEnd().split('\n').filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

test('session-start writes one strong binding and stays silent', async () => {
  const harness = await makeHarness();
  const result = await runGuest(harness, 'session-start', sessionPayload, {
    env: {
      [vendor.hooks.sessionIdEnvVar]: sessionPayload.session_id,
      TMUX_PANE: '%3',
      TMUX: `${harness.root}/sock,4242,0`,
    },
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.length, 0);
  assert.equal(result.stderr.length, 0);
  const bindings = (await names(path.join(harness.stateDir, 'bindings'))).filter((name) => name.endsWith('.bind'));
  assert.equal(bindings.length, 1);
  const record = JSON.parse(await readFile(path.join(harness.stateDir, 'bindings', bindings[0]), 'utf8'));
  assert.ok(STRONG_WITNESSES.includes(record.by));
  assert.equal(record.by, 'AgentAsserted');
  assert.equal(record.target, '%3');
  assert.equal(record.serverPid, 4242);
  assert.equal(record.source, 'startup');
  assert.equal(record.sessionId, sessionPayload.session_id);
  assert.equal((await names(harness.stateDir)).includes('hook-errors.log'), false);
});

test('session-start outside tmux writes no binding and stays silent', async () => {
  const harness = await makeHarness();
  const result = await runGuest(harness, 'session-start', sessionPayload, {
    env: { [vendor.hooks.sessionIdEnvVar]: sessionPayload.session_id },
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.length, 0);
  assert.equal(result.stderr.length, 0);
  assert.deepEqual((await names(path.join(harness.stateDir, 'bindings'))).filter((name) => name.endsWith('.bind')), []);
});

test('session-start rejects an environment id mismatch and logs without binding', async () => {
  const harness = await makeHarness();
  const result = await runGuest(harness, 'session-start', sessionPayload, {
    env: {
      [vendor.hooks.sessionIdEnvVar]: 'different-session',
      TMUX_PANE: '%3',
      TMUX: `${harness.root}/sock,4242,0`,
    },
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.length, 0);
  assert.equal(result.stderr.length, 0);
  assert.deepEqual((await names(path.join(harness.stateDir, 'bindings'))).filter((name) => name.endsWith('.bind')), []);
  assert.ok((await readFile(path.join(harness.stateDir, 'hook-errors.log'), 'utf8')).length > 0);
});

test('notification writes one row and passes hostile bytes as sanitized argv data', async () => {
  const harness = await makeHarness();
  const message = `hostile \u001b[31m $(id) ' "`;
  const payload = { ...notificationPayload, message };
  const result = await runGuest(harness, 'notification', payload);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.length, 0);
  assert.equal(result.stderr.length, 0);
  assert.deepEqual(await numberedRows(harness, payload.session_id), ['0.json']);
  const row = JSON.parse(await readFile(path.join(harness.stateDir, 'inbox', payload.session_id, '0.json'), 'utf8'));
  assert.equal(row.reason, 'permission');
  const calls = await callLines(harness);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('$(id)'));
  assert.ok(calls[0].includes("'"));
  assert.ok(calls[0].includes('"'));
  assert.equal(calls[0].includes('\u001b'), false);
  assert.ok(calls[0].includes('�'));
});

test('notification uses waiting when waitingFor is absent', async () => {
  const harness = await makeHarness();
  const { waitingFor: _waitingFor, ...payload } = notificationPayload;
  const result = await runGuest(harness, 'notification', payload);
  assert.equal(result.code, 0);
  const row = JSON.parse(await readFile(path.join(harness.stateDir, 'inbox', payload.session_id, '0.json'), 'utf8'));
  assert.equal(row.reason, 'waiting');
});

test('notification dedupes an identical event and permits a changed message', async () => {
  const harness = await makeHarness();
  await runGuest(harness, 'notification', notificationPayload);
  await runGuest(harness, 'notification', notificationPayload);
  assert.deepEqual(await numberedRows(harness, notificationPayload.session_id), ['0.json']);
  assert.equal((await callLines(harness)).length, 1);

  await runGuest(harness, 'notification', {
    ...notificationPayload,
    message: `${notificationPayload.message} changed`,
  });
  assert.deepEqual(await numberedRows(harness, notificationPayload.session_id), ['0.json', '1.json']);
  assert.equal((await callLines(harness)).length, 2);
});

test('malformed stdin exits zero, writes no event, and records an error', async () => {
  const harness = await makeHarness();
  const result = await runGuest(harness, 'notification', 'not json');
  assert.equal(result.code, 0);
  assert.equal(result.stdout.length, 0);
  assert.equal(result.stderr.length, 0);
  assert.deepEqual(await names(path.join(harness.stateDir, 'bindings')), []);
  assert.deepEqual(await names(path.join(harness.stateDir, 'inbox')), []);
  assert.ok((await readFile(path.join(harness.stateDir, 'hook-errors.log'), 'utf8')).length > 0);
});

test('oversized valid stdin is rejected at the byte cap with a truncation marker', async () => {
  const harness = await makeHarness();
  const payload = { ...notificationPayload, message: 'x'.repeat(70_000) };
  const result = await runGuest(harness, 'notification', payload);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.length, 0);
  assert.equal(result.stderr.length, 0);
  assert.deepEqual(await numberedRows(harness, payload.session_id), []);
  assert.match(await readFile(path.join(harness.stateDir, 'hook-errors.log'), 'utf8'), /\[truncated\]/);
});

test('unknown adapter and event exit zero silently without opening state', async () => {
  const unknownAdapterHarness = await makeHarness();
  const adapterResult = await runGuest(unknownAdapterHarness, 'notification', notificationPayload, {
    adapterId: 'no-such-adapter',
  });
  assert.equal(adapterResult.code, 0);
  assert.equal(adapterResult.stdout.length, 0);
  assert.equal(adapterResult.stderr.length, 0);
  assert.deepEqual(await names(unknownAdapterHarness.stateDir), []);

  const unknownEventHarness = await makeHarness();
  const eventResult = await runGuest(unknownEventHarness, 'no-such-event', notificationPayload);
  assert.equal(eventResult.code, 0);
  assert.equal(eventResult.stdout.length, 0);
  assert.equal(eventResult.stderr.length, 0);
  assert.deepEqual(await names(unknownEventHarness.stateDir), []);
});

test('an empty notifier PATH still preserves the inbox row', async () => {
  const harness = await makeHarness();
  const result = await runGuest(harness, 'notification', notificationPayload, { useNode: true });
  assert.equal(result.code, 0);
  assert.deepEqual(await numberedRows(harness, notificationPayload.session_id), ['0.json']);
  assert.deepEqual(await callLines(harness), []);
});
