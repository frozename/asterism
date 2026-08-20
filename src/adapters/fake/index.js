import { readdir, readFile } from 'node:fs/promises';
import { UNKNOWN, validateRecord } from '../../core/caps.js';

const BY_CONSTRUCTION = 'by construction — read src/adapters/fake/index.js';

export const measuredOn = Object.freeze({ cliVersion: null });

function rung(value) {
  return Object.freeze({
    value,
    evidence: Object.freeze({ grade: 'C-me', probe: BY_CONSTRUCTION, observedOn: '2026-08-19' }),
  });
}

function unresolved(probe) {
  return Object.freeze({ value: UNKNOWN, evidence: Object.freeze({ probe, deferredTo: 'never' }) });
}

export const capabilities = Object.freeze(
  validateRecord({
    identity: rung('SidecarFile'),
    binding: rung('HeuristicOnly'),
    activitySignal: rung('None'),
    ipcChannel: rung('None'),
    preTurnContext: rung('None'),
    keyModel: unresolved('the fake has no keyboard'),
    hookTrust: rung('None'),
    configMerge: unresolved('the fake has no config to merge into'),
    transcript: rung('None'),
  }),
);

export function detect(facts) {
  return Object.freeze({
    present: typeof facts.root === 'string' && facts.root.length > 0,
    version: null,
  });
}

export function effectiveCapabilities(detected) {
  if (detected.present === false) {
    const record = Object.fromEntries(
      Object.keys(capabilities).map((axis) => [axis, unresolved('the fake root is not set')]),
    );
    return Object.freeze(validateRecord(record));
  }

  return capabilities;
}

export const detectSamples = Object.freeze({
  full: Object.freeze({ root: '/vectors/fake' }),
  lockedDown: Object.freeze({ root: null }),
  oldVersion: Object.freeze({ root: null }),
});

function binaryCandidates(home) {
  return [{ dir: `${home}/.fake/bin`, pick: 'newest' }];
}

export async function discover({ env }) {
  const root = env?.ASTERISM_FAKE_ROOT;
  if (typeof root !== 'string' || root.length === 0) return [];

  const sessionsDir = `${root}/sessions`;
  let names;
  try {
    names = await readdir(sessionsDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const rows = [];
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(`${sessionsDir}/${name}`, 'utf8'));
    } catch (error) {
      throw new Error(`fake discovery: ${name}: ${error.message}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`fake discovery: ${name}: record must be an object`);
    }
    const { id, ...rest } = parsed;
    rows.push(Object.freeze({ sessionId: id, ...rest }));
  }
  return Object.freeze(rows);
}

export default Object.freeze({
  id: 'fake',
  discover,
  captures: Object.freeze([]),
  measuredOn,
  capabilities,
  detect,
  effectiveCapabilities,
  detectSamples,
  agentEnvMarkers: Object.freeze(['ASTERISM_FAKE_AGENT']),
  staticProbe: Object.freeze({
    binaryCandidates,
    symbols: Object.freeze(['fake-session']),
  }),
});
