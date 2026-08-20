import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { sendNotification } from '../../io/notify.js';

export const DEFAULT_DEDUPE_TTL_MS = 600_000;

export function dedupeKey({ sessionId, message, statusUpdatedAt }) {
  // A time-free key would permanently mute a repeated prompt. The payload's
  // freshness signal re-keys a new occurrence; the TTL covers payloads that
  // lack that field.
  const freshness = statusUpdatedAt == null ? '' : `\n${statusUpdatedAt}`;
  return createHash('sha256').update(`${sessionId}\n${message}${freshness}`).digest('hex');
}

async function readDedupe(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function nextSequence(dirPath) {
  let names;
  try {
    names = await readdir(dirPath);
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }

  let max = -1;
  for (const name of names) {
    const match = name.match(/^(\d+)\.json$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

export async function run({
  adapter,
  adapterId,
  payload,
  env,
  store,
  exec,
  platform,
  now,
  ttlMs = DEFAULT_DEDUPE_TTL_MS,
}) {
  const parsed = adapter.hooks.parseNotification(payload);
  if (parsed === null) return;

  const eventNow = now();
  const key = dedupeKey(parsed);
  const sessionDir = path.join(store.stateDir, 'inbox', parsed.sessionId);
  const entries = await readDedupe(path.join(sessionDir, 'dedupe.json'));
  if (entries.some((entry) => entry.key === key && eventNow - entry.at < ttlMs)) {
    return;
  }

  const reason = parsed.waitingFor ?? 'waiting';
  const seq = await nextSequence(sessionDir);
  await store.writeInboxItem(parsed.sessionId, seq, {
    sessionId: parsed.sessionId,
    adapter: adapterId,
    title: parsed.title,
    message: parsed.message,
    reason,
    at: new Date(eventNow).toISOString(),
  });

  await sendNotification({
    platform,
    title: parsed.title ?? adapterId,
    body: `${reason}: ${parsed.message}`,
    env,
    exec,
  });

  const pruned = entries.filter(
    (entry) => typeof entry?.key === 'string' && typeof entry.at === 'number' && eventNow - entry.at < ttlMs,
  );
  pruned.push({ key, at: eventNow });
  await store.writeInboxDedupe(parsed.sessionId, pruned);
}
