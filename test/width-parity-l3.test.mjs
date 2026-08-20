import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { l3Gate } from '../harness/l3.mjs';
import { displayWidth } from '../src/core/width.js';

// Gated: RED item 11 calls this unconditional, but GitHub's ubuntu runners ship
// tmux 3.4 while the floor this table needs is 3.7 (the reference machine runs
// 3.7c). A below-floor/unresolvable tmux or an environment where a hermetic
// server cannot boot registers as todo, naming the floor/version or boot
// error -- never a silent skip.
//
const execFileAsync = promisify(execFile);
const IS_BUN = typeof globalThis.Bun !== 'undefined';
const LABEL = `asterism-test-${process.pid}`;

const GATE = await l3Gate({ PATH: process.env.PATH ?? '', ASTERISM_L3: process.env.ASTERISM_L3 });

function gatedTest(name, fn) {
  if (GATE.mode === 'run') {
    test(name, fn);
  } else if (IS_BUN) {
    test.todo(name, () => {
      throw new Error(GATE.reason);
    });
  } else {
    test(name, { todo: GATE.reason }, () => {});
  }
}

// -- Gated parity cases: a real, sandboxed, private tmux server. --

const MEASURED_VALUES = ['漢字ab', '🔥x', 'éx', '🇧🇷', '👩‍👩‍👧'];

let recordedSocketPath = null;

function tmuxRun(args, home) {
  return execFileAsync('tmux', ['-u', '-L', LABEL, '-f', '/dev/null', ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: home, TERM: 'xterm-256color' },
  });
}

gatedTest(
  "tmux #{w:} parity: matches displayWidth for the five measured values, and the silent-zero control holds",
  async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'asterism-l3-home-'));

    try {
      await tmuxRun(['new-session', '-d', '-x', '80', '-y', '24', '-s', 'w'], home);

      for (const value of MEASURED_VALUES) {
        await tmuxRun(['set-option', '-g', '@v', value], home);
        const { stdout } = await tmuxRun(['display', '-p', '-t', 'w', '#{w:@v}'], home);
        const width = Number.parseInt(stdout.trim(), 10);

        // #{w:} takes a variable name, not a literal, and an undefined name
        // silently yields 0 rather than an error -- check the positive width
        // before trusting the comparison below, or a broken lookup passes silently.
        assert.ok(width > 0, `#{w:@v} returned a non-positive width for ${JSON.stringify(value)}`);
        assert.equal(width, displayWidth(value), `#{w:} mismatch for ${JSON.stringify(value)}`);
      }

      const { stdout: unsetOut } = await tmuxRun(
        ['display', '-p', '-t', 'w', '#{w:@asterism_unset_control}'],
        home,
      );
      assert.equal(unsetOut.trim(), '0', 'an undefined tmux variable name must silently yield 0');

      const { stdout: socketOut } = await tmuxRun(['display', '-p', '-t', 'w', '#{socket_path}'], home);
      // /tmp is a symlink to /private/tmp on darwin -- realpath the directory chain before any
      // comparison. Resolve the parent directory only, never the socket file itself: bun's
      // realpathSync throws EOPNOTSUPP on a Unix-domain socket special file on darwin, where
      // Node's does not -- a runtime quirk, not something this table needs the socket file for.
      const rawSocketPath = socketOut.trim();
      recordedSocketPath = path.join(realpathSync(path.dirname(rawSocketPath)), path.basename(rawSocketPath));
    } finally {
      try {
        await tmuxRun(['kill-server'], home);
      } catch {
        // kill-server can itself report an error even as it kills the server; tolerate it.
      }
      // kill-server leaves the socket FILE on disk -- measured: display -p answers
      // "no server running" while the file remains. Remove it explicitly.
      if (recordedSocketPath !== null) {
        rmSync(recordedSocketPath, { force: true });
      }
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  },
);

gatedTest('teardown held: the tmux socket file kill-server leaves behind is actually gone', () => {
  assert.ok(recordedSocketPath !== null, 'the parity test must run first and record a socket path');
  assert.equal(existsSync(recordedSocketPath), false);

  const socketDir = path.dirname(recordedSocketPath);
  const remaining = existsSync(socketDir) ? readdirSync(socketDir) : [];
  assert.equal(remaining.includes(path.basename(recordedSocketPath)), false);
});
