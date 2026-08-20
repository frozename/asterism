import { randomBytes } from 'node:crypto';
import { compareRecords, reconcile } from '../core/reconcile.js';
import { createUlidMinter } from '../core/ulid.js';
import { collectObservations } from '../io/discover.js';
import { processTable } from '../io/procs.js';
import { readBindings, readSessions, sweepRetention } from '../io/store.js';
import { buildIndexPayload, writeSeamIndex } from '../seam/index.js';

function note(adapter, name, detail) {
  return Object.freeze({ adapter, note: name, detail });
}

function sessionKey(adapter, sessionId) {
  return JSON.stringify([adapter, sessionId]);
}

export function stableIds(records, priorRecords) {
  const priorIds = new Map();
  for (const entry of priorRecords) {
    const record = entry?.record ?? entry;
    if (
      typeof record?.id === 'string' &&
      typeof record?.adapter === 'string' &&
      typeof record?.agent?.sessionId === 'string'
    ) {
      priorIds.set(sessionKey(record.adapter, record.agent.sessionId), record.id);
    }
  }

  const stable = records.map((record) => {
    const priorId = priorIds.get(sessionKey(record.adapter, record.agent.sessionId));
    return priorId === undefined ? record : Object.freeze({ ...record, id: priorId });
  });
  stable.sort(compareRecords);
  return Object.freeze(stable);
}

export function resolveSessionRef(records, ref) {
  const exact = records.find((record) => record.id === ref || record.agent.sessionId === ref);
  if (exact !== undefined) return { record: exact };

  const matches = records.filter((record) => record.id.startsWith(ref) || record.agent.sessionId.startsWith(ref));
  if (matches.length === 1) return { record: matches[0] };
  if (matches.length > 1) {
    const ids = matches.map((record) => record.id).sort();
    return { error: `ambiguous session ref "${ref}": matches ${ids.join(', ')}` };
  }
  return { error: `no session matches "${ref}"` };
}

export async function collectSessions({ env, adapters, home, store, now = Date.now(), execute, mint }) {
  const observations = [];
  const notes = [];

  for (const adapter of adapters.values()) {
    const options = { env, home, now };
    if (execute !== undefined) options.execute = execute;
    const collected = await collectObservations(adapter, options);
    observations.push(...collected.observations);
    notes.push(...collected.notes);
  }

  const bindings = await readBindings(store.stateDir);
  for (const error of bindings.errors) {
    notes.push(note('store', 'binding-unreadable', `${error.file}: ${error.reason}`));
  }
  for (const entry of bindings.records) {
    const record = entry.record;
    if (typeof record.adapter !== 'string' || typeof record.sessionId !== 'string') {
      notes.push(note('store', 'binding-malformed', entry.file));
      continue;
    }
    observations.push(
      Object.freeze({
        source: 'bindings-spool',
        adapter: record.adapter,
        at: now,
        fields: Object.freeze({ sessionId: record.sessionId, tmux: record.target }),
      }),
    );
  }

  const pidRows = [];
  const pids = new Set();
  for (const observation of observations) {
    const pid = observation.fields.pid;
    if (!Number.isInteger(pid) || pid <= 0) continue;
    pids.add(pid);
    pidRows.push({ adapter: observation.adapter, sessionId: observation.fields.sessionId, pid });
  }
  if (pids.size > 0) {
    const processOptions = { env };
    if (execute !== undefined) processOptions.execute = execute;
    const processes = await processTable([...pids], processOptions);
    if (processes.note !== null) notes.push(note('ps', 'process-table-degraded', processes.note));
    for (const row of pidRows) {
      if (!processes.table.has(row.pid)) continue;
      observations.push(
        Object.freeze({
          source: 'process-table',
          adapter: row.adapter,
          at: now,
          fields: Object.freeze({ sessionId: row.sessionId, pid: row.pid }),
        }),
      );
    }
  }

  const defaultMint = createUlidMinter({ now: () => now, random: randomBytes });
  const reconciled = await reconcile(observations, { now, mint: mint ?? defaultMint });
  const prior = await readSessions(store.stateDir);
  for (const error of prior.errors) {
    notes.push(note('store', 'session-unreadable', `${error.file}: ${error.reason}`));
  }
  const records = stableIds(reconciled.records, prior.records);

  for (const record of records) await store.writeSession(record.id, record);
  for (const canary of reconciled.canaries) {
    await store.writeCanary({ adapter: canary.adapter, key: canary.key, sha: canary.sha, at: now });
  }
  await writeSeamIndex(store, records, { now });
  const waiting = records.filter((record) => record.observed.status === 'waiting').length;
  await store.appendUsage(`ls sessions=${records.length} waiting=${waiting}`);
  try {
    await sweepRetention(store.stateDir, { now });
  } catch (error) {
    notes.push(note('store', 'retention-sweep-failed', error instanceof Error ? error.message : String(error)));
  }

  return Object.freeze({
    records,
    canaries: Object.freeze(reconciled.canaries),
    notes: Object.freeze(notes),
  });
}

export { buildIndexPayload as sessionsPayload } from '../seam/index.js';
