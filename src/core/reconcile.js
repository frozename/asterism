import { createHash } from 'node:crypto';
import { parseCtime } from './liveness.js';

export const OBSERVATION_SOURCES = Object.freeze(['contract', 'registry-file', 'bindings-spool', 'process-table']);

export const FIELD_DISPOSITIONS = Object.freeze({
  PROJECTED: 'projected',
  NOT_PROJECTED: 'deliberately-not-projected',
});

export const PROJECTED_FIELDS = Object.freeze(['sessionId', 'cwd', 'pid', 'status', 'waitingFor']);

export const FIELD_DISPOSITION_LEDGER = Object.freeze([
  Object.freeze({
    key: 'cwd',
    disposition: FIELD_DISPOSITIONS.PROJECTED,
    reason: 'The working directory is normalized into agent.cwd for display and repository context.',
  }),
  Object.freeze({
    key: 'kind',
    disposition: FIELD_DISPOSITIONS.NOT_PROJECTED,
    reason: 'The vendor process kind has no source-neutral destination in the session record.',
  }),
  Object.freeze({
    key: 'name',
    disposition: FIELD_DISPOSITIONS.NOT_PROJECTED,
    reason: 'The generic projector skips name because buildRecord maps it separately to agent.name with agent.name provenance.',
  }),
  Object.freeze({
    key: 'pid',
    disposition: FIELD_DISPOSITIONS.PROJECTED,
    reason: 'The process id is normalized into agent.pid for liveness correlation.',
  }),
  Object.freeze({
    key: 'sessionId',
    disposition: FIELD_DISPOSITIONS.PROJECTED,
    reason: 'The vendor session id groups observations and is normalized into agent.sessionId.',
  }),
  Object.freeze({
    key: 'startedAt',
    disposition: FIELD_DISPOSITIONS.NOT_PROJECTED,
    reason: 'Liveness uses the independently parsed procStart value instead of the vendor start timestamp.',
  }),
  Object.freeze({
    key: 'status',
    disposition: FIELD_DISPOSITIONS.PROJECTED,
    reason: 'The vendor activity state is normalized into observed.status.',
  }),
  Object.freeze({
    key: 'waitingFor',
    disposition: FIELD_DISPOSITIONS.PROJECTED,
    reason: 'The waiting detail is normalized into observed.waitingFor for attention routing.',
  }),
  Object.freeze({
    key: 'bridgeSessionId',
    disposition: FIELD_DISPOSITIONS.NOT_PROJECTED,
    reason: 'The bridge-specific identity has no source-neutral destination in the session record.',
  }),
  Object.freeze({
    key: 'entrypoint',
    disposition: FIELD_DISPOSITIONS.NOT_PROJECTED,
    reason: 'The vendor launch entrypoint is diagnostic metadata with no normalized record field.',
  }),
  Object.freeze({
    key: 'messagingSocketPath',
    disposition: FIELD_DISPOSITIONS.NOT_PROJECTED,
    reason: 'The vendor transport path is not part of the normalized session schema or its routing contract.',
  }),
  Object.freeze({
    key: 'nameSince',
    disposition: FIELD_DISPOSITIONS.NOT_PROJECTED,
    reason: 'Vendor name timing is not used; the winning name carries observation provenance instead.',
  }),
  Object.freeze({
    key: 'nameSource',
    disposition: FIELD_DISPOSITIONS.NOT_PROJECTED,
    reason: 'Vendor name provenance is not copied; the winning observation supplies source-neutral provenance.',
  }),
  Object.freeze({
    key: 'peerProtocol',
    disposition: FIELD_DISPOSITIONS.NOT_PROJECTED,
    reason: 'The adapter uses peerProtocol to gate registry enrichment before reconciliation, so it is not record data.',
  }),
  Object.freeze({
    key: 'peerFeatures',
    disposition: FIELD_DISPOSITIONS.NOT_PROJECTED,
    reason:
      'The peer\'s advertised capability list was ["notify_idle"] in every live registry record beside peerProtocol. Asterism does not consume registry self-reports today: src/core/caps.js is populated by probes. Project this field only after probe-backed capabilities explicitly reconcile the advertisement.',
    deferredTo: 'probe-backed-peer-feature-reconciliation',
  }),
  Object.freeze({
    key: 'procStart',
    disposition: FIELD_DISPOSITIONS.NOT_PROJECTED,
    reason: 'The raw process start value is parsed separately into agent.procStartEpoch and liveness provenance.',
  }),
  Object.freeze({
    key: 'statusUpdatedAt',
    disposition: FIELD_DISPOSITIONS.NOT_PROJECTED,
    reason: 'The vendor status timestamp is reserved as staleness evidence and has no normalized record field.',
  }),
  Object.freeze({
    key: 'tmux',
    disposition: FIELD_DISPOSITIONS.NOT_PROJECTED,
    reason: 'The vendor tmux witness is adapter metadata; normalized bindings are established through the binding path.',
  }),
  Object.freeze({
    key: 'updatedAt',
    disposition: FIELD_DISPOSITIONS.NOT_PROJECTED,
    reason: 'Observation envelopes provide source-neutral freshness, so the vendor update timestamp is not copied.',
  }),
  Object.freeze({
    key: 'version',
    disposition: FIELD_DISPOSITIONS.NOT_PROJECTED,
    reason: 'The vendor version is feature-gate evidence rather than a normalized session field.',
  }),
]);

