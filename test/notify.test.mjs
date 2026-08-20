import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildRegistry } from '../src/adapters/index.js';
import {
  DEFAULT_DEDUPE_TTL_MS,
  dedupeKey,
  run as runNotification,
} from '../src/hook/events/notification.js';
import { buildNotifyArgv, sendNotification } from '../src/io/notify.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_BUN = typeof globalThis.Bun !== 'undefined';
const registry = buildRegistry({ ASTERISM_FAKE_ROOT: path.join(ROOT, 'vectors', 'fake') });
const vendorId = [...registry.keys()].find((id) => id !== 'fake');
const vendor = registry.get(vendorId);
const notificationVector = JSON.parse(
  readFileSync(path.join(ROOT, 'vectors', vendorId, 'hook', 'notification.json'), 'utf8'),
);
const sessionVector = JSON.parse(
  readFileSync(path.join(ROOT, 'vectors', vendorId, 'hook', 'session-start.json'), 'utf8'),
);

async function recordingStore() {
  const stateDir = await mkdirTemp('asterism-notify-unit-');
  await mkdir(path.join(stateDir, 'inbox'), { recursive: true });
  const calls = { items: [], dedupe: [] };

  return {
    stateDir,
    calls,
    async writeInboxItem(sessionId, seq, item) {
      calls.items.push({ sessionId, seq, item });
      const dir = path.join(stateDir, 'inbox', sessionId);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `${seq}.json`), `${JSON.stringify(item)}\n`);
    },
    async writeInboxDedupe(sessionId, entries) {
      calls.dedupe.push({ sessionId, entries });
      const dir = path.join(stateDir, 'inbox', sessionId);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'dedupe.json'), `${JSON.stringify(entries)}\n`);
    },
  };
}

async function mkdirTemp(prefix) {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test('buildNotifyArgv keeps notification data in argv positions for every platform', () => {
  const title = `title ' "`;
  const body = `body $(id) \u001b[31m ' "`;
  const darwin = buildNotifyArgv({ platform: 'darwin', title, body });
  assert.deepEqual(darwin, {
    notifier: 'osascript',
    argv: [
      'osascript',
      '-e',
      'on run argv',
      '-e',
      'display notification (item 1 of argv) with title (item 2 of argv)',
      '-e',
      'end run',
      `body $(id) �[31m ' "`,
      title,
    ],
  });
  assert.equal(darwin.argv.slice(0, -2).some((value) => value.includes('$(id)')), false);

  const scriptShapedBody = buildNotifyArgv({ platform: 'darwin', title: 'x', body: 'on run argv' });
  assert.equal(scriptShapedBody.argv.at(-2), 'on run argv');
  assert.deepEqual(scriptShapedBody.argv.slice(1, 7), darwin.argv.slice(1, 7));

  assert.deepEqual(buildNotifyArgv({ platform: 'linux', title, body }), {
    notifier: 'notify-send',
    argv: ['notify-send', '--', title, `body $(id) �[31m ' "`],
  });
  assert.deepEqual(buildNotifyArgv({ platform: 'freebsd', title, body }), {
    notifier: 'none',
    argv: null,
  });
});

test('sendNotification fires once and swallows an execution failure', async () => {
  const calls = [];
  const firedRequest = {
    platform: 'linux',
    title: 'title',
    body: 'body',
    env: { PATH: '/bin' },
  };
  firedRequest.exec = async (argv, options) => {
    calls.push({ argv, options });
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false, truncated: false };
  };
  const fired = await sendNotification(firedRequest);
  assert.equal(fired.fired, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.env, { PATH: '/bin' });

  const failedRequest = {
    platform: 'linux',
    title: 'title',
    body: 'body',
    env: { PATH: '' },
  };
  failedRequest.exec = async () => {
    throw new Error('absent');
  };
  const failed = await sendNotification(failedRequest);
  assert.equal(failed.fired, false);
});

test('notification dedupe covers the row and spawn, expires, and folds freshness only when present', async () => {
  const store = await recordingStore();
  const execCalls = [];
  let clock = Date.parse('2026-08-20T10:00:00Z');
  const exec = async (argv) => {
    execCalls.push(argv);
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false, truncated: false };
  };
  const invoke = (payload) =>
    runNotification({
      adapter: vendor,
      adapterId: vendorId,
      payload,
      env: { PATH: '/bin' },
      store,
      exec,
      platform: 'linux',
      now: () => clock,
    });

  await invoke(notificationVector);
  assert.equal(store.calls.items.length, 1);
  assert.equal(execCalls.length, 1);

  clock += DEFAULT_DEDUPE_TTL_MS - 1;
  await invoke(notificationVector);
  assert.equal(store.calls.items.length, 1);
  assert.equal(execCalls.length, 1);

  clock = Date.parse('2026-08-20T10:00:00Z') + DEFAULT_DEDUPE_TTL_MS + 1;
  await invoke(notificationVector);
  assert.equal(store.calls.items.length, 2);
  assert.equal(execCalls.length, 2);

  await invoke({ ...notificationVector, message: `${notificationVector.message} changed` });
  assert.equal(store.calls.items.length, 3);
  assert.equal(execCalls.length, 3);

  const fresh = { ...notificationVector, statusUpdatedAt: '2026-08-19T10:00:00Z' };
  await invoke(fresh);
  assert.equal(store.calls.items.length, 4);
  assert.equal(execCalls.length, 4);
  await invoke(fresh);
  assert.equal(store.calls.items.length, 4);
  assert.equal(execCalls.length, 4);

  const withoutFreshness = dedupeKey({
    sessionId: notificationVector.session_id,
    message: notificationVector.message,
    statusUpdatedAt: null,
  });
  assert.equal(
    withoutFreshness,
    dedupeKey({
      sessionId: notificationVector.session_id,
      message: notificationVector.message,
      statusUpdatedAt: null,
    }),
  );
  assert.notEqual(
    withoutFreshness,
    dedupeKey({
      sessionId: notificationVector.session_id,
      message: notificationVector.message,
      statusUpdatedAt: fresh.statusUpdatedAt,
    }),
  );
});

