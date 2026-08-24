import { randomBytes } from 'node:crypto';
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { parseToml } from '../core/toml.js';

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TARGET_PATTERN = /^[$@%]\d+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SUPPORTED_SCHEMA_VERSION = '1';
const CANARY_RING_CAP = 200;
const HOOK_ERROR_LOG_CAP_BYTES = 65536;
const DAY_MS = 24 * 60 * 60 * 1000;
const STATE_SUBDIRS = Object.freeze(['sessions', 'bindings', 'inbox', 'archive', 'backups', 'doctor', 'unknown', 'handoffs']);

export function resolveStateDir(env) {
  if (typeof env.XDG_STATE_HOME === 'string' && env.XDG_STATE_HOME.length > 0) {
    return path.join(env.XDG_STATE_HOME, 'asterism');
  }
  if (typeof env.HOME !== 'string' || env.HOME.length === 0) {
    throw new Error('resolveStateDir: HOME is required when XDG_STATE_HOME is unset or empty');
  }
  return path.join(env.HOME, '.local', 'state', 'asterism');
}

export function resolveConfigDir(env) {
  if (typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.length > 0) {
    return path.join(env.XDG_CONFIG_HOME, 'asterism');
  }
  if (typeof env.HOME !== 'string' || env.HOME.length === 0) {
    throw new Error('resolveConfigDir: HOME is required when XDG_CONFIG_HOME is unset or empty');
  }
  return path.join(env.HOME, '.config', 'asterism');
}

export class StateVersionError extends Error {
  constructor(filePath, found) {
    super(
      `${filePath}: schema version "${found}" is not supported (supported: ${SUPPORTED_SCHEMA_VERSION}) -- run \`ast state reset --backup\``,
    );
    this.name = 'StateVersionError';
    this.path = filePath;
  }
}

function assertSafeName(name, label) {
  if (typeof name !== 'string' || !SAFE_NAME.test(name) || name.includes('..')) {
    throw new Error(`${label}: "${name}" is not a safe name`);
  }
}

// Early-return form on purpose: every owner-only mode check outside
// writeTextAtomic's own fstat guard routes through here, so there is exactly
// one place spelling out "reject if group/other bits are set".
function assertOwnerOnly(mode, atPath) {
  if ((mode & 0o077) === 0) return;
  throw new Error(`${atPath}: has group/other bits set (mode ${(mode & 0o777).toString(8)})`);
}

