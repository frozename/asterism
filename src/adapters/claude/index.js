import { captures, profileFile } from './captures.js';
import { discovery } from './discover.js';
import { hookSupport } from './hooks.js';
import { installSupport } from './install.js';
import { resumeArgv, spawnArgv } from './spawn.js';
import { compareVersions, rank, UNKNOWN, validateRecord } from '../../core/caps.js';

function binaryCandidates(home) {
  return [{ dir: `${home}/.local/share/claude/versions`, pick: 'newest' }];
}

export const measuredOn = Object.freeze({ cliVersion: '2.1.235' });

function rung(value, grade, probe, observedOn = '2026-08-18') {
  return Object.freeze({ value, evidence: Object.freeze({ grade, probe, observedOn }) });
}

function unresolved(probe, deferredTo) {
  return Object.freeze({ value: UNKNOWN, evidence: Object.freeze({ probe, deferredTo }) });
}

export const capabilities = Object.freeze(
  validateRecord({
    identity: rung(
      'Assignable',
      'C-me',
      '`claude --session-id <uuid>` is accepted at launch (asterism can mint the id); a hand-started session ' +
        'still reaches RegistryFile by reading $HOME/.claude/sessions/<pid>.json, named by the CLI pid and ' +
        'carrying sessionId',
    ),
    binding: rung(
      'AgentAsserted',
      'C-me',
      "the SessionStart hook's stdin carries session_id and the environment carries CLAUDE_CODE_SESSION_ID, " +
        'TMUX_PANE, TMUX; the registry file\'s tmux field (session:@window.%pane) is a weaker VendorRegistry ' +
        'witness that must be qualified by the tmux server before use',
      '2026-08-19',
    ),
    activitySignal: rung('RegistryField', 'C-me', '`claude agents --json` rows carry status, and a waiting session adds waitingFor'),
    ipcChannel: unresolved(
      'Probe F: read one frame from a live per-session socket under /tmp/cc-socks/ (mode srw-------), from a session you own',
      'Phase 4',
    ),
    preTurnContext: rung('PerTurn', 'C', 'the UserPromptSubmit hook fires every turn'),
    keyModel: rung(
      'Probed',
      'C-me',
      'in a live tmux pane, `send-keys -l -- <text>` lands text and Enter does NOT submit it; C-m submits',
    ),
    hookTrust: rung('None', 'C', 'hooks in settings are not hash-pinned or fingerprinted'),
    configMerge: rung(
      'SkillsDir',
      'C-me',
      'a skills-dir plugin is loaded without touching ~/.claude/settings.json',
      '2026-08-19',
    ),
    transcript: rung('Jsonl', 'C', 'per-session JSONL transcripts'),
  }),
);

export function detect(facts) {
  return Object.freeze({
    present: facts.cliPresent,
    version: facts.cliVersion,
    registryReadable: facts.registryReadable,
  });
}

function unknownEverywhere(probe, deferredTo) {
  const record = Object.fromEntries(Object.keys(capabilities).map((axis) => [axis, unresolved(probe, deferredTo)]));
  return Object.freeze(validateRecord(record));
}

function degradeCMeAxes(record) {
  const next = { ...record };
  for (const axis of Object.keys(next)) {
    const entry = next[axis];
    if (entry.value !== UNKNOWN && entry.evidence.grade === 'C-me') {
      next[axis] = unresolved(
        `measured on cliVersion ${measuredOn.cliVersion}; the installed build is different (or could not be ` +
          'read) and this axis must be re-probed on it',
        'Phase 1',
      );
    }
  }
  return next;
}

function degradeForUnreadableRegistry(record) {
  const next = { ...record };

  if (next.identity.value !== UNKNOWN && rank('identity', next.identity.value) < rank('identity', 'HookStdin')) {
    next.identity = rung(
      'HookStdin',
      next.identity.evidence.grade,
      `${next.identity.evidence.probe}; the session registry file is unreadable, so identity falls back to the hook's stdin session id`,
      next.identity.evidence.observedOn,
    );
  }

  if (next.binding.value !== UNKNOWN && rank('binding', next.binding.value) < rank('binding', 'AgentAsserted')) {
    next.binding = rung(
      'AgentAsserted',
      next.binding.evidence.grade,
      `${next.binding.evidence.probe}; capped at AgentAsserted because the session registry is unreadable to confirm a stronger binding`,
      next.binding.evidence.observedOn,
    );
  }

  return next;
}

export function effectiveCapabilities(detected) {
  if (detected.present === false) {
    return unknownEverywhere('install the CLI and re-run ast probe', 'Phase 1');
  }

  let working = { ...capabilities };

  const versionCmp = compareVersions(detected.version, measuredOn.cliVersion);
  if (versionCmp === null || versionCmp < 0) {
    working = degradeCMeAxes(working);
  }

  if (detected.registryReadable === false) {
    working = degradeForUnreadableRegistry(working);
  }

  return Object.freeze(validateRecord(working));
}

export const detectSamples = Object.freeze({
  full: Object.freeze({ cliPresent: true, cliVersion: measuredOn.cliVersion, registryReadable: true }),
  lockedDown: Object.freeze({ cliPresent: true, cliVersion: measuredOn.cliVersion, registryReadable: false }),
  oldVersion: Object.freeze({ cliPresent: true, cliVersion: '0.0.1', registryReadable: true }),
});

export default Object.freeze({
  id: 'claude',
  ...discovery,
  ...hookSupport,
  ...installSupport,
  captures,
  profileFile,
  resumeArgv,
  spawnArgv,
  measuredOn,
  capabilities,
  detect,
  effectiveCapabilities,
  detectSamples,
  agentEnvMarkers: Object.freeze([
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_PID',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_PROJECT_DIR',
    'CLAUDE_PLUGIN_ROOT',
    'CLAUDE_PLUGIN_DATA',
    'CLAUDE_ENV_FILE',
    'CLAUDE_CODE_ENABLE_TELEMETRY',
  ]),
  staticProbe: Object.freeze({
    binaryCandidates,
    symbols: Object.freeze([
      'procStart',
      'waitingFor',
      'statusUpdatedAt',
      'messagingSocketPath',
      '"waiting"',
      '"idle"',
      '"busy"',
      '"completed"',
      '"dead"',
    ]),
  }),
});