test('hook payload parsers accept valid controls and reject unsafe or inconsistent inputs', () => {
  const envName = vendor.hooks.sessionIdEnvVar;
  const validEnv = {
    [envName]: sessionVector.session_id,
    TMUX_PANE: '%3',
    TMUX: '/tmp/example.sock,4242,0',
  };
  const parsedStart = vendor.hooks.parseSessionStart(sessionVector, validEnv);
  assert.equal(parsedStart.sessionId, sessionVector.session_id);
  assert.equal(parsedStart.source, 'startup');
  assert.deepEqual(parsedStart.tmux, { paneId: '%3', socketPath: '/tmp/example.sock', serverPid: 4242 });
  assert.equal(Object.isFrozen(parsedStart), true);
  assert.equal(Object.isFrozen(parsedStart.tmux), true);

  assert.equal(vendor.hooks.parseSessionStart({}, validEnv), null);
  assert.equal(vendor.hooks.parseSessionStart({ ...sessionVector, session_id: '../../etc' }, validEnv), null);
  assert.equal(vendor.hooks.parseSessionStart({ ...sessionVector, source: 'other' }, validEnv), null);
  assert.equal(
    vendor.hooks.parseSessionStart(sessionVector, { ...validEnv, [envName]: 'different-session' }),
    null,
  );
  assert.equal(vendor.hooks.parseSessionStart(sessionVector, { [envName]: sessionVector.session_id }).tmux, null);

  const parsedNotification = vendor.hooks.parseNotification({
    ...notificationVector,
    statusUpdatedAt: 123,
  });
  assert.equal(parsedNotification.sessionId, notificationVector.session_id);
  assert.equal(parsedNotification.statusUpdatedAt, '123');
  assert.equal(Object.isFrozen(parsedNotification), true);
  assert.equal(vendor.hooks.parseNotification({}), null);
  assert.equal(vendor.hooks.parseNotification({ ...notificationVector, session_id: '../../etc' }), null);
});

function resolveHookGolden(fixturesRoot, cell) {
  const rawPath = path.join(fixturesRoot, ...cell.split('/'), 'raw');
  if (existsSync(rawPath)) return { mode: 'real', rawPath };
  return { mode: 'todo', message: `missing: run \`ast fixture capture ${cell} --from <file>\`` };
}

function registerResolved(name, resolution, body) {
  if (resolution.mode === 'real') {
    test(name, body);
  } else if (IS_BUN) {
    test.todo(name, () => {
      throw new Error(resolution.message);
    });
  } else {
    test(name, { todo: resolution.message }, () => {});
  }
}

test('notification golden resolver changes from todo to real when raw exists', () => {
  const capture = vendor.captures.find((entry) => entry.cell.endsWith('hook/notification'));
  assert.ok(capture, 'notification hook capture recipe is missing');
  const root = mkdtempSync(path.join(os.tmpdir(), 'asterism-notify-golden-'));
  assert.equal(resolveHookGolden(root, capture.cell).mode, 'todo');
  const rawPath = path.join(root, ...capture.cell.split('/'), 'raw');
  mkdirSync(path.dirname(rawPath), { recursive: true });
  writeFileSync(rawPath, `${JSON.stringify(notificationVector)}\n`);
  assert.equal(resolveHookGolden(root, capture.cell).mode, 'real');
});

const hookCapture = vendor.captures.find((entry) => entry.cell.endsWith('hook/notification'));
if (hookCapture) {
  const resolution = resolveHookGolden(path.join(ROOT, 'fixtures'), hookCapture.cell);
  registerResolved(`notification hook golden ${hookCapture.cell}`, resolution, async () => {
    const payload = JSON.parse(readFileSync(resolution.rawPath, 'utf8'));
    const store = await recordingStore();
    const execCalls = [];
    const request = {
      adapter: vendor,
      adapterId: vendorId,
      payload,
      env: { PATH: '/bin' },
      store,
      platform: 'linux',
      now: () => Date.parse('2026-08-20T10:00:00Z'),
    };
    request.exec = async (argv) => {
      execCalls.push(argv);
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false, truncated: false };
    };
    await runNotification(request);
    assert.equal(store.calls.items.length, 1);
    assert.equal(execCalls.length, 1);
    const reason = typeof payload.waitingFor === 'string' && payload.waitingFor.length > 0 ? payload.waitingFor : 'waiting';
    assert.ok(execCalls[0].at(-1).startsWith(`${reason}: `));
  });
} else {
  test('notification hook golden capture is registered', () => {
    assert.fail('notification hook capture recipe is missing');
  });
}

test('recording store assigns consecutive row names as a control', async () => {
  const store = await recordingStore();
  await store.writeInboxItem('safe-session', 0, { ok: true });
  await store.writeInboxItem('safe-session', 1, { ok: true });
  assert.deepEqual((await readdir(path.join(store.stateDir, 'inbox', 'safe-session'))).sort(), ['0.json', '1.json']);
});
