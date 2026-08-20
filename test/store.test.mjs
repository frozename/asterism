import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

import { parseToml } from '../src/core/toml.js';
import {
  auditPermissions,
  checkAttentionStuck,
  checkCanaryUnknownFields,
  checkRetentionCounts,
  checkTargetsAreIds,
  DEFAULT_CONFIG_TOML,
  readArchive,
  readBindings,
  readConfig,
  readSessions,
  resolveConfigDir,
  resolveStateDir,
  RETENTION_DEFAULTS,
  writeJsonAtomic,
  writeTextAtomic,
} from '../src/io/store.js';

const execFileAsync = promisify(execFile);
const STORE_URL = new URL('../src/io/store.js', import.meta.url).href;
const DAY_MS = 24 * 60 * 60 * 1000;

async function tmpDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test('state readers return valid records and report corrupt entries', async () => {
  const stateDir = await tmpDir('ast-store-readers-');
  for (const [subdir, extension, reader] of [
    ['sessions', '.json', readSessions],
    ['archive', '.json', readArchive],
    ['bindings', '.bind', readBindings],
  ]) {
    const dir = path.join(stateDir, subdir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `good${extension}`), JSON.stringify({ id: 'ok' }));
    writeFileSync(path.join(dir, `bad${extension}`), '{ nope');

    const result = await reader(stateDir);
    assert.deepEqual(result.records, [{ file: `good${extension}`, record: { id: 'ok' } }]);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].file, `bad${extension}`);
    assert.ok(result.errors[0].reason.length > 0);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.records[0]), true);
    assert.equal(Object.isFrozen(result.errors[0]), true);
  }
});

test('state readers treat absent directories as empty', async () => {
  const stateDir = await tmpDir('ast-store-readers-empty-');
  assert.deepEqual(await readSessions(stateDir), { records: [], errors: [] });
  assert.deepEqual(await readArchive(stateDir), { records: [], errors: [] });
  assert.deepEqual(await readBindings(stateDir), { records: [], errors: [] });
});

test('state readers report non-object JSON instead of returning it', async () => {
  const stateDir = await tmpDir('ast-store-readers-shape-');
  for (const [subdir, extension, reader, value] of [
    ['sessions', '.json', readSessions, [1, 2]],
    ['archive', '.json', readArchive, null],
    ['bindings', '.bind', readBindings, 'x'],
  ]) {
    const dir = path.join(stateDir, subdir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `wrong${extension}`), JSON.stringify(value));
    const result = await reader(stateDir);
    assert.deepEqual(result.records, []);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].file, `wrong${extension}`);
  }
});

