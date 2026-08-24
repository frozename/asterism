import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveServer } from '../src/io/tmuxsock.js';

function realpathMap(map) {
  return /** @type {typeof import('node:fs').realpathSync} */ ((candidate) => {
    if (!Object.hasOwn(map, candidate)) throw new Error(`realpath: no mapping for "${candidate}"`);
    return map[candidate];
  });
}

test('TMUX env wins: the encoded socket path is probed and the result carries serverPid + realpathed socketPath', async () => {
  const env = { TMUX: '/private/tmp/tmux-501/dev,12345,0' };
  const probe = async ({ socketPath }) => {
    assert.equal(socketPath, '/private/tmp/tmux-501/dev');
    return { ok: true, socketPath: '/private/tmp/tmux-501/dev', pid: 12345, version: '3.7c' };
  };

  const result = await resolveServer({
    env,
    uid: 501,
    probe,
    exists: () => true,
    realpath: realpathMap({ '/private/tmp/tmux-501/dev': '/private/tmp/tmux-501/dev' }),
    listDir: () => [],
  });

  assert.equal(result.ok, true);
  assert.equal(result.serverPid, 12345);
  assert.equal(result.socketPath, '/private/tmp/tmux-501/dev');
});

test('ladder order: TMUX beats TMUX_TMPDIR beats /tmp; multiple arbitrary labels are globbed, never assuming "default"', async () => {
  const probe = async ({ socketPath }) => ({ ok: true, socketPath, pid: 1, version: '3.7c' });
  const exists = () => true;
  const realpath = /** @type {typeof import('node:fs').realpathSync} */ ((p) => p);

  const allRungs = await resolveServer({
    env: { TMUX: '/s/tmux-env,1,0', TMUX_TMPDIR: '/custom' },
    uid: 501,
    probe,
    exists,
    realpath,
    listDir: /** @type {typeof import('node:fs').readdirSync} */ (() => ['weird-label-a', 'weird-label-b']),
  });
  assert.equal(allRungs.socketPath, '/s/tmux-env');

  const tmuxTmpdirOnly = await resolveServer({
    env: { TMUX_TMPDIR: '/custom' },
    uid: 501,
    probe,
    exists,
    realpath,
    listDir: /** @type {typeof import('node:fs').readdirSync} */ ((dir) => (dir === '/custom/tmux-501' ? ['weird-label-a', 'weird-label-b'] : [])),
  });
  assert.equal(tmuxTmpdirOnly.socketPath, '/custom/tmux-501/weird-label-a');

  const tmpFallback = await resolveServer({
    env: {},
    uid: 501,
    probe,
    exists,
    realpath,
    listDir: /** @type {typeof import('node:fs').readdirSync} */ ((dir) => (dir === '/tmp/tmux-501' ? ['weird-label-a', 'weird-label-b'] : [])),
  });
  assert.equal(tmpFallback.socketPath, '/tmp/tmux-501/weird-label-a');
});

test('realpath dedupe: a /tmp candidate and a /private/tmp probe reply resolve to the same canonical path', async () => {
  const probe = async () => ({ ok: true, socketPath: '/private/tmp/tmux-501/x', pid: 1, version: '3.7c' });

  const result = await resolveServer({
    env: {},
    uid: 501,
    probe,
    exists: () => true,
    realpath: realpathMap({
      '/tmp/tmux-501/x': '/private/tmp/tmux-501/x',
      '/private/tmp/tmux-501/x': '/private/tmp/tmux-501/x',
    }),
    listDir: /** @type {typeof import('node:fs').readdirSync} */ (() => ['x']),
  });

  assert.equal(result.ok, true);
  assert.equal(result.socketPath, '/private/tmp/tmux-501/x');
});

