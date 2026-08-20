import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { procexec } from './procexec.js';

const SHARED_LISTING_FIELDS = Object.freeze(['cwd', 'kind', 'name', 'pid', 'sessionId', 'startedAt', 'status']);

function note(adapter, name, detail) {
  return Object.freeze({ adapter: adapter.id, note: name, detail });
}

function envelope(adapter, source, at, fields) {
  return Object.freeze({ source, adapter: adapter.id, at, fields });
}

function finish(observations, notes) {
  return Object.freeze({ observations: Object.freeze(observations), notes: Object.freeze(notes) });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function collectArgv(adapter, { env, home, now, execute }) {
  const observations = [];
  const notes = [];
  let outcome;
  try {
    outcome = await execute(adapter.discoverArgv(), {
      env: { PATH: env?.PATH ?? '', HOME: env?.HOME ?? '' },
      timeoutMs: 5000,
    });
  } catch (error) {
    notes.push(note(adapter, 'adapter-unavailable', errorMessage(error)));
    return finish(observations, notes);
  }

  if (outcome.code !== 0) {
    notes.push(
      note(adapter, 'adapter-unavailable', `discovery command exited ${outcome.code}: ${outcome.stderr.toString('utf8').trim()}`),
    );
    return finish(observations, notes);
  }

  const parsed = adapter.parseAgentsJson(outcome.stdout.toString('utf8'));
  if (parsed.error !== null) {
    notes.push(note(adapter, 'contract-parse-failed', parsed.error));
    return finish(observations, notes);
  }
  for (const row of parsed.rows) observations.push(envelope(adapter, 'contract', now, row));

  if (typeof adapter.registryDir !== 'function' || !adapter.ENRICHMENT) return finish(observations, notes);

  const registryPath = adapter.registryDir(home);
  let names;
  try {
    names = await readdir(registryPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return finish(observations, notes);
    notes.push(note(adapter, 'enrichment-unavailable', `${registryPath}: ${errorMessage(error)}`));
    return finish(observations, notes);
  }

  for (const name of names.sort()) {
    if (!adapter.registryFilePattern.test(name)) continue;
    const filePath = path.join(registryPath, name);
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch (error) {
      notes.push(note(adapter, 'enrichment-read-failed', `${name}: ${errorMessage(error)}`));
      continue;
    }
    if (fileStat.size > adapter.ENRICHMENT.maxFileBytes) {
      notes.push(
        note(
          adapter,
          'enrichment-file-too-large',
          `${name}: ${fileStat.size} bytes exceeds ${adapter.ENRICHMENT.maxFileBytes}`,
        ),
      );
      continue;
    }

    let parsedRecord;
    try {
      parsedRecord = adapter.parseRegistryRecord(await readFile(filePath, 'utf8'));
    } catch (error) {
      notes.push(note(adapter, 'enrichment-read-failed', `${name}: ${errorMessage(error)}`));
      continue;
    }
    if (parsedRecord.error !== null) {
      notes.push(note(adapter, 'enrichment-parse-failed', `${name}: ${parsedRecord.error}`));
      continue;
    }
    if (parsedRecord.record.peerProtocol !== adapter.ENRICHMENT.requiredPeerProtocol) {
      notes.push(
        note(
          adapter,
          'enrichment-peer-protocol',
          `${name}: peerProtocol ${String(parsedRecord.record.peerProtocol)} does not equal required ${adapter.ENRICHMENT.requiredPeerProtocol}`,
        ),
      );
      continue;
    }
    observations.push(envelope(adapter, adapter.ENRICHMENT.provSource, now, parsedRecord.record));
  }

  return finish(observations, notes);
}

async function collectFunction(adapter, { env, now }) {
  try {
    const fieldsRows = await adapter.discover({ env });
    const observations = fieldsRows.map((fields) => envelope(adapter, 'contract', now, fields));
    return finish(observations, []);
  } catch (error) {
    return finish([], [note(adapter, 'adapter-unavailable', errorMessage(error))]);
  }
}

export async function collectObservations(adapter, { env, home, now = Date.now(), execute = procexec }) {
  if (typeof adapter.discoverArgv === 'function') {
    return collectArgv(adapter, { env, home, now, execute });
  }
  if (typeof adapter.discover === 'function') {
    return collectFunction(adapter, { env, now });
  }
  throw new TypeError('collectObservations: adapter must expose discoverArgv or discover');
}

export async function checkDiscoverySources(adapter, { env, home, execute = procexec }) {
  const collected = await collectObservations(adapter, { env, home, execute });
  const unavailable = collected.notes.find(
    (entry) => entry.note === 'adapter-unavailable' || entry.note === 'contract-parse-failed',
  );
  if (unavailable) return Object.freeze({ status: 'unknown', detail: unavailable.detail });

  const contract = collected.observations.filter((entry) => entry.source === 'contract');
  const enrichment = collected.observations.filter((entry) => entry.source === 'registry-file');
  if (enrichment.length === 0) {
    return Object.freeze({ status: 'pass', detail: 'contract source available; enrichment absent' });
  }

  const contractBySession = new Map(contract.map((entry) => [entry.fields.sessionId, entry.fields]));
  for (const entry of enrichment) {
    const sessionId = entry.fields.sessionId;
    if (!contractBySession.has(sessionId)) continue;
    const listed = contractBySession.get(sessionId);
    const disagreements = SHARED_LISTING_FIELDS.filter((field) => !Object.is(listed[field], entry.fields[field]));
    if (disagreements.length > 0) {
      return Object.freeze({
        status: 'fail',
        detail: `sessionId ${sessionId} disagrees on ${disagreements.join(', ')}`,
      });
    }
  }

  return Object.freeze({ status: 'pass', detail: 'contract and enrichment shared fields agree' });
}