// Every scenario below that needs a real openStore/writeTextAtomic call
// against real files runs inside this ONE child process instead of one
// process per scenario. A fresh node process and a fresh openStore's 10
// mkdir+stat pairs are the dominant cost here (this worktree lives on an
// external volume), and the T4 mutants replay this whole file once per
// mutant -- three replays of nine separate spawns was slow enough to blow
// past bun's 5s per-test default. Each scenario still gets its own isolated
// HOME (or its own scratch dir); only the process and, where safe, the
// store handle are shared.
async function runMegaScript() {
  const scriptDir = await tmpDir('ast-store-mega-');
  const script = `
    import { openStore, auditPermissions, writeTextAtomic, writeJsonAtomic, StateVersionError, sweepRetention } from ${JSON.stringify(STORE_URL)};
    import { readdirSync, statSync, existsSync, writeFileSync, chmodSync, mkdirSync, utimesSync, readFileSync } from 'node:fs';
    import { mkdtemp } from 'node:fs/promises';
    import os from 'node:os';
    import path from 'node:path';

    async function tmp(prefix) {
      return mkdtemp(path.join(os.tmpdir(), prefix));
    }

    function walk(dir) {
      const out = [];
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = statSync(full);
        out.push({ path: full, mode: st.mode & 0o777, type: st.isDirectory() ? 'dir' : 'file' });
        if (st.isDirectory()) out.push(...walk(full));
      }
      return out;
    }

    const result = {};

    // ---- red3: the permissions walk, then the audit-clean/audit-dirty control, on the same tree ----
    {
      const home = await tmp('ast-store-red3-');
      process.umask(0o022);
      const store = await openStore({ env: { HOME: home, XDG_STATE_HOME: '' } });
      await store.ensureConfig();

      await store.writeSession('01ARZ3NDEKTSV4RRFFQ69G5FAV', { status: 'active' });
      await store.writeBinding('01ARZ3NDEKTSV4RRFFQ69G5FAV', { target: '%7' });
      await store.writeInboxItem('01ARZ3NDEKTSV4RRFFQ69G5FAV', 0, { text: 'hello' });
      await store.writeInboxDedupe('01ARZ3NDEKTSV4RRFFQ69G5FAV', { keys: [] });
      await store.writeIndex({ sessions: 1 });
      await store.appendUsage('probe invoked');
      await store.writeCanary({ adapter: 'x', key: 'y', sha: '${'a'.repeat(64)}', at: Date.now() });
      await store.writeDoctorLast({ ok: true });
      await store.writeBackup('config.toml', 'stub bytes');
      await store.appendHookError('hook broke');

      const entries = [...walk(store.stateDir), ...walk(store.configDir)];

      const cleanResult = await auditPermissions({ stateDir: store.stateDir });

      // openStore flipped this process's umask to 0o077 as its own chokepoint
      // discipline. A probe run inside the thing it measures inherits that
      // state and would read as clean by accident -- so the control resets
      // the umask to the caller's original 0o022 before planting the
      // offender, the same way a raw fs write from outside the store would
      // actually behave.
      process.umask(0o022);
      const offenderPath = path.join(store.stateDir, 'sessions', 'planted.json');
      writeFileSync(offenderPath, '{}');
      chmodSync(offenderPath, 0o644);
      const dirtyResult = await auditPermissions({ stateDir: store.stateDir });

      result.red3 = { entries, cleanResult, dirtyResult, offenderPath };
    }

    // ---- fstat/mode: writeTextAtomic/writeJsonAtomic directly, no openStore ----
    {
      const dir = await tmp('ast-store-fstat-');
      process.umask(0o022);

      const okPath = path.join(dir, 'ok.json');
      await writeJsonAtomic(okPath, { a: 1 });
      const okMode = statSync(okPath).mode & 0o777;

      const badPath = path.join(dir, 'bad-644.json');
      let bad644Threw = false;
      try {
        await writeTextAtomic(badPath, 'x', { mode: 0o644 });
      } catch {
        bad644Threw = true;
      }

      const bad640Path = path.join(dir, 'bad-640.json');
      let bad640Threw = false;
      try {
        await writeTextAtomic(bad640Path, 'x', { mode: 0o640 });
      } catch {
        bad640Threw = true;
      }

      const leftoverTmp = readdirSync(dir).filter((name) => name.includes('.tmp-'));
      result.fstatMode = {
        okMode,
        bad644Threw,
        bad640Threw,
        bad644Exists: existsSync(badPath),
        bad640Exists: existsSync(bad640Path),
        leftoverTmp,
      };
    }

    // ---- schema-version: absent / wrong-version / unparseable ----
    {
      const absentHome = await tmp('ast-store-schema-absent-');
      const store1 = await openStore({ env: { HOME: absentHome, XDG_STATE_HOME: '' } });
      const versionPath1 = path.join(store1.stateDir, 'schema-version');
      const content1 = readFileSync(versionPath1, 'utf8');
      const mode1 = statSync(versionPath1).mode & 0o777;

      const twoHome = await tmp('ast-store-schema-two-');
      const stateDir2 = path.join(twoHome, '.local', 'state', 'asterism');
      mkdirSync(stateDir2, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(stateDir2, 'schema-version'), '2\\n');
      let twoMessage = null;
      let twoIsStateVersionError = false;
      try {
        await openStore({ env: { HOME: twoHome, XDG_STATE_HOME: '' } });
      } catch (error) {
        twoMessage = error.message;
        twoIsStateVersionError = error instanceof StateVersionError;
      }

      const garbageHome = await tmp('ast-store-schema-garbage-');
      const stateDir3 = path.join(garbageHome, '.local', 'state', 'asterism');
      mkdirSync(stateDir3, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(stateDir3, 'schema-version'), 'bananas');
      let garbageMessage = null;
      let garbageIsStateVersionError = false;
      try {
        await openStore({ env: { HOME: garbageHome, XDG_STATE_HOME: '' } });
      } catch (error) {
        garbageMessage = error.message;
        garbageIsStateVersionError = error instanceof StateVersionError;
      }

      result.schemaVersion = { content1, mode1, twoMessage, twoIsStateVersionError, garbageMessage, garbageIsStateVersionError };
    }

    // ---- misc: writeBinding, appendUsage, appendHookError, canary ring, sweepRetention -- one fresh store shared by all five, since none of them touch a subdir another one needs ----
    {
      const home = await tmp('ast-store-misc-');
      const store = await openStore({ env: { HOME: home, XDG_STATE_HOME: '' } });

      const accepted = [];
      for (const target of ['%12', '$0', '@3']) {
        const ulid = 'ID' + target.replace(/[^A-Za-z0-9]/g, '');
        await store.writeBinding(ulid, { target });
        accepted.push(existsSync(path.join(store.stateDir, 'bindings', ulid + '.bind')));
      }
      const rejected = [];
      for (const [ulid, target] of [['badA', 'main:1.2'], ['badB', 'x%7']]) {
        let threw = false;
        try {
          await store.writeBinding(ulid, { target });
        } catch {
          threw = true;
        }
        rejected.push({ threw, exists: existsSync(path.join(store.stateDir, 'bindings', ulid + '.bind')) });
      }
      result.writeBinding = { accepted, rejected };

      await store.appendUsage('probe --static');
      let usageThrew = false;
      try {
        await store.appendUsage('line one\\nline two');
      } catch {
        usageThrew = true;
      }
      const usageContent = readFileSync(path.join(store.stateDir, 'usage.log'), 'utf8');
      result.appendUsage = { content: usageContent, threw: usageThrew };

      const hookLogPath = path.join(store.stateDir, 'hook-errors.log');
      await store.appendHookError('first failure');
      const sizeAfterOne = statSync(hookLogPath).size;
      writeFileSync(hookLogPath, 'x'.repeat(65536));
      await store.appendHookError('this should be dropped');
      const sizeAtCap = statSync(hookLogPath).size;
      result.appendHookError = { sizeAfterOne, sizeAtCap };

      const unknownDir = path.join(store.stateDir, 'unknown');
      const shas = [];
      for (let i = 0; i < 199; i += 1) {
        const sha = i.toString().padStart(4, '0').repeat(16).slice(0, 64);
        shas.push(sha);
        const filePath = path.join(unknownDir, sha + '.json');
        writeFileSync(filePath, JSON.stringify({ adapter: 'a', key: 'k' + i, sha, at: Date.now() }));
        const seconds = 1700000000 + i;
        utimesSync(filePath, seconds, seconds);
      }
      const oldestSha = shas[0];
      const sha200 = 'e'.repeat(64);
      await store.writeCanary({ adapter: 'a', key: 'k199', sha: sha200, at: Date.now() });
      const canaryBeforeCount = readdirSync(unknownDir).length;
      const sha201 = 'f'.repeat(64);
      await store.writeCanary({ adapter: 'a', key: 'k200', sha: sha201, at: Date.now() });
      const canaryAfterCount = readdirSync(unknownDir).length;
      const oldestGone = !readdirSync(unknownDir).includes(oldestSha + '.json');
      let badShaThrew = false;
      try {
        await store.writeCanary({ adapter: 'a', key: 'bad', sha: 'not-hex', at: Date.now() });
      } catch {
        badShaThrew = true;
      }
      result.canaryRing = { beforeCount: canaryBeforeCount, afterCount: canaryAfterCount, oldestGone, badShaThrew };

      const now = 1700000000000;
      const dayMs = 24 * 60 * 60 * 1000;
      const stateDir = store.stateDir;

      function writeSessionRaw(name, obj) {
        writeFileSync(path.join(stateDir, 'sessions', name), JSON.stringify(obj));
      }
      function writeArchiveRaw(name, obj) {
        writeFileSync(path.join(stateDir, 'archive', name), JSON.stringify(obj));
      }

      writeSessionRaw('dead-8d.json', { status: 'dead', statusUpdatedAt: now - 8 * dayMs });
      writeSessionRaw('dead-2d.json', { status: 'dead', statusUpdatedAt: now - 2 * dayMs });
      writeSessionRaw('busy-400d.json', { status: 'busy', statusUpdatedAt: now - 400 * dayMs });
      writeSessionRaw('no-updated.json', { status: 'dead' });

      writeArchiveRaw('old-91d.json', { statusUpdatedAt: now - 91 * dayMs });
      writeArchiveRaw('young-10d.json', { statusUpdatedAt: now - 10 * dayMs });

      const inboxSessionDir = path.join(stateDir, 'inbox', 'sess1');
      mkdirSync(inboxSessionDir, { recursive: true, mode: 0o700 });
      const oldInboxPath = path.join(inboxSessionDir, '0.json');
      const freshInboxPath = path.join(inboxSessionDir, '1.json');
      writeFileSync(oldInboxPath, '{}');
      writeFileSync(freshInboxPath, '{}');
      const oldSeconds = Math.floor((now - 31 * dayMs) / 1000);
      const freshSeconds = Math.floor((now - 5 * dayMs) / 1000);
      utimesSync(oldInboxPath, oldSeconds, oldSeconds);
      utimesSync(freshInboxPath, freshSeconds, freshSeconds);

      const handoffsPath = path.join(stateDir, 'handoffs', 'ancient.json');
      writeFileSync(handoffsPath, '{}');
      const ancientSeconds = Math.floor((now - 999 * dayMs) / 1000);
      utimesSync(handoffsPath, ancientSeconds, ancientSeconds);

      const slug = 'config.toml';
      for (let i = 0; i < 12; i += 1) {
        const ts = new Date(now - (11 - i) * dayMs).toISOString().replaceAll(':', '-');
        const tsDir = path.join(stateDir, 'backups', ts);
        mkdirSync(tsDir, { recursive: true, mode: 0o700 });
        writeFileSync(path.join(tsDir, slug), 'backup-' + i);
      }

      const counts = await sweepRetention(stateDir, { now, config: {} });

      result.sweepRetention = {
        counts,
        deadEightGone: !existsSync(path.join(stateDir, 'sessions', 'dead-8d.json')),
        deadEightArchived: existsSync(path.join(stateDir, 'archive', 'dead-8d.json')),
        deadTwoStays: existsSync(path.join(stateDir, 'sessions', 'dead-2d.json')),
        busyStays: existsSync(path.join(stateDir, 'sessions', 'busy-400d.json')),
        noUpdatedStays: existsSync(path.join(stateDir, 'sessions', 'no-updated.json')),
        old91Gone: !existsSync(path.join(stateDir, 'archive', 'old-91d.json')),
        young10Stays: existsSync(path.join(stateDir, 'archive', 'young-10d.json')),
        oldInboxGone: !existsSync(oldInboxPath),
        freshInboxStays: existsSync(freshInboxPath),
        handoffsSurvives: existsSync(handoffsPath),
        backupTsDirCount: readdirSync(path.join(stateDir, 'backups')).length,
      };
    }

    process.stdout.write(JSON.stringify(result));
  `;

  const scriptPath = path.join(scriptDir, 'child.mjs');
  await writeFile(scriptPath, script, 'utf8');
  const { stdout } = await execFileAsync(process.execPath, [scriptPath], {
    env: { PATH: process.env.PATH ?? '' },
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

const mega = await runMegaScript();

// ---- resolveStateDir / resolveConfigDir ----

test('resolveStateDir: unset XDG_STATE_HOME falls back to HOME/.local/state/asterism', () => {
  assert.equal(resolveStateDir({ HOME: '/home/x' }), path.join('/home/x', '.local', 'state', 'asterism'));
});

test('resolveStateDir: empty-string XDG_STATE_HOME also falls back (the measured live shape)', () => {
  assert.equal(resolveStateDir({ HOME: '/home/x', XDG_STATE_HOME: '' }), path.join('/home/x', '.local', 'state', 'asterism'));
});

test('resolveStateDir: non-empty XDG_STATE_HOME wins', () => {
  assert.equal(resolveStateDir({ HOME: '/home/x', XDG_STATE_HOME: '/custom/state' }), path.join('/custom/state', 'asterism'));
});

test('resolveStateDir: missing HOME on the fallback path throws', () => {
  assert.throws(() => resolveStateDir({}));
  assert.throws(() => resolveStateDir({ HOME: '' }));
});

test('resolveConfigDir: unset/empty XDG_CONFIG_HOME falls back to HOME/.config/asterism; set XDG wins; missing HOME throws', () => {
  assert.equal(resolveConfigDir({ HOME: '/home/x' }), path.join('/home/x', '.config', 'asterism'));
  assert.equal(resolveConfigDir({ HOME: '/home/x', XDG_CONFIG_HOME: '' }), path.join('/home/x', '.config', 'asterism'));
  assert.equal(resolveConfigDir({ HOME: '/home/x', XDG_CONFIG_HOME: '/custom/config' }), path.join('/custom/config', 'asterism'));
  assert.throws(() => resolveConfigDir({}));
});

// ---- RED 3: the permissions walk, under a real openStore, umask 022 ----

test('RED 3: openStore under umask 022 leaves every dir 0700 and every file 0600, with >= 12 entries walked', () => {
  const { entries } = mega.red3;
  assert.ok(entries.length >= 12, `expected >= 12 entries, got ${entries.length}`);
  for (const entry of entries) {
    if (entry.type === 'dir') {
      assert.equal(entry.mode, 0o700, `${entry.path} should be 0700, was ${entry.mode.toString(8)}`);
    } else {
      assert.equal(entry.mode, 0o600, `${entry.path} should be 0600, was ${entry.mode.toString(8)}`);
    }
  }
});

test('RED 3 control: auditPermissions passes on the clean tree, then fails on a raw-fs offender planted after openStore', () => {
  const { cleanResult, dirtyResult, offenderPath } = mega.red3;
  assert.equal(cleanResult.status, 'pass');
  assert.equal(dirtyResult.status, 'fail');
  assert.ok(dirtyResult.detail.includes(offenderPath), dirtyResult.detail);
});

// ---- fstat / mode discipline on writeTextAtomic / writeJsonAtomic directly ----

test('fstat/mode: default mode succeeds at 0600 under umask 022; explicit 0644 and 0640 are rejected and leave no temp file', () => {
  const result = mega.fstatMode;
  assert.equal(result.okMode, 0o600);
  assert.equal(result.bad644Threw, true);
  assert.equal(result.bad640Threw, true);
  assert.equal(result.bad644Exists, false);
  assert.equal(result.bad640Exists, false);
  assert.deepEqual(result.leftoverTmp, []);
});

// ---- schema-version ----

test('schema-version: absent creates "1\\n" at 0600; "2\\n" and "bananas" both refuse via StateVersionError naming the path and the remedy', () => {
  const result = mega.schemaVersion;

  assert.equal(result.content1, '1\n');
  assert.equal(result.mode1, 0o600);

  assert.equal(result.twoIsStateVersionError, true);
  assert.ok(result.twoMessage.includes('schema-version'), result.twoMessage);
  assert.ok(result.twoMessage.includes('ast state reset --backup'), result.twoMessage);

  assert.equal(result.garbageIsStateVersionError, true);
  assert.ok(result.garbageMessage.includes('schema-version'), result.garbageMessage);
  assert.ok(result.garbageMessage.includes('ast state reset --backup'), result.garbageMessage);
});

// ---- atomicity ----

test('atomicity: beforeRename sees the temp file in the target directory; a throwing hook leaves prior bytes and no temp file; success lands byte-exact content', async () => {
  const dir = await tmpDir('ast-store-atomic-');
  const targetPath = path.join(dir, 'target.txt');

  let seenTempDir = null;
  let seenTempInListing = null;
  await writeTextAtomic(targetPath, 'first\n', {
    beforeRename: async (tempPath) => {
      seenTempDir = path.dirname(tempPath) === path.dirname(targetPath);
      seenTempInListing = readdirSync(path.dirname(tempPath)).includes(path.basename(tempPath));
    },
  });
  assert.equal(seenTempDir, true);
  assert.equal(seenTempInListing, true);
  assert.equal(readFileSync(targetPath, 'utf8'), 'first\n');

  await assert.rejects(() =>
    writeTextAtomic(targetPath, 'second\n', {
      beforeRename: async () => {
        throw new Error('boom');
      },
    }),
  );
  assert.equal(readFileSync(targetPath, 'utf8'), 'first\n', 'prior bytes must survive a beforeRename throw');
  const leftoverTmp = readdirSync(dir).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftoverTmp, []);

  await writeTextAtomic(targetPath, 'third\n');
  assert.equal(readFileSync(targetPath, 'utf8'), 'third\n');

  const jsonPath = path.join(dir, 'target.json');
  await writeJsonAtomic(jsonPath, { a: 1, b: [1, 2] });
  assert.deepEqual(JSON.parse(readFileSync(jsonPath, 'utf8')), { a: 1, b: [1, 2] });
});

// ---- writeBinding target validation ----

test('writeBinding: %12, $0, @3 are accepted; "main:1.2" and "x%7" are rejected before any file exists', () => {
  const { accepted, rejected } = mega.writeBinding;
  assert.deepEqual(accepted, [true, true, true]);
  for (const entry of rejected) {
    assert.equal(entry.threw, true);
    assert.equal(entry.exists, false);
  }
});

// ---- appendUsage ----

test('appendUsage: a clean line lands; a line with an embedded newline throws', () => {
  const { content, threw } = mega.appendUsage;
  assert.equal(content, 'probe --static\n');
  assert.equal(threw, true);
});

// ---- appendHookError ----

test('appendHookError: below the cap it grows; at/over the 65536-byte cap the append is silently dropped and it never throws', () => {
  const { sizeAfterOne, sizeAtCap } = mega.appendHookError;
  assert.ok(sizeAfterOne > 0);
  assert.equal(sizeAtCap, 65536);
});

// ---- canary ring ----

test('canary ring: 200 seeded + a 201st caps the count at 200 and drops the mtime-oldest; a non-hex sha throws', () => {
  const { beforeCount, afterCount, oldestGone, badShaThrew } = mega.canaryRing;
  assert.equal(beforeCount, 200);
  assert.equal(afterCount, 200);
  assert.equal(oldestGone, true);
  assert.equal(badShaThrew, true);
});

// ---- sweepRetention ----

test('sweepRetention: status-gated archive/delete, inbox TTL, backup pruning, problems on unparseable, and handoffs are never swept', () => {
  const result = mega.sweepRetention;

  assert.deepEqual(result.counts, {
    sessionsArchived: 1,
    archivesDeleted: 1,
    inboxDeleted: 1,
    backupsPruned: 2,
    problems: 1,
  });
  assert.equal(result.deadEightGone, true);
  assert.equal(result.deadEightArchived, true);
  assert.equal(result.deadTwoStays, true);
  assert.equal(result.busyStays, true);
  assert.equal(result.noUpdatedStays, true);
  assert.equal(result.old91Gone, true);
  assert.equal(result.young10Stays, true);
  assert.equal(result.oldInboxGone, true);
  assert.equal(result.freshInboxStays, true);
  assert.equal(result.handoffsSurvives, true, 'handoffs/ must never be swept, even when older than everything else that was swept this run');
  assert.equal(result.backupTsDirCount, 10);
});

// ---- config ----

test('parseToml(DEFAULT_CONFIG_TOML) round-trips to the four retention values', () => {
  const parsed = parseToml(DEFAULT_CONFIG_TOML);
  assert.deepEqual(parsed, {
    retention: {
      sessions_archive_after_dead_days: RETENTION_DEFAULTS.sessionsArchiveAfterDeadDays,
      sessions_delete_after_days: RETENTION_DEFAULTS.sessionsDeleteAfterDays,
      inbox_ttl_days: RETENTION_DEFAULTS.inboxTtlDays,
      backups_keep_per_slug: RETENTION_DEFAULTS.backupsKeepPerSlug,
    },
  });
});

test('readConfig: absent file returns defaults; unparseable file throws', async () => {
  const absentHome = await tmpDir('ast-store-config-absent-');
  const defaults = await readConfig({ env: { HOME: absentHome, XDG_CONFIG_HOME: '' } });
  assert.deepEqual(defaults, parseToml(DEFAULT_CONFIG_TOML));

  const garbageHome = await tmpDir('ast-store-config-garbage-');
  const configDir = path.join(garbageHome, '.config', 'asterism');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, 'config.toml'), 'not = [valid');

  await assert.rejects(() => readConfig({ env: { HOME: garbageHome, XDG_CONFIG_HOME: '' } }));
});

