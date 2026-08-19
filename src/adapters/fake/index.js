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

export default Object.freeze({
  id: 'fake',
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