/** @type {readonly string[]} */
export const KNOWN_FIELDS = Object.freeze(FIELD_DISPOSITION_LEDGER.map((entry) => entry.key));

export function fieldDispositionViolations(ledger, projectedFields) {
  const violations = [];
  const entriesByKey = new Map();
  const projected = new Set(projectedFields);

  for (const entry of ledger) {
    if (typeof entry.key !== 'string' || entry.key.length === 0) {
      violations.push('field disposition ledger entry has an empty key');
      continue;
    }
    if (entriesByKey.has(entry.key)) violations.push(`field disposition ledger has duplicate key "${entry.key}"`);
    else entriesByKey.set(entry.key, entry);

    if (!Object.values(FIELD_DISPOSITIONS).includes(entry.disposition)) {
      violations.push(`field disposition ledger entry "${entry.key}" has invalid disposition "${entry.disposition}"`);
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
      violations.push(`field disposition ledger entry "${entry.key}" is missing a non-empty reason`);
    }
    if (entry.disposition === FIELD_DISPOSITIONS.PROJECTED && !projected.has(entry.key)) {
      violations.push(`field disposition ledger marks "${entry.key}" projected but PROJECTED_FIELDS omits "${entry.key}"`);
    }
  }

  for (const key of projectedFields) {
    const entry = entriesByKey.get(key);
    if (!entry || entry.disposition !== FIELD_DISPOSITIONS.PROJECTED) {
      violations.push(`PROJECTED_FIELDS includes "${key}" but the ledger does not mark it projected`);
    }
  }

  return Object.freeze(violations);
}

const FIELD_DISPOSITION_VIOLATIONS = fieldDispositionViolations(FIELD_DISPOSITION_LEDGER, PROJECTED_FIELDS);
if (FIELD_DISPOSITION_VIOLATIONS.length > 0) {
  throw new Error(`reconcile: invalid field disposition ledger: ${FIELD_DISPOSITION_VIOLATIONS.join('; ')}`);
}

export const FEATURE_REQUIRES = Object.freeze({
  liveness: Object.freeze(['procStart']),
  staleness: Object.freeze(['statusUpdatedAt']),
  versionGate: Object.freeze(['version']),
  paneWitness: Object.freeze(['tmux']),
});

export const KNOWN_STATUSES = Object.freeze(['busy', 'waiting', 'idle', 'completed', 'dead']);

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
  const nameWinner = pickFieldWinner(envelopes, 'name');
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
  if (nameWinner) prov['agent.name'] = provEntry(nameWinner);
  if (procStartWinner) prov.procStart = provEntry(procStartWinner);

  return Object.freeze({
    id,
    adapter,
    diedAt: null,
    agent: Object.freeze({
      sessionId,
      name: nameWinner ? nameWinner.value : null,
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
    const id = mint(group.adapter, group.sessionId);
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
