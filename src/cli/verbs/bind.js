import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { emitNotes } from '../notes.js';
import { collectSessions, resolveSessionRef } from '../pipeline.js';
import { createUlidMinter } from '../../core/ulid.js';
import { openStore } from '../../io/store.js';
import { listPanes, serverInfo } from '../../io/tmuxexec.js';
import { resolveServers } from '../../io/tmuxsock.js';

export const mutating = true;
export const summary = 'bind an agent session to a tmux pane';

const PANE_ID = /^%\d+$/;
const USAGE = 'usage: ast bind <sessionRef> <paneId>\n';

function refusal(message) {
  process.stderr.write(`${message}\n`);
  return 1;
}

export function qualifyPaneServer(servers, panesByServer, paneId) {
  const carriers = servers.filter((server) =>
    (panesByServer.get(server.socketPath) ?? []).some((row) => row.paneId === paneId && row.paneDead === '0'),
  );
  if (carriers.length === 0) return { error: `pane ${paneId} not found on any reachable server` };
  if (carriers.length > 1) {
    return { error: `ambiguous pane ${paneId}: ${carriers.map((server) => `${server.socketPath} (serverPid ${server.serverPid})`).join(', ')}` };
  }
  return { server: carriers[0] };
}

export async function run(argv, ctx) {
  if (argv.length !== 2) {
    process.stderr.write(USAGE);
    return 2;
  }
  const [sessionRef, paneId] = argv;
  if (!PANE_ID.test(paneId)) return refusal(`pane id "${paneId}" does not match ^%\\d+$`);

  const store = await openStore({ env: ctx.env });
  const { records } = await collectSessions({ env: ctx.env, adapters: ctx.adapters, home: os.homedir(), store });
  const resolved = resolveSessionRef(records, sessionRef);
  if (resolved.error) return refusal(resolved.error);

  let server;
  if (typeof ctx.env.TMUX === 'string' && ctx.env.TMUX.length > 0) {
    const [socketPath, pidText] = ctx.env.TMUX.split(',');
    const expectedPid = Number(pidText);
    const probed = await serverInfo({ socketPath, env: ctx.env });
    if (probed.ok !== true) return refusal(probed.reason);
    if (!Number.isInteger(expectedPid) || probed.pid !== expectedPid) {
      return refusal(`tmux server pid mismatch: environment ${pidText}, probed ${probed.pid}`);
    }
    server = Object.freeze({ socketPath: probed.socketPath, serverPid: expectedPid, version: probed.version });
    const listed = await listPanes({ socketPath: server.socketPath, env: ctx.env });
    if (listed.ok !== true) return refusal(listed.reason);
    if (!listed.rows.some((row) => row.paneId === paneId && row.paneDead === '0')) {
      return refusal(`pane ${paneId} not found or dead on serverPid ${server.serverPid}`);
    }
  } else {
    const serverNotes = [];
    const servers = await resolveServers({
      env: ctx.env,
      uid: process.getuid(),
      probe: ({ socketPath, env }) => serverInfo({ socketPath, env }),
      notes: serverNotes,
    });
    emitNotes(serverNotes);
    const panesByServer = new Map();
    for (const candidate of servers) {
      const listed = await listPanes({ socketPath: candidate.socketPath, env: ctx.env });
      if (listed.ok !== true) return refusal(listed.reason);
      panesByServer.set(candidate.socketPath, listed.rows);
    }
    const qualified = qualifyPaneServer(servers, panesByServer, paneId);
    if (qualified.error) return refusal(qualified.error);
    server = qualified.server;
  }

  const now = Date.now();
  const mint = createUlidMinter({ now: Date.now, random: randomBytes });
  const record = resolved.record;
  await store.writeBinding(mint(), {
    sessionId: record.agent.sessionId,
    adapter: record.adapter,
    by: 'HumanAsserted',
    target: paneId,
    socketPath: server.socketPath,
    serverPid: server.serverPid,
    at: new Date(now).toISOString(),
  });
  process.stdout.write(`${record.agent.sessionId} bound to ${paneId} on serverPid ${server.serverPid} (human-asserted)\n`);
  return 0;
}
