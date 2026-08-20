import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseListClients, parseListPanes, parseServerInfo } from '../src/core/tmuxparse.js';
import { checkPipePaneOccupied, checkTmuxVersionFloor, isSupportedTmuxVersion, parseTmuxVersion } from '../src/core/tmuxver.js';
import { procexec } from '../src/io/procexec.js';

function panesRow(overrides = {}) {
  const base = {
    paneId: '%0',
    panePid: '1234',
    sessionId: '$0',
    windowId: '@0',
    paneDead: '0',
    paneMode: '',
    asterismSid: '',
  };
  return { ...base, ...overrides };
}

function rowText(row) {
  return [row.paneId, row.panePid, row.sessionId, row.windowId, row.paneDead, row.paneMode, row.asterismSid].join('|');
}

test('parseListPanes: a clean 7-field listing passes (control)', () => {
  const text = `${rowText(panesRow())}\n`;
  const result = parseListPanes(text);
  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.rows[0], panesRow());
});

test('parseListPanes: a 6-field row rejects the whole listing', () => {
  const text = `${rowText(panesRow())}\n%1|1235|$0|@0|0|\n`;
  const result = parseListPanes(text);
  assert.equal(result.ok, false);
  assert.match(result.reason, /6 field/);
});

test('parseListPanes: an 8-field row rejects the whole listing', () => {
  const text = `${rowText(panesRow())}\n%1|1235|$0|@0|0||extra|\n`;
  const result = parseListPanes(text);
  assert.equal(result.ok, false);
  assert.match(result.reason, /8 field/);
});

test('parseListPanes: pane id shape -- "x0" rejected, "%0" passes (control)', () => {
  const bad = parseListPanes(`${rowText(panesRow({ paneId: 'x0' }))}\n`);
  assert.equal(bad.ok, false);

  const good = parseListPanes(`${rowText(panesRow({ paneId: '%0' }))}\n`);
  assert.equal(good.ok, true);
});

test('parseListPanes: 2 rows with paneCount 1 is rejected with a reason naming both counts', () => {
  const text = `${rowText(panesRow({ paneId: '%0' }))}\n${rowText(panesRow({ paneId: '%1' }))}\n`;
  const result = parseListPanes(text, { paneCount: 1 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /2/);
  assert.match(result.reason, /1/);
});

test('parseListPanes: rows.length === paneCount passes', () => {
  const text = `${rowText(panesRow({ paneId: '%0' }))}\n${rowText(panesRow({ paneId: '%1' }))}\n`;
  const result = parseListPanes(text, { paneCount: 2 });
  assert.equal(result.ok, true);
});

test('parseListPanes: paneCount omitted skips the row-count check', () => {
  const text = `${rowText(panesRow({ paneId: '%0' }))}\n${rowText(panesRow({ paneId: '%1' }))}\n`;
  const result = parseListPanes(text);
  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 2);
});

test('parseListClients: a $-prefixed session id row passes', () => {
  const result = parseListClients('/dev/ttys004|$0|1755600000\n');
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows, [{ clientName: '/dev/ttys004', sessionId: '$0', clientActivity: '1755600000' }]);
});

test('parseListClients: a name-valued session id ("s0") is rejected', () => {
  const result = parseListClients('/dev/ttys004|s0|1755600000\n');
  assert.equal(result.ok, false);
});

test('parseListClients: wrong field count is rejected', () => {
  const result = parseListClients('/dev/ttys004|$0\n');
  assert.equal(result.ok, false);
});

test('parseServerInfo: a comma-carrying socket path parses right-to-left', () => {
  const result = parseServerInfo('a,b/x,4242,3.7c');
  assert.deepEqual(result, { ok: true, socketPath: 'a,b/x', pid: 4242, version: '3.7c' });
});

test('parseServerInfo: a non-numeric pid field is rejected', () => {
  const result = parseServerInfo('/tmp/tmux-501/default,notapid,3.7c');
  assert.equal(result.ok, false);
});

