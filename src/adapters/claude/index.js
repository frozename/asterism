function binaryCandidates(home) {
  return [{ dir: `${home}/.local/share/claude/versions`, pick: 'newest' }];
}

export default Object.freeze({
  id: 'claude',
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
      'waiting',
      'idle',
      'busy',
      'completed',
      'dead',
    ]),
  }),
});
