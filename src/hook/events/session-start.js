import { createUlidMinter } from '../../core/ulid.js';

export async function run({ adapter, adapterId, payload, env, store, now, random }) {
  const parsed = adapter.hooks.parseSessionStart(payload, env);
  if (parsed === null) {
    const payloadId = payload?.session_id;
    const envId = env[adapter.hooks.sessionIdEnvVar];
    if (typeof payloadId === 'string' && typeof envId === 'string' && envId.length > 0 && envId !== payloadId) {
      await store.appendHookError(
        `${new Date(now()).toISOString()} ast-hook ${adapterId}/session-start: session id mismatch ` +
          `(payload ${payloadId.slice(0, 8)}, env ${envId.slice(0, 8)})`,
      );
    }
    return;
  }

  if (parsed.tmux === null) return;

  const mint = createUlidMinter({ now, random });
  const record = Object.freeze({
    sessionId: parsed.sessionId,
    adapter: adapterId,
    by: 'AgentAsserted',
    target: parsed.tmux.paneId,
    socketPath: parsed.tmux.socketPath,
    serverPid: parsed.tmux.serverPid,
    source: parsed.source,
    cwd: parsed.cwd,
    at: new Date(now()).toISOString(),
  });
  await store.writeBinding(mint(), record);
}
