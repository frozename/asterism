import { createHash } from 'node:crypto';
import { parseCtime } from './liveness.js';

export const OBSERVATION_SOURCES = Object.freeze(['contract', 'registry-file', 'bindings-spool', 'process-table']);

export const KNOWN_FIELDS = Object.freeze([
  'cwd',
  'kind',
  'name',
  'pid',
  'sessionId',
  'startedAt',
  'status',
  'waitingFor',
  'bridgeSessionId',
  'entrypoint',
  'messagingSocketPath',
  'nameSince',
  'nameSource',
  'peerProtocol',
  'procStart',
  'statusUpdatedAt',
  'tmux',
  'updatedAt',
  'version',
]);

export const FEATURE_REQUIRES = Object.freeze({
  liveness: Object.freeze(['procStart']),
  staleness: Object.freeze(['statusUpdatedAt']),
  versionGate: Object.freeze(['version']),
  paneWitness: Object.freeze(['tmux']),
});

export const KNOWN_STATUSES = Object.freeze(['busy', 'waiting', 'idle', 'completed', 'dead']);

const PROJECTED_FIELDS = Object.freeze(['sessionId', 'cwd', 'pid', 'status', 'waitingFor']);

const SOURCE_RANK = Object.freeze({ contract: 3, 'registry-file': 2, 'bindings-spool': 1, 'process-table': 0 });

const STATUS_RANK = Object.freeze({ waiting: 0, busy: 1, idle: 2 });

const WRITE_DISABLED_REASON =
  'liveness degraded to pid-alive: procStart unavailable; registry enrichment absent; record is read-only';

export function statusLabel(status) {
  if (status === null) return 'unknown';
  if (KNOWN_STATUSES.includes(status)) return status;
  return 'unknown';
}

function statusRank(status) {
  return Object.hasOwn(STATUS_RANK, status) ? STATUS_RANK[status] : 3;
}

export function compareRecords(a, b) {
  const rankA = statusRank(a.observed.status);
  const rankB = statusRank(b.observed.status);
  if (rankA !== rankB) return rankA - rankB;

  if (a.observed.lastSeen !== b.observed.lastSeen) return b.observed.lastSeen - a.observed.lastSeen;

  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function compareCanaries(a, b) {
  if (a.adapter !== b.adapter) return a.adapter < b.adapter ? -1 : 1;
  if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  if (a.sha !== b.sha) return a.sha < b.sha ? -1 : 1;
  return 0;
}

function isPlainObject(candidate) {
  return candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate);
}

function validateEnvelope(envelope) {
  if (!isPlainObject(envelope)) {
    throw new TypeError('reconcile: an observation must be an object');
  }
  if (!OBSERVATION_SOURCES.includes(envelope.source)) {
    throw new TypeError(`reconcile: unknown observation source "${envelope.source}"`);
  }
  if (!Number.isFinite(envelope.at)) {
    throw new TypeError('reconcile: observation "at" must be a finite number');
  }
  if (!isPlainObject(envelope.fields)) {
    throw new TypeError('reconcile: observation "fields" must be an object');
  }
}

// The dedupe/group keys below are built with JSON.stringify over an array of
// their parts rather than a joined string, so an adapter id, field key, or
// sessionId that happens to contain any particular separator character can
// never collide two distinct tuples onto the same Map key.
function canaryFor(adapter, key, value) {
  const sha = createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
  return { dedupeKey: JSON.stringify([adapter, key, sha]), canary: Object.freeze({ adapter, key, sha }) };
}

function addCanary(canaryMap, adapter, key, value) {
  const { dedupeKey, canary } = canaryFor(adapter, key, value);
  if (!canaryMap.has(dedupeKey)) canaryMap.set(dedupeKey, canary);
}

function compareCandidates(a, b) {
  if (a.at !== b.at) return b.at - a.at;
  const rankDiff = SOURCE_RANK[b.source] - SOURCE_RANK[a.source];
  if (rankDiff !== 0) return rankDiff;
  const jsonA = JSON.stringify(a.value);
  const jsonB = JSON.stringify(b.value);
  if (jsonA < jsonB) return -1;
  if (jsonA > jsonB) return 1;
  return 0;
}

function pickWinner(candidates) {
  if (candidates.length === 0) return null;
  return [...candidates].sort(compareCandidates)[0];
}

function pickFieldWinner(envelopes, fieldName) {
  const candidates = [];
  for (const envelope of envelopes) {
    if (Object.hasOwn(envelope.fields, fieldName)) {
      candidates.push({
        source: envelope.source,
        at: envelope.at,
        value: envelope.fields[fieldName],
        confidence: envelope.confidence ?? 'unspecified',
      });
    }
  }
  return pickWinner(candidates);
}