// ---- doctor checks ----

test('auditPermissions: dir absent warns', async () => {
  const result = await auditPermissions({ stateDir: path.join(os.tmpdir(), 'ast-store-does-not-exist-xyz') });
  assert.equal(result.status, 'warn');
});

test('checkTargetsAreIds: a name-shaped target is flagged while a clean %3 binding passes; no bindings dir passes', async () => {
  const noneRoot = await tmpDir('ast-store-targets-none-');
  const noneResult = await checkTargetsAreIds({ stateDir: noneRoot });
  assert.equal(noneResult.status, 'pass');

  const cleanRoot = await tmpDir('ast-store-targets-clean-');
  mkdirSync(path.join(cleanRoot, 'bindings'), { recursive: true });
  writeFileSync(path.join(cleanRoot, 'bindings', 'a.bind'), JSON.stringify({ target: '%3' }));
  const cleanResult = await checkTargetsAreIds({ stateDir: cleanRoot });
  assert.equal(cleanResult.status, 'pass');

  const dirtyRoot = await tmpDir('ast-store-targets-dirty-');
  mkdirSync(path.join(dirtyRoot, 'bindings'), { recursive: true });
  writeFileSync(path.join(dirtyRoot, 'bindings', 'a.bind'), JSON.stringify({ target: '%3' }));
  writeFileSync(path.join(dirtyRoot, 'bindings', 'b.bind'), JSON.stringify({ target: 'main-window' }));
  const dirtyResult = await checkTargetsAreIds({ stateDir: dirtyRoot });
  assert.equal(dirtyResult.status, 'fail');
  assert.ok(dirtyResult.detail.includes('main-window'), dirtyResult.detail);
});

