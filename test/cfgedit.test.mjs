import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as cfgedit from '../src/io/cfgedit.js';

const BLOCK_ID = 'tmux-conf';
const CONTENT = 'set -g status on\n';
const OPEN_LINE = `# >>> asterism managed block ${BLOCK_ID} >>>`;
const CLOSE_LINE = `# <<< asterism managed block ${BLOCK_ID} <<<`;

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'asterism-cfgedit-'));
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function recordingBackup() {
  const calls = [];
  const writeBackup = async (slug, bytes) => {
    const backupPath = path.join(os.tmpdir(), `asterism-cfgedit-backup-${slug}-${calls.length}`);
    calls.push({ slug, bytes: Buffer.from(bytes), backupPath });
    return backupPath;
  };
  return { writeBackup, calls };
}

function neverBackup() {
  return async () => {
    throw new Error('writeBackup should not be called');
  };
}

// ---- 1. round-trip byte-identity ----

test('round-trip: install then remove restores the original bytes exactly; remove is idempotent', async () => {
  const dir = await tempDir();
  const targetPath = path.join(dir, 'tmux.conf');
  const original = 'set -g mouse on\n';
  await writeFile(targetPath, original);

  const installPlan = await cfgedit.planManagedBlock({ targetPath, blockId: BLOCK_ID, content: CONTENT });
  assert.equal(installPlan.action, 'install');
  await cfgedit.apply(installPlan, { writeBackup: recordingBackup().writeBackup });

  const removePlan = await cfgedit.planManagedBlock({ targetPath, blockId: BLOCK_ID, content: null });
  assert.equal(removePlan.action, 'remove');
  await cfgedit.apply(removePlan, { writeBackup: recordingBackup().writeBackup });

  const after = await readFile(targetPath);
  assert.equal(sha256(after), sha256(Buffer.from(original)));

  const secondRemovePlan = await cfgedit.planManagedBlock({ targetPath, blockId: BLOCK_ID, content: null });
  assert.equal(secondRemovePlan.action, 'noop');
  const secondApply = await cfgedit.apply(secondRemovePlan, { writeBackup: neverBackup() });
  assert.deepEqual(secondApply, { ok: true, action: 'noop', backupPath: null });

  const stillOriginal = await readFile(targetPath);
  assert.equal(sha256(stillOriginal), sha256(Buffer.from(original)));
});

test('control: remove on a block-less file leaves the bytes byte-identical', async () => {
  const dir = await tempDir();
  const targetPath = path.join(dir, 'plain.conf');
  const original = 'no block here\n';
  await writeFile(targetPath, original);

  const plan = await cfgedit.planManagedBlock({ targetPath, blockId: BLOCK_ID, content: null });
  assert.equal(plan.action, 'noop');
  await cfgedit.apply(plan, { writeBackup: neverBackup() });

  assert.equal(sha256(await readFile(targetPath)), sha256(Buffer.from(original)));
});

// ---- 2. idempotent install ----

test('idempotent install: re-planning the same content is a noop that writes nothing', async () => {
  const dir = await tempDir();
  const targetPath = path.join(dir, 'tmux.conf');
  await writeFile(targetPath, 'base\n');

  const first = await cfgedit.planManagedBlock({ targetPath, blockId: BLOCK_ID, content: CONTENT });
  await cfgedit.apply(first, { writeBackup: recordingBackup().writeBackup });

  const bytesBefore = await readFile(targetPath);
  const mtimeBefore = (await stat(targetPath)).mtimeMs;

  const second = await cfgedit.planManagedBlock({ targetPath, blockId: BLOCK_ID, content: CONTENT });
  assert.equal(second.action, 'noop');
  await cfgedit.apply(second, { writeBackup: neverBackup() });

  const bytesAfter = await readFile(targetPath);
  assert.equal(sha256(bytesAfter), sha256(bytesBefore));
  assert.equal((await stat(targetPath)).mtimeMs, mtimeBefore);
});

// ---- 3. update in place ----