// An unparseable procStart degrades as absent: it is excluded from the
// winner pool (never synthesized, never defaulted) and lands its own canary.
function pickProcStartWinner(envelopes, canaryMap, adapter) {
  const candidates = [];
  for (const envelope of envelopes) {
    if (!Object.hasOwn(envelope.fields, 'procStart')) continue;
    const raw = envelope.fields.procStart;

    let epoch;
    try {
      epoch = parseCtime(raw, { utc: true });
    } catch {
      addCanary(canaryMap, adapter, 'procStart', raw ?? null);
      continue;
    }

    candidates.push({
      source: envelope.source,
      at: envelope.at,
      value: raw,
      epoch,
      confidence: envelope.confidence ?? 'unspecified',
    });
  }
  return pickWinner(candidates);
}

function provEntry(winner) {
  return Object.freeze({ source: winner.source, confidence: winner.confidence, at: winner.at });
}

function scanFieldCanaries(canaryMap, adapter, fields) {
  for (const key of Object.keys(fields)) {
    if (!KNOWN_FIELDS.includes(key)) {
      addCanary(canaryMap, adapter, key, fields[key]);
      continue;
    }
    if (key === 'status') {
      const value = fields.status;
      if (value === null || (typeof value === 'string' && !KNOWN_STATUSES.includes(value))) {
        addCanary(canaryMap, adapter, 'status', value);
      }
    }
  }
}

function buildRecord({ id, adapter, sessionId, envelopes, now, canaryMap }) {
  const winners = {};
  for (const field of PROJECTED_FIELDS) winners[field] = pickFieldWinner(envelopes, field);
  const procStartWinner = pickProcStartWinner(envelopes, canaryMap, adapter);

  let lastSeen = -Infinity;
  for (const envelope of envelopes) {
    if (envelope.at > lastSeen) lastSeen = envelope.at;
  }

  const liveness = procStartWinner
    ? Object.freeze({ source: 'proc-start', confidence: 'high', at: now })
    : Object.freeze({ source: 'pid-only', confidence: 'low', at: now });

  const prov = { liveness };
  for (const field of PROJECTED_FIELDS) {
    if (winners[field]) prov[field] = provEntry(winners[field]);
  }
  if (procStartWinner) prov.procStart = provEntry(procStartWinner);

  return Object.freeze({
    id,
    adapter,
    agent: Object.freeze({
      sessionId,
      cwd: winners.cwd ? winners.cwd.value : null,
      gitRoot: null,
      branch: null,
      headSha: null,
      pid: winners.pid ? winners.pid.value : null,
      procStartEpoch: procStartWinner ? procStartWinner.epoch : null,
      host: null,
      bootId: null,
    }),
    binding: null,
    state: 'Unbound',
    observed: Object.freeze({
      status: winners.status ? winners.status.value : null,
      waitingFor: winners.waitingFor ? winners.waitingFor.value : null,
      lastSeen,
      generation: envelopes.length,
    }),
    flags: Object.freeze({
      parked: false,
      attentionStuck: false,
      writeDisabled: !procStartWinner,
      reason: procStartWinner ? null : WRITE_DISABLED_REASON,
    }),
    prov: Object.freeze(prov),
  });
}

export async function reconcile(observations, { now, mint }) {
  const canaryMap = new Map();
  const groups = new Map();

  for await (const envelope of observations) {
    validateEnvelope(envelope);
    scanFieldCanaries(canaryMap, envelope.adapter, envelope.fields);

    const sessionId = envelope.fields.sessionId;
    if (!Object.hasOwn(envelope.fields, 'sessionId') || typeof sessionId !== 'string') {
      addCanary(canaryMap, envelope.adapter, 'sessionId', sessionId ?? null);
      continue;
    }

    const groupKey = JSON.stringify([envelope.adapter, sessionId]);
    let group = groups.get(groupKey);
    if (!group) {
      group = { adapter: envelope.adapter, sessionId, envelopes: [] };
      groups.set(groupKey, group);
    }
    group.envelopes.push(envelope);
  }

  const sortedKeys = [...groups.keys()].sort((a, b) => {
    const groupA = groups.get(a);
    const groupB = groups.get(b);
    if (groupA.adapter !== groupB.adapter) return groupA.adapter < groupB.adapter ? -1 : 1;
    if (groupA.sessionId !== groupB.sessionId) return groupA.sessionId < groupB.sessionId ? -1 : 1;
    return 0;
  });

  const records = [];
  for (const key of sortedKeys) {
    const group = groups.get(key);
    const id = mint();
    records.push(
      buildRecord({
        id,
        adapter: group.adapter,
        sessionId: group.sessionId,
        envelopes: group.envelopes,
        now,
        canaryMap,
      }),
    );
  }

  records.sort(compareRecords);
  const canaries = [...canaryMap.values()].sort(compareCanaries);

  return { records, canaries };
}
