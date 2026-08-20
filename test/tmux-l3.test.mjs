// L3 is a recorded deviation from the design, which wants these invariants
// unconditional: GitHub's ubuntu runner ships tmux 3.4, and the floor these
// invariants exercise is 3.7c. Every gated case below runs hard under
// ASTERISM_L3=1, and auto-runs when `tmux -V` on PATH parses at or above
// 3.7 and a hermetic server can boot; otherwise it registers as todo naming
// the 3.7c floor/version or the boot error, never a silent skip.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { decideL3, l3Gate, withAttachedClient, withSandboxServer } from '../harness/l3.mjs';
import { parseListPanes } from '../src/core/tmuxparse.js';
import { execTmux, newWindow } from '../src/io/tmuxexec.js';

const IS_BUN = typeof globalThis.Bun !== 'undefined';

function registerGated(name, fn) {
  if (gate.mode === 'run') {
    test(name, fn);
    return;
  }

  const message = gate.reason;
  if (IS_BUN) {
    test.todo(name, () => {
      throw new Error(message);
    });
  } else {
    test(name, { todo: message }, () => {});
  }
}

const gate = await l3Gate({ PATH: process.env.PATH ?? '', ASTERISM_L3: process.env.ASTERISM_L3 });

test('decideL3: ASTERISM_L3=1 runs hard even with a null versionOutput', () => {
  assert.deepEqual(decideL3({ env: { ASTERISM_L3: '1' }, versionOutput: null }), { mode: 'run', hard: true });
});

test('decideL3: a parsed version at/above the floor runs', () => {
  assert.deepEqual(decideL3({ env: {}, versionOutput: 'tmux 3.7c' }), { mode: 'run' });
  assert.deepEqual(decideL3({ env: {}, versionOutput: 'tmux 3.8' }), { mode: 'run' });
});

test('decideL3: a parsed version below the floor is todo, naming both versions', () => {
  const result = decideL3({ env: {}, versionOutput: 'tmux 3.4' });
  assert.equal(result.mode, 'todo');
  assert.match(result.reason, /3\.7/);
  assert.match(result.reason, /3\.4/);
});

test('decideL3: malformed/absent output is todo, never run', () => {
  assert.equal(decideL3({ env: {}, versionOutput: null }).mode, 'todo');
  assert.equal(decideL3({ env: {}, versionOutput: 'garbage' }).mode, 'todo');
});

test('l3Gate: PATH set to a freshly empty directory reports todo', async () => {
  const emptyDir = mkdtempSync(path.join(os.tmpdir(), 'asterism-l3-empty-path-'));
  const result = await l3Gate({ PATH: emptyDir });
  assert.equal(result.mode, 'todo');
});

test('l3Gate: a boot failure is todo naming the error, while a bootable control runs', async () => {
  const failingCalls = [];
  const failingExecute = async (argv) => {
    failingCalls.push(argv);
    if (argv.includes('-V')) {
      return { code: 0, stdout: Buffer.from('tmux 3.7c\n'), stderr: Buffer.alloc(0) };
    }
    if (argv.includes('new-session')) {
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.from('probe socket permission denied\n') };
    }
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };

  const failed = await l3Gate({ PATH: '/fixture/failing-bin' }, { execute: failingExecute });
  assert.equal(failed.mode, 'todo');
  assert.match(failed.reason, /probe socket permission denied/);
  assert.equal(failingCalls.filter((argv) => argv.includes('new-session')).length, 1);
  assert.equal(failingCalls.filter((argv) => argv.includes('kill-server')).length, 1);
  const bootIndex = failingCalls.findIndex((argv) => argv.includes('new-session'));
  const bootArgv = failingCalls[bootIndex];
  const killArgv = failingCalls[bootIndex + 1];
  assert.deepEqual(bootArgv.slice(0, 3), ['tmux', '-u', '-L']);
  assert.match(bootArgv[3], /^asterism-test-/);
  assert.deepEqual(bootArgv.slice(4, 8), ['-f', '/dev/null', 'new-session', '-d']);
  assert.equal(killArgv.includes('kill-server'), true);
  assert.equal(killArgv[2], bootArgv[3]);

  const bootableCalls = [];
  const bootableExecute = async (argv) => {
    bootableCalls.push(argv);
    if (argv.includes('-V')) {
      return { code: 0, stdout: Buffer.from('tmux 3.7c\n'), stderr: Buffer.alloc(0) };
    }
    if (argv.includes('new-session')) {
      const label = argv[argv.indexOf('-L') + 1];
      return { code: 0, stdout: Buffer.from(`/tmp/tmux-fixture/${label}\n`), stderr: Buffer.alloc(0) };
    }
    if (argv.includes('display-message')) {
      return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('no server running\n') };
    }
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };

  assert.deepEqual(await l3Gate({ PATH: '/fixture/bootable-bin' }, { execute: bootableExecute }), { mode: 'run' });
  assert.equal(bootableCalls.filter((argv) => argv.includes('new-session')).length, 1);
  assert.equal(bootableCalls.filter((argv) => argv.includes('kill-server')).length, 1);
});

