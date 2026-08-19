const CLI_VERSION_ARGV = Object.freeze(['claude', '--version']);

export function profileFile(home) {
  return `${home}/.claude/settings.json`;
}

function sessionsGlob(home) {
  return `${home}/.claude/sessions/*.json`;
}

export const captures = Object.freeze([
  Object.freeze({
    cell: 'claude/help',
    provoke: 'none',
    source: 'argv',
    argv: Object.freeze(['claude', '--help']),
    cliVersionArgv: CLI_VERSION_ARGV,
  }),
  Object.freeze({
    cell: 'claude/agents-json/idle',
    provoke: 'at least one session in the idle state',
    source: 'argv',
    argv: Object.freeze(['claude', 'agents', '--json']),
    cliVersionArgv: CLI_VERSION_ARGV,
  }),
  Object.freeze({
    cell: 'claude/agents-json/busy',
    provoke: 'at least one session in the busy state',
    source: 'argv',
    argv: Object.freeze(['claude', 'agents', '--json']),
    cliVersionArgv: CLI_VERSION_ARGV,
  }),
  Object.freeze({
    cell: 'claude/agents-json/waiting',
    provoke: 'at least one session in the waiting state',
    source: 'argv',
    argv: Object.freeze(['claude', 'agents', '--json']),
    cliVersionArgv: CLI_VERSION_ARGV,
  }),
  Object.freeze({
    cell: 'claude/registry/idle',
    provoke: 'at least one registry entry in the idle state',
    source: 'file',
    file: sessionsGlob,
    cliVersionArgv: CLI_VERSION_ARGV,
  }),
  Object.freeze({
    cell: 'claude/registry/busy',
    provoke: 'at least one registry entry in the busy state',
    source: 'file',
    file: sessionsGlob,
    cliVersionArgv: CLI_VERSION_ARGV,
  }),
  Object.freeze({
    cell: 'claude/registry/waiting',
    provoke: 'at least one registry entry in the waiting state',
    source: 'file',
    file: sessionsGlob,
    cliVersionArgv: CLI_VERSION_ARGV,
  }),
  Object.freeze({
    cell: 'claude/registry/null-status',
    provoke: 'at least one registry entry with a null status',
    source: 'file',
    file: sessionsGlob,
    cliVersionArgv: CLI_VERSION_ARGV,
  }),
]);
