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
  Object.freeze({
    cell: 'claude/hook/session-start',
    provoke:
      'configure a session-start hook that copies its stdin payload to a file of your choosing, trigger a live session start, then pass that file with --from',
    source: 'manual',
    cliVersionArgv: CLI_VERSION_ARGV,
  }),
  Object.freeze({
    cell: 'claude/transcript',
    provoke:
      "let a live session accumulate turns, copy the session's own transcript file (wherever the CLI keeps it) to a file of your choosing, then pass that file with --from",
    source: 'manual',
    cliVersionArgv: CLI_VERSION_ARGV,
  }),
  Object.freeze({
    cell: 'claude/screen/permission-prompt',
    provoke:
      'provoke a live tool-use permission prompt, run `tmux capture-pane -p -e` on the pane showing it, save the output to a file, then pass that file with --from',
    source: 'manual',
    cliVersionArgv: CLI_VERSION_ARGV,
  }),
  Object.freeze({
    cell: 'claude/screen/picker',
    provoke:
      'open a live model or session picker, run `tmux capture-pane -p -e` on the pane showing it, save the output to a file, then pass that file with --from',
    source: 'manual',
    cliVersionArgv: CLI_VERSION_ARGV,
  }),
  Object.freeze({
    cell: 'claude/screen/trust-gate',
    provoke:
      'start from a fresh config to reach the first-run trust gate, run `tmux capture-pane -p -e` on the pane showing it, save the output to a file, then pass that file with --from',
    source: 'manual',
    cliVersionArgv: CLI_VERSION_ARGV,
  }),
  Object.freeze({
    cell: 'claude/screen/narrow',
    provoke:
      'resize a live session to a narrow column count, run `tmux capture-pane -p -e` on the pane, save the output to a file, then pass that file with --from',
    source: 'manual',
    cliVersionArgv: CLI_VERSION_ARGV,
  }),
  // --- T7: the liveness clock pair
  Object.freeze({
    cell: 'claude/ps-lstart',
    provoke:
      'with at least one live session, run `ps -o pid=,lstart= -p <registry pids>` (comma-joined pids taken ' +
      'from the session registry filenames) at the same instant as the registry cells are captured, save the ' +
      'output to a file, and pass it with --from; include the token TZ=<Area/City> (the machine IANA timezone, ' +
      'for example TZ=America/Sao_Paulo) in the --provoked-by text — the golden pairing test reads it',
    source: 'manual',
    cliVersionArgv: CLI_VERSION_ARGV,
  }),
]);