test('update in place: only the block body changes, surrounding bytes are byte-identical', async () => {
  const dir = await tempDir();
  const targetPath = path.join(dir, 'tmux.conf');
  await writeFile(targetPath, '# prelude\nset -g mouse on\n');

  const installed = await cfgedit.planManagedBlock({ targetPath, blockId: BLOCK_ID, content: CONTENT });
  await cfgedit.apply(installed, { writeBackup: recordingBackup().writeBackup });
  const afterInstall = (await readFile(targetPath)).toString('utf8');
  const prefix = afterInstall.slice(0, afterInstall.indexOf(OPEN_LINE));

  const updated = await cfgedit.planManagedBlock({ targetPath, blockId: BLOCK_ID, content: 'set -g status off\n' });
  assert.equal(updated.action, 'update');
  await cfgedit.apply(updated, { writeBackup: recordingBackup().writeBackup });

  const afterUpdate = (await readFile(targetPath)).toString('utf8');
  assert.equal(afterUpdate.slice(0, afterUpdate.indexOf(OPEN_LINE)), prefix);
  assert.ok(afterUpdate.includes('set -g status off\n'));
  assert.ok(!afterUpdate.includes('set -g status on\n'));
  assert.ok(afterUpdate.startsWith(`${prefix}${OPEN_LINE}\n`));
  assert.ok(afterUpdate.endsWith(`${CLOSE_LINE}\n`));
});

// ---- 4. missing-trailing-newline residual ----

test('missing-trailing-newline residual: install inserts one separator; remove leaves exactly that one newline behind', async () => {
  const dir = await tempDir();
  const targetPath = path.join(dir, 'tmux.conf');
  const original = 'set -g mouse on';
  await writeFile(targetPath, original);

  const installed = await cfgedit.planManagedBlock({ targetPath, blockId: BLOCK_ID, content: CONTENT });
  await cfgedit.apply(installed, { writeBackup: recordingBackup().writeBackup });

  const removed = await cfgedit.planManagedBlock({ targetPath, blockId: BLOCK_ID, content: null });
  await cfgedit.apply(removed, { writeBackup: recordingBackup().writeBackup });

  const finalText = (await readFile(targetPath)).toString('utf8');
  assert.equal(finalText, `${original}\n`);
});

// ---- 5. backup through the injection ----

test('backup: writeBackup receives the exact pre-write bytes; apply leaves no residue beside the target', async () => {
  const dir = await tempDir();
  const targetPath = path.join(dir, 'tmux.conf');
  const original = 'set -g mouse on\n';
  await writeFile(targetPath, original);

  const { writeBackup, calls } = recordingBackup();
  const plan = await cfgedit.planManagedBlock({ targetPath, blockId: BLOCK_ID, content: CONTENT });
  const result = await cfgedit.apply(plan, { writeBackup });

  assert.equal(calls.length, 1);
  assert.equal(sha256(calls[0].bytes), sha256(Buffer.from(original)));
  assert.equal(result.backupPath, calls[0].backupPath);

  assert.deepEqual(await readdir(dir), ['tmux.conf']);
});

// ---- 6. byte-diff-or-restore ----

test('byte-diff-or-restore: a corrupted write is detected, restored, and reported; no temp file remains', async () => {
  const dir = await tempDir();
  const targetPath = path.join(dir, 'tmux.conf');
  const original = 'set -g mouse on\n';
  await writeFile(targetPath, original);

  const plan = await cfgedit.planManagedBlock({ targetPath, blockId: BLOCK_ID, content: CONTENT });
  const { writeBackup } = recordingBackup();

  await assert.rejects(
    () =>
      cfgedit.apply(plan, {
        writeBackup,
        afterWrite: async (target) => writeFile(target, 'corrupted-by-test\n'),
      }),
    /cfgedit: post-write verify failed for .*; original bytes restored; backup at /,
  );

  assert.equal(sha256(await readFile(targetPath)), sha256(Buffer.from(original)));
  assert.deepEqual(await readdir(dir), ['tmux.conf']);
});

// ---- 7. held lock ----

