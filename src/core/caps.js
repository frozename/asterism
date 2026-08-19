export const UNKNOWN = 'unknown';

export const AXES = Object.freeze({
  identity: Object.freeze(['Assignable', 'AgentAsserted', 'RegistryFile', 'HookStdin', 'SidecarFile', 'Scraped']),
  binding: Object.freeze(['SpawnMinted', 'AgentAsserted', 'HumanAsserted', 'VendorRegistry', 'HeuristicOnly', 'None']),
  activitySignal: Object.freeze(['PushHook', 'RegistryField', 'None']),
  ipcChannel: Object.freeze(['Authenticated', 'Unauthenticated', 'None']),
  preTurnContext: Object.freeze(['PerTurn', 'SessionStartOnly', 'PostToolOnly', 'None']),
  keyModel: Object.freeze(['Probed']),
  hookTrust: Object.freeze(['HashPinned', 'Fingerprinted', 'None']),
  configMerge: Object.freeze([
    'SkillsDir',
    'Plugin',
    'LaunchFlag',
    'AppendArray',
    'AppendFile',
    'MergeKeys',
    'MarkerBlock',
    'ShadowHome',
  ]),
  transcript: Object.freeze(['Jsonl', 'Export', 'None']),
});

export const GRADES = Object.freeze(['C-me', 'C', 'I']);

export const GATED_AXES_BY_PHASE = Object.freeze({
  1: Object.freeze(['identity', 'binding', 'activitySignal', 'configMerge', 'hookTrust']),
});

const AXIS_NAMES = Object.freeze(Object.keys(AXES));
const ENTRY_KEYS = Object.freeze(['value', 'evidence']);
const UNKNOWN_EVIDENCE_KEYS = Object.freeze(['probe', 'deferredTo']);
const RUNG_EVIDENCE_KEYS = Object.freeze(['grade', 'probe', 'observedOn']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function rank(axis, value) {
  const rungs = AXES[axis];
  if (!rungs) throw new Error(`caps: unknown axis "${axis}"`);
  if (value === UNKNOWN) return Infinity;

  const index = rungs.indexOf(value);
  if (index === -1) throw new Error(`caps: "${value}" is not a rung of axis "${axis}"`);
  return index;
}

export function atLeast(axis, value, floor) {
  if (floor === UNKNOWN) throw new Error(`caps: floor cannot be "${UNKNOWN}" for axis "${axis}"`);
  const floorRank = rank(axis, floor);
  const valueRank = rank(axis, value);
  return valueRank <= floorRank;
}

function isPlainObject(candidate) {
  return candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate);
}

function rejectExtraKeys(prefix, actualKeys, allowedKeys) {
  const extra = actualKeys.filter((key) => !allowedKeys.includes(key));
  if (extra.length > 0) throw new Error(`${prefix} has extra key "${extra[0]}"`);
}

export function validateRecord(record) {
  if (!isPlainObject(record)) throw new Error('caps: record must be a plain object');

  const recordKeys = Object.keys(record);
  const missing = AXIS_NAMES.filter((axis) => !Object.hasOwn(record, axis));
  if (missing.length > 0) throw new Error(`caps: record is missing axis "${missing[0]}"`);
  rejectExtraKeys('caps: record', recordKeys, AXIS_NAMES);

  for (const axis of AXIS_NAMES) {
    const entry = record[axis];
    if (!isPlainObject(entry)) throw new Error(`caps: axis "${axis}" must be an object with value/evidence`);
    rejectExtraKeys(`caps: axis "${axis}"`, Object.keys(entry), ENTRY_KEYS);
    if (!Object.hasOwn(entry, 'value')) throw new Error(`caps: axis "${axis}" is missing "value"`);
    if (!Object.hasOwn(entry, 'evidence')) throw new Error(`caps: axis "${axis}" is missing "evidence"`);

    const { value, evidence } = entry;
    const rungs = AXES[axis];
    const isUnknown = value === UNKNOWN;
    if (!isUnknown && !rungs.includes(value)) {
      throw new Error(`caps: axis "${axis}" has invalid value "${value}"`);
    }
    if (!isPlainObject(evidence)) throw new Error(`caps: axis "${axis}" evidence must be an object`);

    if (isUnknown) {
      rejectExtraKeys(`caps: axis "${axis}" unknown evidence`, Object.keys(evidence), UNKNOWN_EVIDENCE_KEYS);
      if (typeof evidence.probe !== 'string' || evidence.probe.length === 0) {
        throw new Error(`caps: axis "${axis}" unknown evidence is missing a non-empty probe`);
      }
      if (typeof evidence.deferredTo !== 'string' || evidence.deferredTo.length === 0) {
        throw new Error(`caps: axis "${axis}" unknown evidence is missing deferredTo`);
      }
    } else {
      rejectExtraKeys(`caps: axis "${axis}" evidence`, Object.keys(evidence), RUNG_EVIDENCE_KEYS);
      if (!GRADES.includes(evidence.grade)) {
        throw new Error(`caps: axis "${axis}" has invalid grade "${evidence.grade}"`);
      }
      if (typeof evidence.probe !== 'string' || evidence.probe.length === 0) {
        throw new Error(`caps: axis "${axis}" evidence is missing a non-empty probe`);
      }
      if (typeof evidence.observedOn !== 'string' || !DATE_PATTERN.test(evidence.observedOn)) {
        throw new Error(`caps: axis "${axis}" has a malformed observedOn date`);
      }
    }
  }

  return record;
}

export function unknownAxes(record) {
  validateRecord(record);

  const results = [];
  for (const axis of AXIS_NAMES) {
    const entry = record[axis];
    if (entry.value === UNKNOWN) {
      results.push({ axis, probe: entry.evidence.probe, deferredTo: entry.evidence.deferredTo });
    }
  }
  return results;
}

export function gatedUnknowns(record, phase) {
  const gatedAxes = GATED_AXES_BY_PHASE[phase];
  if (!gatedAxes) throw new Error(`caps: no gated-axes entry for phase ${phase}`);
  return unknownAxes(record).filter((entry) => gatedAxes.includes(entry.axis));
}

function parseVersion(input) {
  if (typeof input !== 'string') return null;

  let stripped = input.startsWith('v') ? input.slice(1) : input;
  const dashIndex = stripped.indexOf('-');
  if (dashIndex !== -1) stripped = stripped.slice(0, dashIndex);
  if (stripped.length === 0) return null;

  const numbers = [];
  for (const part of stripped.split('.')) {
    if (!/^\d+$/.test(part)) return null;
    numbers.push(parseInt(part, 10));
  }
  return numbers;
}

export function compareVersions(a, b) {
  const partsA = parseVersion(a);
  const partsB = parseVersion(b);
  if (partsA === null || partsB === null) return null;

  const length = Math.max(partsA.length, partsB.length);
  for (let index = 0; index < length; index += 1) {
    const na = partsA[index] ?? 0;
    const nb = partsB[index] ?? 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}