test('l3Gate: ASTERISM_L3=1 forces a hard run without invoking a failing boot probe', async () => {
  const calls = [];
  const execute = async (argv) => {
    calls.push(argv);
    if (argv.includes('-V')) {
      return { code: 0, stdout: Buffer.from('tmux 3.7c\n'), stderr: Buffer.alloc(0) };
    }
    throw new Error('boot must not be attempted');
  };

  assert.deepEqual(await l3Gate({ ASTERISM_L3: '1' }, { execute }), { mode: 'run', hard: true });
  assert.equal(calls.filter((argv) => argv.includes('-V')).length, 1);
  assert.equal(calls.filter((argv) => argv.includes('new-session')).length, 0);
});

test('l3Gate: two consecutive calls share one boot probe per process', async () => {
  const calls = [];
  const execute = async (argv) => {
    calls.push(argv);
    if (argv.includes('-V')) {
      return { code: 0, stdout: Buffer.from('tmux 3.7c\n'), stderr: Buffer.alloc(0) };
    }
    if (argv.includes('new-session')) {
      const label = argv[argv.indexOf('-L') + 1];
      return { code: 0, stdout: Buffer.from(`/tmp/tmux-fixture/${label}\n`), stderr: Buffer.alloc(0) };
    }
    if (argv.includes('display-message')) {
      return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('no server running\n') };
    }
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  const env = { PATH: '/fixture/cached-bin' };

  assert.deepEqual(await l3Gate(env, { execute }), { mode: 'run' });
  assert.deepEqual(await l3Gate(env, { execute }), { mode: 'run' });
  assert.equal(calls.filter((argv) => argv.includes('-V')).length, 2);
  assert.equal(calls.filter((argv) => argv.includes('new-session')).length, 1);
  assert.equal(calls.filter((argv) => argv.includes('kill-server')).length, 1);
});

