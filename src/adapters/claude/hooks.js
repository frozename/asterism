const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PANE_ID = /^%\d+$/;
const SESSION_SOURCES = new Set(['startup', 'resume', 'clear']);

function safeSessionId(value) {
  return typeof value === 'string' && SAFE_SESSION_ID.test(value) && !value.includes('..');
}

export function parseSessionStart(stdinObj, env) {
  try {
    const sessionId = stdinObj?.session_id;
    if (!safeSessionId(sessionId)) return null;

    const envSessionId = env?.CLAUDE_CODE_SESSION_ID;
    if (typeof envSessionId === 'string' && envSessionId.length > 0 && envSessionId !== sessionId) return null;

    const source = stdinObj?.source;
    if (!SESSION_SOURCES.has(source)) return null;

    let tmux = null;
    const paneId = env?.TMUX_PANE;
    const tmuxValue = env?.TMUX;
    if (typeof paneId === 'string' && PANE_ID.test(paneId) && typeof tmuxValue === 'string') {
      const fields = tmuxValue.split(',');
      const socketPath = fields[0];
      const serverPid = Number(fields[1]);
      if (socketPath.length > 0 && Number.isInteger(serverPid) && serverPid > 0) {
        tmux = Object.freeze({ paneId, socketPath, serverPid });
      }
    }

    return Object.freeze({ sessionId, source, cwd: stdinObj.cwd ?? null, tmux });
  } catch {
    return null;
  }
}

export function parseNotification(stdinObj) {
  try {
    const sessionId = stdinObj?.session_id;
    if (!safeSessionId(sessionId)) return null;

    const statusValue = stdinObj?.statusUpdatedAt;
    const statusUpdatedAt =
      typeof statusValue === 'string' || typeof statusValue === 'number' ? String(statusValue) : null;
    return Object.freeze({
      sessionId,
      message: typeof stdinObj.message === 'string' ? stdinObj.message : '',
      title: typeof stdinObj.title === 'string' ? stdinObj.title : null,
      waitingFor: typeof stdinObj.waitingFor === 'string' && stdinObj.waitingFor.length > 0 ? stdinObj.waitingFor : null,
      statusUpdatedAt,
    });
  } catch {
    return null;
  }
}

export const hookSupport = Object.freeze({
  hooks: Object.freeze({
    sessionIdEnvVar: 'CLAUDE_CODE_SESSION_ID',
    events: Object.freeze(['session-start', 'notification']),
    parseSessionStart,
    parseNotification,
  }),
});