test('tmuxver: parseTmuxVersion parses major.minor for any version, and rejects garbage', () => {
  assert.deepEqual(parseTmuxVersion('tmux 3.7c'), { major: 3, minor: 7, raw: 'tmux 3.7c' });
  assert.deepEqual(parseTmuxVersion('tmux 3.4'), { major: 3, minor: 4, raw: 'tmux 3.4' });
  assert.deepEqual(parseTmuxVersion('tmux 4.0'), { major: 4, minor: 0, raw: 'tmux 4.0' });
  assert.equal(parseTmuxVersion('no version here'), null);
});

test('tmuxver: isSupportedTmuxVersion truth table', () => {
  assert.equal(isSupportedTmuxVersion(parseTmuxVersion('tmux 3.7c')), true);
  assert.equal(isSupportedTmuxVersion(parseTmuxVersion('tmux 3.8')), true);
  assert.equal(isSupportedTmuxVersion(parseTmuxVersion('tmux 4.0')), true);
  assert.equal(isSupportedTmuxVersion(parseTmuxVersion('tmux 3.4')), false);
  assert.equal(isSupportedTmuxVersion(parseTmuxVersion('tmux 2.9')), false);
  assert.equal(isSupportedTmuxVersion(null), false);
});

test('checkTmuxVersionFloor: pass, fail, and unknown paths over an injected execute', async () => {
  const pass = await checkTmuxVersionFloor({
    env: {},
    execute: async () => ({ code: 0, stdout: Buffer.from('tmux 3.7c\n'), stderr: Buffer.alloc(0) }),
  });
  assert.equal(pass.status, 'pass');

  const fail = await checkTmuxVersionFloor({
    env: {},
    execute: async () => ({ code: 0, stdout: Buffer.from('tmux 3.4\n'), stderr: Buffer.alloc(0) }),
  });
  assert.equal(fail.status, 'fail');
  assert.match(fail.detail, /3\.4/);
  assert.match(fail.detail, /3\.7/);

  const thrown = await checkTmuxVersionFloor({
    env: {},
    execute: async () => {
      throw new Error('spawn ENOENT');
    },
  });
  assert.equal(thrown.status, 'unknown');

  const garbage = await checkTmuxVersionFloor({
    env: {},
    execute: async () => ({ code: 0, stdout: Buffer.from('not a version\n'), stderr: Buffer.alloc(0) }),
  });
  assert.equal(garbage.status, 'unknown');
});

test('checkTmuxVersionFloor: real-spawn absent case reports unknown over a freshly empty PATH', async () => {
  const emptyDir = mkdtempSync(path.join(os.tmpdir(), 'asterism-empty-path-'));
  const env = { PATH: emptyDir };
  const execute = (args, opts) => procexec(['tmux', ...args], opts);

  const result = await checkTmuxVersionFloor({ env, execute: (args) => execute(args, { env }) });
  assert.equal(result.status, 'unknown');
});

test('checkPipePaneOccupied: a marked+piped row fails, naming the pane id', async () => {
  const result = await checkPipePaneOccupied({
    env: {},
    execute: async () => ({ code: 0, stdout: Buffer.from('%0|abc123|1\n'), stderr: Buffer.alloc(0) }),
  });
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /%0/);
});

test('checkPipePaneOccupied: (marked, unpiped) and (unmarked, piped) both pass (control)', async () => {
  const result = await checkPipePaneOccupied({
    env: {},
    execute: async () => ({ code: 0, stdout: Buffer.from('%0|abc123|0\n%1||1\n'), stderr: Buffer.alloc(0) }),
  });
  assert.equal(result.status, 'pass');
});

test('checkPipePaneOccupied: execute throwing reports unknown', async () => {
  const result = await checkPipePaneOccupied({
    env: {},
    execute: async () => {
      throw new Error('no server');
    },
  });
  assert.equal(result.status, 'unknown');
});