test('a dead socket file is skipped, the next rung is probed and succeeds (control: exists=true is probed)', async () => {
  const seen = [];
  const probe = async ({ socketPath }) => {
    seen.push(socketPath);
    return { ok: true, socketPath, pid: 1, version: '3.7c' };
  };

  const result = await resolveServer({
    env: {},
    uid: 501,
    probe,
    exists: (candidate) => !(/** @type {string} */ (candidate)).endsWith('dead'),
    realpath: /** @type {typeof import('node:fs').realpathSync} */ ((p) => p),
    listDir: /** @type {typeof import('node:fs').readdirSync} */ (() => ['dead', 'live']),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(seen, ['/tmp/tmux-501/live']);
});

test('probe rejection is skipped; every rung dead yields the distinct {ok:false, reason:"no-server"} value; one live probe among many flips it to ok:true (control)', async () => {
  const allDead = await resolveServer({
    env: {},
    uid: 501,
    probe: async () => ({ ok: false }),
    exists: () => true,
    realpath: /** @type {typeof import('node:fs').realpathSync} */ ((p) => p),
    listDir: /** @type {typeof import('node:fs').readdirSync} */ (() => ['a', 'b']),
  });
  assert.deepEqual(allDead, { ok: false, reason: 'no-server' });

  const oneLive = await resolveServer({
    env: {},
    uid: 501,
    probe: async ({ socketPath }) => (socketPath.endsWith('b') ? { ok: true, socketPath, pid: 1, version: '3.7c' } : { ok: false }),
    exists: () => true,
    realpath: /** @type {typeof import('node:fs').realpathSync} */ ((p) => p),
    listDir: /** @type {typeof import('node:fs').readdirSync} */ (() => ['a', 'b']),
  });
  assert.equal(oneLive.ok, true);
  assert.ok(oneLive.socketPath.endsWith('b'));
});

test('resolveServer records non-ENOENT probe failures and keeps a must-hit ENOENT candidate silent', async () => {
  const deniedNotes = [];
  let deniedProbes = 0;
  const denied = await resolveServer({
    env: { TMUX: '/s/denied,1,0' },
    uid: 501,
    exists: () => true,
    listDir: () => [],
    probe: async () => {
      deniedProbes += 1;
      throw new Error('permission denied');
    },
    notes: deniedNotes,
  });
  assert.equal(deniedProbes, 1);
  assert.deepEqual(denied, { ok: false, reason: 'no-server' });
  assert.deepEqual(deniedNotes, [
    { adapter: 'tmux', note: 'socket-probe-failed', detail: '/s/denied: permission denied' },
  ]);

  const missingNotes = [];
  let missingProbes = 0;
  const missing = Object.assign(new Error('candidate disappeared'), { code: 'ENOENT' });
  const absent = await resolveServer({
    env: { TMUX: '/s/missing,1,0' },
    uid: 501,
    exists: () => true,
    listDir: () => [],
    probe: async () => {
      missingProbes += 1;
      throw missing;
    },
    notes: missingNotes,
  });
  assert.equal(missingProbes, 1);
  assert.deepEqual(absent, { ok: false, reason: 'no-server' });
  assert.deepEqual(missingNotes, []);
});

test('resolveServer records both non-ENOENT realpath failures and keeps both ENOENT paths silent', async () => {
  const cases = [
    {
      label: 'candidate non-ENOENT',
      failedPath: '/s/candidate',
      error: new Error('permission denied'),
      expectedCalls: ['/s/candidate'],
      expectedNotes: [
        { adapter: 'tmux', note: 'socket-canonicalization-failed', detail: '/s/candidate: permission denied' },
      ],
    },
    {
      label: 'reported non-ENOENT',
      failedPath: '/s/reported',
      error: new Error('permission denied'),
      expectedCalls: ['/s/candidate', '/s/reported'],
      expectedNotes: [
        { adapter: 'tmux', note: 'socket-canonicalization-failed', detail: '/s/reported: permission denied' },
      ],
    },
    {
      label: 'candidate ENOENT',
      failedPath: '/s/candidate',
      error: Object.assign(new Error('candidate disappeared'), { code: 'ENOENT' }),
      expectedCalls: ['/s/candidate'],
      expectedNotes: [],
    },
    {
      label: 'reported ENOENT',
      failedPath: '/s/reported',
      error: Object.assign(new Error('candidate disappeared'), { code: 'ENOENT' }),
      expectedCalls: ['/s/candidate', '/s/reported'],
      expectedNotes: [],
    },
  ];

  for (const entry of cases) {
    const notes = [];
    const calls = [];
    const result = await resolveServer({
      env: { TMUX: '/s/candidate,1,0' },
      uid: 501,
      exists: () => true,
      listDir: () => [],
      probe: async () => ({ ok: true, socketPath: '/s/reported', pid: 1, version: '3.7c' }),
      realpath: /** @type {typeof import('node:fs').realpathSync} */ ((socketPath) => {
        calls.push(socketPath);
        if (socketPath === entry.failedPath) throw entry.error;
        return '/s/canonical';
      }),
      notes,
    });
    assert.deepEqual(result, { ok: false, reason: 'no-server' }, entry.label);
    assert.deepEqual(calls, entry.expectedCalls, entry.label);
    assert.deepEqual(notes, entry.expectedNotes, entry.label);
  }
});
