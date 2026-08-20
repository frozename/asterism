// L3 is a recorded deviation from the design, which wants these invariants
// unconditional: GitHub's ubuntu runner ships tmux 3.4, and the floor these
// invariants exercise is 3.7c. Every gated case below runs hard under
// ASTERISM_L3=1, and auto-runs when `tmux -V` on PATH parses at or above
// 3.7; otherwise it registers as todo naming both the 3.7c floor and the
// version actually found, never a silent skip.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { decideL3, l3Gate, withAttachedClient, withSandboxServer } from '../harness/l3.mjs';
import { parseListPanes } from '../src/core/tmuxparse.js';
import { execTmux } from '../src/io/tmuxexec.js';

const IS_BUN = typeof globalThis.Bun !== 'undefined';

function registerGated(name, fn) {
  if (gate.mode === 'run') {
    test(name, fn);
    return;
  }

  const message = `L3 gated: ${gate.reason}`;
  if (IS_BUN) {
    test.todo(name, () => {
      throw new Error(message);
    });
  } else {
    test(name, { todo: message }, () => {});
  }
}

const gate = await l3Gate({ PATH: process.env.PATH ?? '' });

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