test('l3Gate: a successful probe removes its residual socket and tolerates diagnostic stderr', async () => {
  const socketDir = mkdtempSync(path.join(os.tmpdir(), 'tmux-'));
  let socketPath = null;
  const execute = async (argv) => {
    if (argv.includes('-V')) {
      return { code: 0, stdout: Buffer.from('tmux 3.7c\n'), stderr: Buffer.alloc(0) };
    }
    if (argv.includes('new-session')) {
      const label = argv[argv.indexOf('-L') + 1];
      socketPath = path.join(socketDir, label);
      writeFileSync(socketPath, '');
      return {
        code: 0,
        stdout: Buffer.from(`${socketPath}\n`),
        stderr: Buffer.from('benign diagnostic\n'),
      };
    }
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };

  try {
    assert.deepEqual(await l3Gate({ PATH: '/fixture/cleanup-bin' }, { execute }), { mode: 'run' });
    assert.equal(socketPath === null, false);
    assert.equal(existsSync(socketPath), false);
  } finally {
    rmSync(socketDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('l3Gate: cache keys distinguish omitted and stringified child-environment values', async () => {
  const calls = [];
  const execute = async (argv) => {
    calls.push(argv);
    if (argv.includes('-V')) {
      return { code: 0, stdout: Buffer.from('tmux 3.7c\n'), stderr: Buffer.alloc(0) };
    }
    if (argv.includes('new-session')) {
      const label = argv[argv.indexOf('-L') + 1];
      return { code: 0, stdout: Buffer.from(`/tmp/tmux-fixture/${label}\n`), stderr: Buffer.alloc(0) };
    }
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  const omitted = { PATH: '/fixture/environment-bin', MARKER: undefined };
  const stringified = { PATH: '/fixture/environment-bin', MARKER: null };

  assert.deepEqual(await l3Gate(omitted, { execute }), { mode: 'run' });
  assert.deepEqual(await l3Gate(omitted, { execute }), { mode: 'run' });
  assert.deepEqual(await l3Gate(stringified, { execute }), { mode: 'run' });
  assert.equal(calls.filter((argv) => argv.includes('new-session')).length, 2);
});

test('l3Gate: ambiguous permission errors cannot confirm shutdown or unlink a live probe socket', async () => {
  const socketDir = mkdtempSync(path.join(os.tmpdir(), 'tmux-'));
  let socketPath = null;
  const execute = async (argv) => {
    if (argv.includes('-V')) {
      return { code: 0, stdout: Buffer.from('tmux 3.7c\n'), stderr: Buffer.alloc(0) };
    }
    if (argv.includes('new-session')) {
      const label = argv[argv.indexOf('-L') + 1];
      socketPath = path.join(socketDir, label);
      writeFileSync(socketPath, '');
      return { code: 0, stdout: Buffer.from(`${socketPath}\n`), stderr: Buffer.alloc(0) };
    }
    return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('permission denied\n') };
  };

  try {
    const result = await l3Gate({ PATH: '/fixture/ambiguous-cleanup-bin' }, { execute });
    assert.equal(result.mode, 'todo');
    assert.match(result.reason, /permission denied/);
    assert.equal(existsSync(socketPath), true, 'an ambiguously live socket must not be unlinked');
  } finally {
    rmSync(socketDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('l3Gate: a partial failed boot with a reported socket is cleaned before returning todo', async () => {
  const socketDir = mkdtempSync(path.join(os.tmpdir(), 'tmux-'));
  let socketPath = null;
  const execute = async (argv) => {
    if (argv.includes('-V')) {
      return { code: 0, stdout: Buffer.from('tmux 3.7c\n'), stderr: Buffer.alloc(0) };
    }
    if (argv.includes('new-session')) {
      const label = argv[argv.indexOf('-L') + 1];
      socketPath = path.join(socketDir, label);
      writeFileSync(socketPath, '');
      return { code: 1, stdout: Buffer.from(`${socketPath}\n`), stderr: Buffer.from('partial boot failed\n') };
    }
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };

  try {
    const result = await l3Gate({ PATH: '/fixture/partial-boot-bin' }, { execute });
    assert.equal(result.mode, 'todo');
    assert.match(result.reason, /partial boot failed/);
    assert.equal(existsSync(socketPath), false);
  } finally {
    rmSync(socketDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('l3Gate: a partial boot and socket-removal failure retain both error details', async () => {
  const socketDir = mkdtempSync(path.join(os.tmpdir(), 'tmux-'));
  const execute = async (argv) => {
    if (argv.includes('-V')) {
      return { code: 0, stdout: Buffer.from('tmux 3.7c\n'), stderr: Buffer.alloc(0) };
    }
    if (argv.includes('new-session')) {
      const label = argv[argv.indexOf('-L') + 1];
      const socketPath = path.join(socketDir, label);
      mkdirSync(socketPath);
      return { code: 1, stdout: Buffer.from(`${socketPath}\n`), stderr: Buffer.from('partial boot failed\n') };
    }
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };

  try {
    const result = await l3Gate({ PATH: '/fixture/removal-failure-bin' }, { execute });
    assert.equal(result.mode, 'todo');
    assert.match(result.reason, /partial boot failed/);
    assert.match(result.reason, /failed to remove probe socket/);
  } finally {
    rmSync(socketDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

registerGated(
  'tab byte-diff: without -u a tab in a -F row is replaced under LC_ALL=C; with -u it survives as a real tab byte',
  async () => {
    await withSandboxServer(async ({ raw }) => {
      const childEnv = { PATH: process.env.PATH ?? '', LC_ALL: 'C' };

      const withoutU = await raw(['list-panes', '-a', '-F', '#{pane_id}\t#{pane_pid}'], { env: childEnv });
      assert.equal(withoutU.stdout.includes(0x09), false, 'without -u the tab must have been mangled away');

      const withU = await raw(['-u', 'list-panes', '-a', '-F', '#{pane_id}\t#{pane_pid}'], { env: childEnv });
      assert.equal(withU.stdout.includes(0x09), true, 'with -u a literal tab byte must survive between fields');
    }, { env: { PATH: process.env.PATH ?? '' } });
  },
);

registerGated(
  'embedded newline + row count: a real newline inside a user option forges an extra list-panes row, and the row-count invariant rejects it',
  async () => {
    await withSandboxServer(async ({ raw, socketPath }) => {
      await raw(['set-option', '-p', '@asterism_probe', 'a\nb']);

      const displayed = await raw(['-u', 'display', '-p', '#{@asterism_probe}']);
      assert.equal(displayed.stdout.toString('utf8'), 'a\nb\n');

      const listed = await raw([
        '-u',
        'list-panes',
        '-a',
        '-F',
        '#{pane_id}|#{pane_pid}|#{session_id}|#{window_id}|#{pane_dead}|#{pane_mode}|#{@asterism_probe}',
      ]);
      const text = listed.stdout.toString('utf8');
      const lineCount = text.split('\n').filter((line) => line.length > 0).length;
      assert.equal(lineCount, 2, 'the embedded newline should have forged a second line for one pane');

      const parsed = parseListPanes(text, { paneCount: 1 });
      assert.equal(parsed.ok, false);
      assert.match(parsed.reason, /2/);
      assert.match(parsed.reason, /1/);
    }, { env: { PATH: process.env.PATH ?? '' } });
  },
);

registerGated('newWindow creates a pane id that list-panes reports in the sandbox server', async () => {
  const env = { PATH: process.env.PATH ?? '' };

  await withSandboxServer(async ({ socketPath }) => {
    const paneId = await newWindow({ cwd: process.cwd(), socketPath, env });
    const listed = await execTmux(['list-panes', '-a', '-F', '#{pane_id}'], { socketPath, env });
    const paneIds = listed.stdout
      .toString('utf8')
      .split('\n')
      .filter((line) => line.length > 0);

    assert.ok(paneIds.includes(paneId), `${paneId} should be reported by list-panes`);
  }, { env });
});

registerGated(
  'list-clients: #{client_session} answers a session name, never $-prefixed -- tmuxexec.listClients only accepts the $-prefixed #{session_id}',
  async () => {
    await withAttachedClient(async ({ raw, socketPath }) => {
      const rawResult = await raw(['list-clients', '-F', '#{client_name}|#{session_id}|#{client_session}']);
      const rows = rawResult.stdout
        .toString('utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => line.split('|'));

      assert.ok(rows.length > 0, 'expected at least one attached client');
      for (const [, sessionId, clientSession] of rows) {
        assert.match(sessionId, /^\$\d+$/);
        assert.doesNotMatch(clientSession, /^\$\d+$/);
      }

      const parsed = await execTmux(['list-clients', '-F', '#{client_name}|#{session_id}|#{client_activity}'], {
        socketPath,
        env: { PATH: process.env.PATH ?? '' },
      });
      assert.equal(parsed.code, 0);
    }, { env: { PATH: process.env.PATH ?? '' } });
  },
);
