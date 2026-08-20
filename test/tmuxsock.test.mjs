import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveServer } from '../src/io/tmuxsock.js';

function realpathMap(map) {
  return (candidate) => {
    if (!Object.hasOwn(map, candidate)) throw new Error(`realpath: no mapping for "${candidate}"`);
    return map[candidate];
  };
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
  const realpath = (p) => p;

  const allRungs = await resolveServer({
    env: { TMUX: '/s/tmux-env,1,0', TMUX_TMPDIR: '/custom' },
    uid: 501,
    probe,
    exists,
    realpath,
    listDir: () => ['weird-label-a', 'weird-label-b'],
  });
  assert.equal(allRungs.socketPath, '/s/tmux-env');

  const tmuxTmpdirOnly = await resolveServer({
    env: { TMUX_TMPDIR: '/custom' },
    uid: 501,
    probe,
    exists,
    realpath,
    listDir: (dir) => (dir === '/custom/tmux-501' ? ['weird-label-a', 'weird-label-b'] : []),
  });
  assert.equal(tmuxTmpdirOnly.socketPath, '/custom/tmux-501/weird-label-a');

  const tmpFallback = await resolveServer({
    env: {},
    uid: 501,
    probe,
    exists,
    realpath,
    listDir: (dir) => (dir === '/tmp/tmux-501' ? ['weird-label-a', 'weird-label-b'] : []),
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
    listDir: () => ['x'],
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
    exists: (candidate) => !candidate.endsWith('dead'),
    realpath: (p) => p,
    listDir: () => ['dead', 'live'],
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
    realpath: (p) => p,
    listDir: () => ['a', 'b'],
  });
  assert.deepEqual(allDead, { ok: false, reason: 'no-server' });

  const oneLive = await resolveServer({
    env: {},
    uid: 501,
    probe: async ({ socketPath }) => (socketPath.endsWith('b') ? { ok: true, socketPath, pid: 1, version: '3.7c' } : { ok: false }),
    exists: () => true,
    realpath: (p) => p,
    listDir: () => ['a', 'b'],
  });
  assert.equal(oneLive.ok, true);
  assert.ok(oneLive.socketPath.endsWith('b'));
});
