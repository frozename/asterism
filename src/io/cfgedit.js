import { chmod, mkdir, open, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

// The only writer of a file asterism does not own. Every write goes through
// plan -> lock -> backup -> write -> byte-diff-or-restore, and only ever
// touches a marker-delimited block: this module never repairs another
// program's config, it only reports on it (see checkManagedBlockDrift).

export const MANAGED_FILE_MARKER = 'asterism managed file';

const BLOCK_ID_PATTERN = /^[a-z0-9-]+$/;
const LOCK_POLL_MS = 50;

function openMarkerLine(blockId) {
  return `# >>> asterism managed block ${blockId} >>>`;
}

function closeMarkerLine(blockId) {
  return `# <<< asterism managed block ${blockId} <<<`;
}

function normalizeContent(content, targetPath, blockId) {
  if (typeof content !== 'string') {
    throw new TypeError(`cfgedit: content must be a string or null for ${targetPath}`);
  }
  const normalized = content.endsWith('\n') ? content : `${content}\n`;
  const openLine = openMarkerLine(blockId);
  const closeLine = closeMarkerLine(blockId);
  if (normalized.split('\n').some((line) => line === openLine || line === closeLine)) {
    throw new Error(`cfgedit: content for ${targetPath} contains a marker line for block "${blockId}"`);
  }
  return normalized;
}

// Finds every whole-line occurrence of `lineText` in `text` -- a hit must
// start at a line boundary and end at one, so a marker can never be confused
// with a longer line that merely contains the same text as a substring.
function findLineOccurrences(text, lineText) {
  const occurrences = [];
  let index = text.indexOf(lineText);
  while (index !== -1) {
    const afterIndex = index + lineText.length;
    const precededByBoundary = index === 0 || text[index - 1] === '\n';
    const followedByBoundary = afterIndex === text.length || text[afterIndex] === '\n';
    if (precededByBoundary && followedByBoundary) {
      const hasTrailingNewline = afterIndex !== text.length;
      occurrences.push({ start: index, end: hasTrailingNewline ? afterIndex + 1 : afterIndex, hasTrailingNewline });
    }
    index = text.indexOf(lineText, index + 1);
  }
  return occurrences;
}

function locateMarkers(text, blockId) {
  const opens = findLineOccurrences(text, openMarkerLine(blockId));
  if (opens.length === 0) return { present: false };
  if (opens.length > 1) return { present: true, malformed: true, reason: 'duplicate open marker' };

  const openOcc = opens[0];
  const closes = findLineOccurrences(text, closeMarkerLine(blockId)).filter((occ) => occ.start > openOcc.start);
  if (closes.length === 0) return { present: true, malformed: true, reason: 'open marker without close marker' };

  return { present: true, malformed: false, openOcc, closeOcc: closes[0] };
}

function buildInstallText(before, content, blockId) {
  const separator = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
  return `${before}${separator}${openMarkerLine(blockId)}\n${content}${closeMarkerLine(blockId)}\n`;
}

function buildUpdateText(beforeText, located, content, blockId) {
  const trailing = located.closeOcc.hasTrailingNewline ? '\n' : '';
  const block = `${openMarkerLine(blockId)}\n${content}${closeMarkerLine(blockId)}${trailing}`;
  return beforeText.slice(0, located.openOcc.start) + block + beforeText.slice(located.closeOcc.end);
}

function freezePlan(target, action, before, after, blockId) {
  return Object.freeze({
    target,
    action,
    before,
    after,
    markers: Object.freeze({ blockId, open: openMarkerLine(blockId), close: closeMarkerLine(blockId) }),
  });
}

async function readIfPresent(targetPath) {
  try {
    return await readFile(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function planManagedBlock({ targetPath, blockId, content }) {
  if (!BLOCK_ID_PATTERN.test(blockId)) {
    throw new Error(`cfgedit: invalid blockId "${blockId}" for ${targetPath}`);
  }

  const normalizedContent = content === null ? null : normalizeContent(content, targetPath, blockId);
  const beforeBuffer = await readIfPresent(targetPath);

  if (beforeBuffer === null) {
    if (normalizedContent === null) return freezePlan(targetPath, 'noop', null, null, blockId);
    const after = Buffer.from(buildInstallText('', normalizedContent, blockId), 'utf8');
    return freezePlan(targetPath, 'install', null, after, blockId);
  }

  const beforeText = beforeBuffer.toString('utf8');
  const located = locateMarkers(beforeText, blockId);

  if (located.malformed) {
    throw new Error(`cfgedit: malformed managed block "${blockId}" in ${targetPath}: ${located.reason}`);
  }

  if (!located.present) {
    if (normalizedContent === null) return freezePlan(targetPath, 'noop', beforeBuffer, beforeBuffer, blockId);
    const after = Buffer.from(buildInstallText(beforeText, normalizedContent, blockId), 'utf8');
    return freezePlan(targetPath, 'install', beforeBuffer, after, blockId);
  }

  const body = beforeText.slice(located.openOcc.end, located.closeOcc.start);

  if (normalizedContent === null) {
    const afterText = beforeText.slice(0, located.openOcc.start) + beforeText.slice(located.closeOcc.end);
    return freezePlan(targetPath, 'remove', beforeBuffer, Buffer.from(afterText, 'utf8'), blockId);
  }

  if (body === normalizedContent) return freezePlan(targetPath, 'noop', beforeBuffer, beforeBuffer, blockId);

  const afterText = buildUpdateText(beforeText, located, normalizedContent, blockId);
  return freezePlan(targetPath, 'update', beforeBuffer, Buffer.from(afterText, 'utf8'), blockId);
}

export function diffManagedBlock(bytes, { blockId, content }) {
  if (!BLOCK_ID_PATTERN.test(blockId)) {
    throw new Error(`cfgedit: invalid blockId "${blockId}"`);
  }
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  const normalizedContent = normalizeContent(content, '<managed-block-diff>', blockId);
  const located = locateMarkers(text, blockId);

  if (located.malformed) return { status: 'drifted' };
  if (!located.present) return { status: 'absent' };

  const body = text.slice(located.openOcc.end, located.closeOcc.start);
  return { status: body === normalizedContent ? 'present' : 'drifted' };
}

function absentDetail(blockId, targetPath) {
  return `managed block "${blockId}" is absent from ${targetPath}; run ast init to install it`;
}

export async function checkManagedBlockDrift({ targetPath, blockId, content }) {
  let bytes;
  try {
    bytes = await readFile(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'warn', detail: absentDetail(blockId, targetPath) };
    return { status: 'unknown', detail: `cfgedit: cannot read ${targetPath}: ${error.message}` };
  }

  const { status } = diffManagedBlock(bytes, { blockId, content });
  if (status === 'present') return { status: 'pass' };
  if (status === 'absent') return { status: 'warn', detail: absentDetail(blockId, targetPath) };
  return { status: 'warn', detail: `managed block "${blockId}" in ${targetPath} has drifted from what asterism last wrote` };
}

function slugFor(targetPath) {
  const lowered = String(targetPath).toLowerCase().replace(/[^a-z0-9.-]+/g, '-');
  const trimmed = lowered.replace(/^-+/, '').replace(/-+$/, '');
  return trimmed.length > 0 ? trimmed : 'target';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function acquireLock(targetPath, { lockTimeoutMs, isPidAliveFn }) {
  const lockPath = `${targetPath}.asterism.lock`;
  const deadline = Date.now() + lockTimeoutMs;
  const payload = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });

  for (;;) {
    let handle;
    try {
      handle = await open(lockPath, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;

      let holder;
      try {
        holder = JSON.parse(await readFile(lockPath, 'utf8'));
      } catch (readError) {
        if (readError.code === 'ENOENT') continue;
        throw readError;
      }

      const alive = holder && typeof holder.pid === 'number' ? isPidAliveFn(holder.pid) : false;
      if (!alive) {
        throw new Error(`cfgedit: stale lock ${lockPath} (pid ${holder.pid} is gone); refusing to steal it`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`cfgedit: lock held for ${targetPath} by pid ${holder.pid}; timed out after ${lockTimeoutMs}ms`);
      }
      await sleep(LOCK_POLL_MS);
      continue;
    }

    try {
      await handle.writeFile(payload, 'utf8');
    } finally {
      await handle.close();
    }
    return lockPath;
  }
}

async function releaseLock(lockPath) {
  await rm(lockPath, { force: true });
}

function buffersEqual(a, b) {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}

async function writeViaTempAndRename(targetPath, buffer, mode) {
  const tempPath = `${targetPath}.${process.pid}.asterism-tmp`;
  try {
    const handle = await open(tempPath, 'w');
    try {
      await handle.writeFile(buffer);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(tempPath, mode);
    await rename(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function applyPlan(plan, opts) {
  const { writeBackup, lockTimeoutMs = 2000, isPidAlive = defaultIsPidAlive, afterWrite, allowMkdir = false } = opts;

  if (plan.action === 'noop') return { ok: true, action: 'noop', backupPath: null };

  const targetPath = plan.target;
  if (allowMkdir) await mkdir(path.dirname(targetPath), { recursive: true });

  const lockPath = await acquireLock(targetPath, { lockTimeoutMs, isPidAliveFn: isPidAlive });

  try {
    const current = await readIfPresent(targetPath);
    if (!buffersEqual(current, plan.before)) {
      throw new Error(`cfgedit: ${targetPath} changed since the plan was computed`);
    }

    let backupPath = null;
    if (plan.before !== null) backupPath = await writeBackup(slugFor(targetPath), plan.before);

    let mode = 0o644;
    if (plan.before !== null) {
      try {
        mode = (await stat(targetPath)).mode;
      } catch {
        // the target vanished between the read above and here; the default mode stands
      }
    }

    await writeViaTempAndRename(targetPath, plan.after, mode);

    if (typeof afterWrite === 'function') await afterWrite(targetPath);

    const verifyBuffer = await readFile(targetPath);
    if (!verifyBuffer.equals(plan.after)) {
      if (plan.before === null) {
        await unlink(targetPath);
      } else {
        await writeViaTempAndRename(targetPath, plan.before, mode);
      }
      throw new Error(`cfgedit: post-write verify failed for ${targetPath}; original bytes restored; backup at ${backupPath}`);
    }

    return { ok: true, action: plan.action, backupPath };
  } finally {
    await releaseLock(lockPath);
  }
}

export async function apply(plan, opts = {}) {
  return applyPlan(plan, opts);
}

export async function planFile({ targetPath, content }) {
  if (typeof content !== 'string' || !content.includes(MANAGED_FILE_MARKER)) {
    throw new Error(`cfgedit: refusing to plan ${targetPath}: content is missing the managed-file marker`);
  }

  const after = Buffer.from(content, 'utf8');
  const before = await readIfPresent(targetPath);

  if (before === null) return Object.freeze({ target: targetPath, action: 'install', before: null, after });
  if (before.equals(after)) return Object.freeze({ target: targetPath, action: 'noop', before, after });
  if (!before.toString('utf8').includes(MANAGED_FILE_MARKER)) {
    throw new Error(`cfgedit: refusing to overwrite ${targetPath}: existing file differs and carries no asterism marker`);
  }
  return Object.freeze({ target: targetPath, action: 'update', before, after });
}

export async function applyFilePlan(plan, opts = {}) {
  return applyPlan(plan, { ...opts, allowMkdir: true });
}

export async function removeFilePlan({ targetPath }) {
  const before = await readIfPresent(targetPath);
  if (before === null) return { ok: true, action: 'noop' };
  if (!before.toString('utf8').includes(MANAGED_FILE_MARKER)) {
    throw new Error(`cfgedit: refusing to remove ${targetPath}: file carries no asterism marker`);
  }
  await unlink(targetPath);
  return { ok: true, action: 'remove' };
}
