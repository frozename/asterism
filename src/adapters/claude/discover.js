import { KNOWN_FIELDS } from '../../core/reconcile.js';

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unknownKeys(records) {
  const keys = new Set();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!KNOWN_FIELDS.includes(key)) keys.add(key);
    }
  }
  return Object.freeze([...keys].sort());
}

function parseError(error) {
  return error instanceof Error ? error.message : String(error);
}

export function discoverArgv() {
  return Object.freeze(['claude', 'agents', '--json']);
}

export function registryDir(home) {
  return `${home}/.claude/sessions`;
}

export const registryFilePattern = /^\d+\.json$/;

export const ENRICHMENT = Object.freeze({
  flag: 'registryEnrichment',
  requiredPeerProtocol: 1,
  maxFileBytes: 262144,
  provSource: 'registry-file',
});

export function parseAgentsJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return Object.freeze({
      rows: Object.freeze([]),
      unknownKeys: Object.freeze([]),
      error: `agents json parse failed: ${parseError(error)}`,
    });
  }

  if (!Array.isArray(parsed)) {
    return Object.freeze({
      rows: Object.freeze([]),
      unknownKeys: Object.freeze([]),
      error: 'agents json top level must be an array',
    });
  }

  const rows = [];
  let error = null;
  for (let index = 0; index < parsed.length; index += 1) {
    if (!isPlainObject(parsed[index])) {
      if (error === null) error = `agents json row at index ${index} must be a plain object`;
      continue;
    }
    rows.push(Object.freeze({ ...parsed[index] }));
  }

  return Object.freeze({ rows: Object.freeze(rows), unknownKeys: unknownKeys(rows), error });
}

export function parseRegistryRecord(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return Object.freeze({
      record: null,
      unknownKeys: Object.freeze([]),
      error: `registry json parse failed: ${parseError(error)}`,
    });
  }

  if (!isPlainObject(parsed)) {
    return Object.freeze({
      record: null,
      unknownKeys: Object.freeze([]),
      error: 'registry json top level must be a plain object',
    });
  }

  const record = Object.freeze({ ...parsed });
  return Object.freeze({ record, unknownKeys: unknownKeys([record]), error: null });
}

export const goldenCells = Object.freeze([
  'claude/agents-json/idle',
  'claude/agents-json/busy',
  'claude/agents-json/waiting',
  'claude/registry/idle',
  'claude/registry/busy',
  'claude/registry/waiting',
  'claude/registry/null-status',
  'claude/ps-lstart',
]);

export const discovery = Object.freeze({
  discoverArgv,
  registryDir,
  registryFilePattern,
  ENRICHMENT,
  parseAgentsJson,
  parseRegistryRecord,
  goldenCells,
});