test('held lock: refuses naming the holder pid; does not steal the lockfile', async () => {
  const dir = await tempDir();
  const targetPath = path.join(dir, 'tmux.conf');
  const lockPath = `${targetPath}.asterism.lock`;
  await writeFile(lockPath, JSON.stringify({ pid: 999999, at: '2026-01-01T00:00:00.000Z' }));

  const plan = await cfgedit.planManagedBlock({ targetPath, blockId: BLOCK_ID, content: CONTENT });

  await assert.rejects(
    () =>
      cfgedit.apply(plan, {
        writeBackup: neverBackup(),
        isPidAlive: () => true,
        lockTimeoutMs: 120,
      }),
    /cfgedit: lock held for .* by pid 999999/,
  );

  assert.ok((await readFile(lockPath, 'utf8')).includes('999999'));
});

// ---- 8. stale lock ----

test('stale lock: refuses naming the lockfile path; never unlinks it', async () => {
  const dir = await tempDir();
  const targetPath = path.join(dir, 'tmux.conf');
  const lockPath = `${targetPath}.asterism.lock`;
  await writeFile(lockPath, JSON.stringify({ pid: 999998, at: '2026-01-01T00:00:00.000Z' }));

  const plan = await cfgedit.planManagedBlock({ targetPath, blockId: BLOCK_ID, content: CONTENT });

  await assert.rejects(
    () => cfgedit.apply(plan, { writeBackup: neverBackup(), isPidAlive: () => false }),
    new RegExp(`cfgedit: stale lock ${lockPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  );

  assert.ok((await readFile(lockPath, 'utf8')).includes('999998'));
});

// ---- 9. race check ----

test('race check: a target mutated after planning is refused, bytes are untouched', async () => {
  const dir = await tempDir();
  const targetPath = path.join(dir, 'tmux.conf');
  await writeFile(targetPath, 'set -g mouse on\n');

  const plan = await cfgedit.planManagedBlock({ targetPath, blockId: BLOCK_ID, content: CONTENT });
  await writeFile(targetPath, 'set -g mouse on\nraced-in-between\n');

  await assert.rejects(
    () => cfgedit.apply(plan, { writeBackup: neverBackup() }),
    /cfgedit: .*changed since the plan was computed/,
  );

  assert.equal((await readFile(targetPath)).toString('utf8'), 'set -g mouse on\nraced-in-between\n');
});

// ---- 10. drift, report-only ----

test('drift: present, absent, and drifted all read correctly and never write', async () => {
  const dir = await tempDir();
  const targetPath = path.join(dir, 'tmux.conf');
  await writeFile(targetPath, 'set -g mouse on\n');

  const installed = await cfgedit.planManagedBlock({ targetPath, blockId: BLOCK_ID, content: CONTENT });
  await cfgedit.apply(installed, { writeBackup: recordingBackup().writeBackup });

  const present = await cfgedit.checkManagedBlockDrift({ targetPath, blockId: BLOCK_ID, content: CONTENT });
  assert.deepEqual(present, { status: 'pass' });

  const bytesBefore = await readFile(targetPath);
  const text = bytesBefore.toString('utf8');
  const driftedText = text.replace('set -g status on\n', 'set -g status off\n');
  await writeFile(targetPath, driftedText);

  const mtimeBeforeCheck = (await stat(targetPath)).mtimeMs;

  const drifted = await cfgedit.checkManagedBlockDrift({ targetPath, blockId: BLOCK_ID, content: CONTENT });
  assert.equal(drifted.status, 'warn');
  assert.match(drifted.detail, new RegExp(BLOCK_ID));

  const bytesAfter = await readFile(targetPath);
  assert.equal(sha256(bytesAfter), sha256(Buffer.from(driftedText)));
  assert.equal((await stat(targetPath)).mtimeMs, mtimeBeforeCheck);

  const absentTargetPath = path.join(dir, 'missing.conf');
  const absent = await cfgedit.checkManagedBlockDrift({ targetPath: absentTargetPath, blockId: BLOCK_ID, content: CONTENT });
  assert.equal(absent.status, 'warn');
  assert.match(absent.detail, /ast init/);

  const unreadable = await cfgedit.checkManagedBlockDrift({ targetPath: dir, blockId: BLOCK_ID, content: CONTENT });
  assert.equal(unreadable.status, 'unknown');
  assert.match(unreadable.detail, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

// ---- 11. file plans fail closed ----

test('file plans: planFile rejects marker-less content and a marker-less differing existing file; a marked file updates', async () => {
  const dir = await tempDir();
  const targetPath = path.join(dir, 'plugin.json');

  await assert.rejects(() => cfgedit.planFile({ targetPath, content: 'no marker here\n' }));

  await writeFile(targetPath, 'hand-authored, not ours\n');
  await assert.rejects(
    () => cfgedit.planFile({ targetPath, content: `${cfgedit.MANAGED_FILE_MARKER}\nv2\n` }),
    /refusing to overwrite/,
  );

  const ownedPath = path.join(dir, 'owned.json');
  await writeFile(ownedPath, `${cfgedit.MANAGED_FILE_MARKER}\nv1\n`);
  const updatePlan = await cfgedit.planFile({ targetPath: ownedPath, content: `${cfgedit.MANAGED_FILE_MARKER}\nv2\n` });
  assert.equal(updatePlan.action, 'update');
  await cfgedit.applyFilePlan(updatePlan, { writeBackup: recordingBackup().writeBackup });
  assert.equal((await readFile(ownedPath)).toString('utf8'), `${cfgedit.MANAGED_FILE_MARKER}\nv2\n`);
});

test('removeFilePlan: noops on absent, removes a marker-bearing file, refuses a marker-less one', async () => {
  const dir = await tempDir();

  const missingPath = path.join(dir, 'missing.json');
  assert.deepEqual(await cfgedit.removeFilePlan({ targetPath: missingPath }), { ok: true, action: 'noop' });

  const ownedPath = path.join(dir, 'owned.json');
  await writeFile(ownedPath, `${cfgedit.MANAGED_FILE_MARKER}\nv1\n`);
  assert.deepEqual(await cfgedit.removeFilePlan({ targetPath: ownedPath }), { ok: true, action: 'remove' });
  await assert.rejects(() => readFile(ownedPath));

  const foreignPath = path.join(dir, 'foreign.json');
  await writeFile(foreignPath, 'hand-authored, not ours\n');
  await assert.rejects(() => cfgedit.removeFilePlan({ targetPath: foreignPath }));
});

test('applyFilePlan mkdirs the target parent chain for a new owned file', async () => {
  const dir = await tempDir();
  const targetPath = path.join(dir, 'nested', 'deeper', 'plugin.json');
  const content = `${cfgedit.MANAGED_FILE_MARKER}\nv1\n`;

  const plan = await cfgedit.planFile({ targetPath, content });
  assert.equal(plan.action, 'install');
  await cfgedit.applyFilePlan(plan, { writeBackup: neverBackup() });

  assert.equal((await readFile(targetPath)).toString('utf8'), content);
});

// ---- 12. malformed markers ----

test('malformed markers: open without close throws on plan and remove, and diffs as drifted', async () => {
  const dir = await tempDir();
  const targetPath = path.join(dir, 'tmux.conf');
  await writeFile(targetPath, `${OPEN_LINE}\nunterminated body\n`);

  await assert.rejects(() => cfgedit.planManagedBlock({ targetPath, blockId: BLOCK_ID, content: CONTENT }));
  await assert.rejects(() => cfgedit.planManagedBlock({ targetPath, blockId: BLOCK_ID, content: null }));

  const bytes = await readFile(targetPath);
  assert.deepEqual(cfgedit.diffManagedBlock(bytes, { blockId: BLOCK_ID, content: CONTENT }), { status: 'drifted' });
});

test('malformed markers: a duplicate open marker throws on plan and remove, and diffs as drifted', async () => {
  const dir = await tempDir();
  const targetPath = path.join(dir, 'tmux.conf');
  await writeFile(targetPath, `${OPEN_LINE}\nbody one\n${OPEN_LINE}\nbody two\n${CLOSE_LINE}\n`);

  await assert.rejects(() => cfgedit.planManagedBlock({ targetPath, blockId: BLOCK_ID, content: CONTENT }));
  await assert.rejects(() => cfgedit.planManagedBlock({ targetPath, blockId: BLOCK_ID, content: null }));

  const bytes = await readFile(targetPath);
  assert.deepEqual(cfgedit.diffManagedBlock(bytes, { blockId: BLOCK_ID, content: CONTENT }), { status: 'drifted' });
});