test('checkRetentionCounts: report-only pass carrying per-directory counts and bytes', async () => {
  const root = await tmpDir('ast-store-retentioncounts-');
  mkdirSync(path.join(root, 'sessions'), { recursive: true });
  writeFileSync(path.join(root, 'sessions', 'a.json'), '{}');

  const result = await checkRetentionCounts({ stateDir: root });
  assert.equal(result.status, 'pass');
  assert.ok(result.detail.includes('sessions:'), result.detail);
  assert.ok(result.detail.includes('handoffs:'), result.detail);
});

test('checkCanaryUnknownFields: at = now - 1h warns while at = now - 25h passes; an unparseable canary fails', async () => {
  const now = 1_700_000_000_000;

  const warnRoot = await tmpDir('ast-store-canary-warn-');
  mkdirSync(path.join(warnRoot, 'unknown'), { recursive: true });
  writeFileSync(path.join(warnRoot, 'unknown', `${'a'.repeat(64)}.json`), JSON.stringify({ adapter: 'x', key: 'y', at: now - DAY_MS / 24 }));
  const warnResult = await checkCanaryUnknownFields({ stateDir: warnRoot, now });
  assert.equal(warnResult.status, 'warn');

  const passRoot = await tmpDir('ast-store-canary-pass-');
  mkdirSync(path.join(passRoot, 'unknown'), { recursive: true });
  writeFileSync(path.join(passRoot, 'unknown', `${'b'.repeat(64)}.json`), JSON.stringify({ adapter: 'x', key: 'y', at: now - 25 * (DAY_MS / 24) }));
  const passResult = await checkCanaryUnknownFields({ stateDir: passRoot, now });
  assert.equal(passResult.status, 'pass');

  const failRoot = await tmpDir('ast-store-canary-fail-');
  mkdirSync(path.join(failRoot, 'unknown'), { recursive: true });
  writeFileSync(path.join(failRoot, 'unknown', `${'c'.repeat(64)}.json`), 'not json');
  const failResult = await checkCanaryUnknownFields({ stateDir: failRoot, now });
  assert.equal(failResult.status, 'fail');
});

test('checkAttentionStuck: flags.attentionStuck true fails while a plain session passes', async () => {
  const stuckRoot = await tmpDir('ast-store-stuck-');
  mkdirSync(path.join(stuckRoot, 'sessions'), { recursive: true });
  writeFileSync(path.join(stuckRoot, 'sessions', 'stuck.json'), JSON.stringify({ flags: { attentionStuck: true } }));
  const stuckResult = await checkAttentionStuck({ stateDir: stuckRoot });
  assert.equal(stuckResult.status, 'fail');

  const cleanRoot = await tmpDir('ast-store-notstuck-');
  mkdirSync(path.join(cleanRoot, 'sessions'), { recursive: true });
  writeFileSync(path.join(cleanRoot, 'sessions', 'fine.json'), JSON.stringify({ flags: { attentionStuck: false } }));
  const cleanResult = await checkAttentionStuck({ stateDir: cleanRoot });
  assert.equal(cleanResult.status, 'pass');
});