// The single atomic-write implementation site. writeJsonAtomic and every
// typed writer on the store handle delegate here -- a temp file in the
// target's own directory, fstat-verified before a byte is written, fsynced,
// renamed, with the containing directory fsynced after the rename.
export async function writeTextAtomic(targetPath, bytes, { mode = 0o600, beforeRename } = {}) {
  const tempPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.tmp-${randomBytes(6).toString('hex')}`);

  const handle = await open(tempPath, 'wx', mode);
  let handleOpen = true;

  try {
    const st = await handle.stat();
    if ((st.mode & 0o077) !== 0) {
      throw new Error(`writeTextAtomic: ${tempPath} was created with group/other bits set (mode ${(st.mode & 0o777).toString(8)})`);
    }

    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handleOpen = false;

    if (beforeRename) await beforeRename(tempPath);

    await rename(tempPath, targetPath);

    const dirHandle = await open(path.dirname(targetPath), 'r');
    await dirHandle.sync();
    await dirHandle.close();
  } catch (error) {
    if (handleOpen) await handle.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

export function writeJsonAtomic(targetPath, value, options = {}) {
  return writeTextAtomic(targetPath, `${JSON.stringify(value, null, 2)}\n`, options);
}

function assertLayoutDocument(doc, label) {
  if (doc?.version !== 1) throw new Error(`${label}: version must be 1`);
  if (!Array.isArray(doc.entries)) throw new Error(`${label}: entries must be an array`);
  for (const entry of doc.entries) {
    if (typeof entry?.cwd !== 'string' || !path.isAbsolute(entry.cwd)) {
      throw new Error(`${label}: entry cwd must be an absolute path`);
    }
  }
}

export async function readLayout(stateDir) {
  const layoutPath = path.join(stateDir, 'layout.json');
  try {
    return JSON.parse(await readFile(layoutPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureOwnerOnlyDir(dirPath) {
  await mkdir(dirPath, { recursive: true, mode: 0o700 });
  const info = await stat(dirPath);
  assertOwnerOnly(info.mode, dirPath);
}

async function ensureSchemaVersion(stateDir) {
  const versionPath = path.join(stateDir, 'schema-version');

  let content;
  try {
    content = await readFile(versionPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeTextAtomic(versionPath, '1\n');
    return;
  }

  if (content.trim() !== SUPPORTED_SCHEMA_VERSION) {
    throw new StateVersionError(versionPath, content.trim());
  }
}

async function safeReaddir(dirPath, options) {
  try {
    return await readdir(dirPath, options);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsedMs = Date.parse(value);
    if (!Number.isNaN(parsedMs)) return parsedMs;
  }
  return null;
}

async function enforceCanaryRing(unknownDir) {
  const names = (await safeReaddir(unknownDir)).filter((name) => name.endsWith('.json'));
  if (names.length <= CANARY_RING_CAP) return;

  const withStats = await Promise.all(
    names.map(async (name) => {
      const filePath = path.join(unknownDir, name);
      const info = await stat(filePath);
      return { name, filePath, mtimeMs: info.mtimeMs };
    }),
  );

  withStats.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const excess = withStats.length - CANARY_RING_CAP;
  for (let index = 0; index < excess; index += 1) {
    await unlink(withStats[index].filePath);
  }
}

export async function openStore({ env }) {
  process.umask(0o077);

  const stateDir = resolveStateDir(env);
  const configDir = resolveConfigDir(env);

  await ensureOwnerOnlyDir(stateDir);
  await ensureOwnerOnlyDir(configDir);
  for (const subdir of STATE_SUBDIRS) {
    await ensureOwnerOnlyDir(path.join(stateDir, subdir));
  }

  await ensureSchemaVersion(stateDir);

  const handle = {
    stateDir,
    configDir,

    async writeSession(ulid, record) {
      assertSafeName(ulid, 'writeSession');
      await writeJsonAtomic(path.join(stateDir, 'sessions', `${ulid}.json`), record);
    },

    async archiveSession(ulid, record, { beforeRemove } = {}) {
      assertSafeName(ulid, 'archiveSession');
      const sourcePath = path.join(stateDir, 'sessions', `${ulid}.json`);
      const archivePath = path.join(stateDir, 'archive', `${ulid}.json`);
      const bytes = `${JSON.stringify(record, null, 2)}\n`;

      // The durable archive copy lands first. A crash before source removal
      // therefore leaves two readable copies, which is the safe failure side.
      await writeTextAtomic(archivePath, bytes);
      if (beforeRemove) await beforeRemove(archivePath);
      if ((await readFile(archivePath, 'utf8')) !== bytes) {
        throw new Error(`archiveSession: archive verification failed for ${ulid}`);
      }
      await unlink(sourcePath);
    },

    async writeBinding(ulid, binding) {
      assertSafeName(ulid, 'writeBinding');
      if (typeof binding?.target !== 'string' || !TARGET_PATTERN.test(binding.target)) {
        throw new Error(`writeBinding: binding.target "${binding?.target}" is not a valid pane/window/session id`);
      }
      await writeJsonAtomic(path.join(stateDir, 'bindings', `${ulid}.bind`), binding);
    },

    async writeInboxItem(ulid, seq, item) {
      assertSafeName(ulid, 'writeInboxItem');
      if (!Number.isInteger(seq) || seq < 0) {
        throw new Error(`writeInboxItem: seq "${seq}" must be a non-negative integer`);
      }
      const sessionDir = path.join(stateDir, 'inbox', ulid);
      await ensureOwnerOnlyDir(sessionDir);
      await writeJsonAtomic(path.join(sessionDir, `${seq}.json`), item);
    },

    async writeInboxDedupe(ulid, entries) {
      assertSafeName(ulid, 'writeInboxDedupe');
      const sessionDir = path.join(stateDir, 'inbox', ulid);
      await ensureOwnerOnlyDir(sessionDir);
      await writeJsonAtomic(path.join(sessionDir, 'dedupe.json'), entries);
    },

    async writeIndex(payload, { now = Date.now() } = {}) {
      await writeJsonAtomic(path.join(stateDir, 'index.json'), { ...payload, writtenAt: new Date(now).toISOString() });
    },

    async writeLayout(doc, { force = false } = {}) {
      assertLayoutDocument(doc, 'writeLayout');
      const layoutPath = path.join(stateDir, 'layout.json');
      let priorBytes = null;
      try {
        priorBytes = await readFile(layoutPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (priorBytes !== null) {
        const priorDoc = JSON.parse(priorBytes.toString('utf8'));
        assertLayoutDocument(priorDoc, 'writeLayout existing layout');
        if (!force && doc.entries.length < priorDoc.entries.length) {
          throw new Error(
            `writeLayout: refusing to replace ${priorDoc.entries.length} entries with ${doc.entries.length}`,
          );
        }
      }
      if (priorBytes !== null) await handle.writeBackup('layout.json', priorBytes);
      await writeJsonAtomic(layoutPath, doc);
    },

    async appendUsage(line) {
      if (typeof line !== 'string' || line.includes('\n') || line.includes('\r')) {
        throw new Error('appendUsage: line must not contain a newline or carriage return');
      }
      const usagePath = path.join(stateDir, 'usage.log');
      await appendFile(usagePath, `${line}\n`, { mode: 0o600 });
      const info = await lstat(usagePath);
      assertOwnerOnly(info.mode, usagePath);
    },

    async writeCanary({ adapter, key, sha, at }) {
      if (typeof sha !== 'string' || !SHA256_HEX.test(sha)) {
        throw new Error(`writeCanary: sha "${sha}" must be 64 lowercase hex characters`);
      }
      const unknownDir = path.join(stateDir, 'unknown');
      await writeJsonAtomic(path.join(unknownDir, `${sha}.json`), { adapter, key, sha, at });
      await enforceCanaryRing(unknownDir);
    },

    async writeDoctorLast(obj) {
      await writeJsonAtomic(path.join(stateDir, 'doctor', 'last.json'), obj);
    },

    async writeBackup(slug, bytes, { now = Date.now() } = {}) {
      assertSafeName(slug, 'writeBackup');
      const ts = new Date(now).toISOString().replaceAll(':', '-');
      const tsDir = path.join(stateDir, 'backups', ts);
      await ensureOwnerOnlyDir(tsDir);
      const targetPath = path.join(tsDir, slug);
      await writeTextAtomic(targetPath, bytes);
      return targetPath;
    },

    async appendHookError(line) {
      try {
        const errorLogPath = path.join(stateDir, 'hook-errors.log');
        let currentSize = 0;
        try {
          currentSize = (await stat(errorLogPath)).size;
        } catch (error) {
          if (error.code !== 'ENOENT') return;
        }
        if (currentSize >= HOOK_ERROR_LOG_CAP_BYTES) return;
        await appendFile(errorLogPath, `${line}\n`, { mode: 0o600 });
      } catch {
        // appendHookError is the guest hook binary's error path -- it must never throw.
      }
    },

    async ensureConfig() {
      const configPath = path.join(configDir, 'config.toml');

      let exists = true;
      try {
        await stat(configPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        exists = false;
      }

      if (!exists) {
        await writeTextAtomic(configPath, DEFAULT_CONFIG_TOML, { mode: 0o600 });
      }

      const text = await readFile(configPath, 'utf8');
      try {
        return Object.freeze(parseToml(text));
      } catch (error) {
        throw new Error(`ensureConfig: ${configPath} is unparseable: ${error.message}`);
      }
    },
  };

  return Object.freeze(handle);
}

export const RETENTION_DEFAULTS = Object.freeze({
  sessionsArchiveAfterDeadDays: 7,
  sessionsDeleteAfterDays: 90,
  inboxTtlDays: 30,
  backupsKeepPerSlug: 10,
});

export const DEFAULT_CONFIG_TOML = `[retention]
sessions_archive_after_dead_days = 7
sessions_delete_after_days = 90
inbox_ttl_days = 30
backups_keep_per_slug = 10
`;

export async function readConfig({ env }) {
  const configPath = path.join(resolveConfigDir(env), 'config.toml');

  let text;
  try {
    text = await readFile(configPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return parseToml(DEFAULT_CONFIG_TOML);
  }

  try {
    return parseToml(text);
  } catch (error) {
    throw new Error(`readConfig: ${configPath} is unparseable: ${error.message}`);
  }
}

function retentionDays(config, key, fallback) {
  const value = config?.retention?.[key];
  return typeof value === 'number' ? value : fallback;
}

export async function sweepRetention(stateDir, { now, config = {} } = {}) {
  const archiveAfterMs = retentionDays(config, 'sessions_archive_after_dead_days', RETENTION_DEFAULTS.sessionsArchiveAfterDeadDays) * DAY_MS;
  const deleteAfterMs = retentionDays(config, 'sessions_delete_after_days', RETENTION_DEFAULTS.sessionsDeleteAfterDays) * DAY_MS;
  const inboxTtlMs = retentionDays(config, 'inbox_ttl_days', RETENTION_DEFAULTS.inboxTtlDays) * DAY_MS;
  const backupsKeepPerSlug = retentionDays(config, 'backups_keep_per_slug', RETENTION_DEFAULTS.backupsKeepPerSlug);

  const sessionsDir = path.join(stateDir, 'sessions');
  const archiveDir = path.join(stateDir, 'archive');
  const inboxDir = path.join(stateDir, 'inbox');
  const backupsDir = path.join(stateDir, 'backups');

  let sessionsArchived = 0;
  let archivesDeleted = 0;
  let inboxDeleted = 0;
  let backupsPruned = 0;
  let problems = 0;

  for (const name of await safeReaddir(sessionsDir)) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(sessionsDir, name);
    const record = await readJsonSafe(filePath);
    if (record === null) {
      problems += 1;
      continue;
    }
    if (record.observed?.status !== 'dead') continue;

    const updatedAtMs = parseTimestamp(record.observed?.lastSeen);
    if (updatedAtMs === null) {
      problems += 1;
      continue;
    }
    if (now - updatedAtMs >= archiveAfterMs) {
      await rename(filePath, path.join(archiveDir, name));
      sessionsArchived += 1;
    }
  }

  for (const name of await safeReaddir(archiveDir)) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(archiveDir, name);
    const record = await readJsonSafe(filePath);
    if (record === null) {
      problems += 1;
      continue;
    }
    const updatedAtMs = parseTimestamp(record.observed?.lastSeen);
    if (updatedAtMs === null) {
      problems += 1;
      continue;
    }
    if (now - updatedAtMs >= deleteAfterMs) {
      await unlink(filePath);
      archivesDeleted += 1;
    }
  }

  for (const sessionId of await safeReaddir(inboxDir)) {
    const sessionDir = path.join(inboxDir, sessionId);
    const entries = await safeReaddir(sessionDir);
    let remaining = entries.length;

    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const filePath = path.join(sessionDir, name);
      let stats;
      try {
        stats = await stat(filePath);
      } catch {
        // A vanished entry still consumes this bounded scan slot before moving to the next candidate.
        remaining -= 1;
        continue;
      }
      if (now - stats.mtimeMs >= inboxTtlMs) {
        await unlink(filePath);
        inboxDeleted += 1;
        remaining -= 1;
      }
    }

    if (entries.length > 0 && remaining === 0) {
      await rmdir(sessionDir).catch(() => {});
    }
  }

  const tsDirsBySlug = new Map();
  for (const tsName of await safeReaddir(backupsDir)) {
    const tsDir = path.join(backupsDir, tsName);
    for (const slug of await safeReaddir(tsDir)) {
      if (!tsDirsBySlug.has(slug)) tsDirsBySlug.set(slug, []);
      tsDirsBySlug.get(slug).push(tsName);
    }
  }
  for (const [slug, tsNames] of tsDirsBySlug) {
    const newestFirst = [...tsNames].sort().reverse();
    for (const tsName of newestFirst.slice(backupsKeepPerSlug)) {
      await unlink(path.join(backupsDir, tsName, slug)).catch(() => {});
      backupsPruned += 1;
    }
  }
  for (const tsName of await safeReaddir(backupsDir)) {
    const tsDir = path.join(backupsDir, tsName);
    if ((await safeReaddir(tsDir)).length === 0) await rmdir(tsDir).catch(() => {});
  }

  return Object.freeze({ sessionsArchived, archivesDeleted, inboxDeleted, backupsPruned, problems });
}

export async function auditPermissions({ stateDir }) {
  try {
    await lstat(stateDir);
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'warn', detail: `${stateDir} does not exist` };
    throw error;
  }

  const offenders = [];
  let count = 0;

  async function walk(dirPath) {
    for (const entry of await safeReaddir(dirPath, { withFileTypes: true })) {
      const entryPath = path.join(dirPath, entry.name);
      const info = await lstat(entryPath);
      count += 1;
      if ((info.mode & 0o077) !== 0) {
        offenders.push(`${entryPath} ${(info.mode & 0o777).toString(8)}`);
      }
      if (entry.isDirectory()) await walk(entryPath);
    }
  }

  await walk(stateDir);

  if (offenders.length > 0) return { status: 'fail', detail: offenders.join(', ') };
  return { status: 'pass', detail: `${count} entries checked, all owner-only` };
}

export async function checkTargetsAreIds({ stateDir }) {
  const bindingsDir = path.join(stateDir, 'bindings');
  const bindFiles = (await safeReaddir(bindingsDir)).filter((name) => name.endsWith('.bind'));

  if (bindFiles.length === 0) return { status: 'pass', detail: 'no bindings present' };

  const offenders = [];
  for (const name of bindFiles) {
    const filePath = path.join(bindingsDir, name);
    const parsed = await readJsonSafe(filePath);
    if (parsed === null) {
      offenders.push(`${filePath}: unparseable`);
      continue;
    }
    if (typeof parsed.target !== 'string' || !TARGET_PATTERN.test(parsed.target)) {
      offenders.push(`${filePath}: target "${parsed.target}"`);
    }
  }

  if (offenders.length > 0) return { status: 'fail', detail: offenders.join(', ') };
  return { status: 'pass', detail: `${bindFiles.length} binding(s) checked` };
}

async function dirStats(dirPath) {
  let count = 0;
  let bytes = 0;

  async function walk(currentPath) {
    for (const entry of await safeReaddir(currentPath, { withFileTypes: true })) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile()) {
        count += 1;
        bytes += (await stat(entryPath)).size;
      }
    }
  }

  await walk(dirPath);
  return { count, bytes };
}

export async function checkRetentionCounts({ stateDir }) {
  const dirs = ['sessions', 'archive', 'inbox', 'backups', 'handoffs', 'unknown'];
  const parts = [];
  for (const dirName of dirs) {
    const { count, bytes } = await dirStats(path.join(stateDir, dirName));
    parts.push(`${dirName}: ${count} files, ${bytes} bytes`);
  }
  return { status: 'pass', detail: parts.join('; ') };
}

export async function checkCanaryUnknownFields({ stateDir, now }) {
  const unknownDir = path.join(stateDir, 'unknown');
  const names = (await safeReaddir(unknownDir)).filter((name) => name.endsWith('.json'));

  const recentPairs = [];
  for (const name of names) {
    const filePath = path.join(unknownDir, name);
    const parsed = await readJsonSafe(filePath);
    if (parsed === null) return { status: 'fail', detail: `${filePath}: unparseable canary` };

    const atMs = parseTimestamp(parsed.at);
    if (atMs !== null && now - atMs <= DAY_MS) {
      recentPairs.push(`${parsed.adapter ?? '?'}/${parsed.key ?? '?'}`);
    }
  }

  if (recentPairs.length > 0) {
    return { status: 'warn', detail: `${recentPairs.length} recent canary(ies): ${recentPairs.join(', ')}` };
  }
  return { status: 'pass', detail: `${names.length} canary(ies), none in the last 24h` };
}

export async function checkAttentionStuck({ stateDir }) {
  const sessionsDir = path.join(stateDir, 'sessions');
  const names = (await safeReaddir(sessionsDir)).filter((name) => name.endsWith('.json'));

  const stuck = [];
  for (const name of names) {
    const filePath = path.join(sessionsDir, name);
    const parsed = await readJsonSafe(filePath);
    if (parsed === null) return { status: 'fail', detail: `${filePath}: unparseable session` };
    if (parsed?.flags?.attentionStuck === true) stuck.push(filePath);
  }

  if (stuck.length > 0) return { status: 'fail', detail: stuck.join(', ') };
  return { status: 'pass', detail: `${names.length} session(s) checked, none stuck` };
}

function finishRead(records, errors) {
  return Object.freeze({ records: Object.freeze(records), errors: Object.freeze(errors) });
}

function reportReadError(errors, file, reason) {
  errors.push(Object.freeze({ file, reason }));
}

async function readRecords(stateDir, subdir, extension) {
  const records = [];
  const errors = [];
  const dirPath = path.join(stateDir, subdir);
  let names;
  try {
    names = await readdir(dirPath);
  } catch (error) {
    if (error.code === 'ENOENT') return finishRead(records, errors);
    reportReadError(errors, dirPath, error instanceof Error ? error.message : String(error));
    return finishRead(records, errors);
  }

  for (const name of names.filter((entry) => entry.endsWith(extension)).sort()) {
    try {
      const record = JSON.parse(await readFile(path.join(dirPath, name), 'utf8'));
      if (record === null || typeof record !== 'object' || Array.isArray(record)) {
        throw new TypeError('record must be a plain object');
      }
      records.push(Object.freeze({ file: name, record }));
    } catch (error) {
      reportReadError(errors, name, error instanceof Error ? error.message : String(error));
    }
  }

  return finishRead(records, errors);
}

export async function readSessions(stateDir) {
  return readRecords(stateDir, 'sessions', '.json');
}

export async function readArchive(stateDir) {
  return readRecords(stateDir, 'archive', '.json');
}

export async function readBindings(stateDir) {
  return readRecords(stateDir, 'bindings', '.bind');
}
