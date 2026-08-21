import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { emitNotes } from '../notes.js';
import { createUlidMinter } from '../../core/ulid.js';
import { createUuidMinter } from '../../core/uuid.js';
import { openStore } from '../../io/store.js';
import { newWindow, serverInfo } from '../../io/tmuxexec.js';
import { resolveServers } from '../../io/tmuxsock.js';

export const mutating = true;
export const summary = 'launch an agent in a new tmux window with an authoritative binding';

const USAGE = 'usage: ast new [cwd] [--switch]\n';

function refusal(message) {
  process.stderr.write(`${message}\n`);
  return 1;
}

export function parseArgs(argv) {
  let cwd = null;
  let switchWindow = false;
  for (const arg of argv) {
    if (arg === '--switch') {
      if (switchWindow) return null;
      switchWindow = true;
    } else {
      if (arg.startsWith('--') || cwd !== null) return null;
      cwd = arg;
    }
  }
  return { cwd: path.resolve(cwd ?? process.cwd()), switchWindow };
}

export function selectAdapter(adapters) {
  const entries = [...adapters.entries()];
  if (entries.length === 1) return { adapter: entries[0][1] };
  const ids = entries.map(([id]) => id).sort();
  return { error: `ast new requires one adapter; found ${ids.join(', ') || 'none'}; a future --adapter option is required` };
}

function provenance(at) {
  return Object.freeze({ source: 'spawn-minted', confidence: 'authoritative', at });
}

function unboundRecord({ id, adapter, sessionId, cwd, now }) {
  const prov = provenance(now);
  return Object.freeze({
    id,
    adapter,
    agent: Object.freeze({
      sessionId,
      name: null,
      cwd,
      gitRoot: null,
      branch: null,
      headSha: null,
      pid: null,
      procStartEpoch: null,
      host: null,
      bootId: null,
    }),
    binding: null,
    state: 'Unbound',
    observed: Object.freeze({ status: null, waitingFor: null, lastSeen: now, generation: 0 }),
    flags: Object.freeze({ parked: false, attentionStuck: false, writeDisabled: false, reason: null }),
    prov: Object.freeze({ sessionId: prov, cwd: prov, state: prov }),
  });
}

export async function run(argv, ctx) {
  const options = parseArgs(argv);
  if (options === null) {
    process.stderr.write(USAGE);
    return 2;
  }

  const selected = selectAdapter(ctx.adapters);
  if (selected.error) return refusal(selected.error);

  const findServers = ctx.resolveServers ?? resolveServers;
  const serverNotes = [];
  const servers = await findServers({
    env: ctx.env,
    uid: process.getuid(),
    probe: ({ socketPath, env }) => serverInfo({ socketPath, env, execute: ctx.execute }),
    notes: serverNotes,
  });
  emitNotes(serverNotes);
  if (servers.length === 0) return refusal('ast new: no tmux server is reachable');
  const server = servers[0];

  const mintUlid = createUlidMinter({ now: Date.now, random: randomBytes });
  const mintUuid = createUuidMinter({ random: randomBytes });
  const id = mintUlid();
  const sessionId = mintUuid();
  const now = Date.now();
  const record = unboundRecord({ id, adapter: selected.adapter.id, sessionId, cwd: options.cwd, now });
  const store = await openStore({ env: ctx.env });
  await store.writeSession(id, record);

  const command = selected.adapter.spawnArgv({ sessionId });
  const paneId = await newWindow({
    cwd: options.cwd,
    command,
    detached: !options.switchWindow,
    socketPath: server.socketPath,
    env: ctx.env,
    execute: ctx.execute,
  });

  const at = new Date(Date.now()).toISOString();
  await store.writeBinding(mintUlid(), {
    sessionId,
    adapter: selected.adapter.id,
    by: 'SpawnMinted',
    target: paneId,
    socketPath: server.socketPath,
    serverPid: server.serverPid,
    at,
  });

  const binding = Object.freeze({
    serverPid: server.serverPid,
    tmuxSession: null,
    windowId: null,
    paneId,
    by: 'SpawnMinted',
    at,
  });
  const boundProv = provenance(Date.now());
  const bound = Object.freeze({
    ...record,
    binding,
    state: 'Bound',
    prov: Object.freeze({ ...record.prov, binding: boundProv, state: boundProv }),
  });
  await store.writeSession(id, bound);

  if (!options.switchWindow) process.stdout.write(`${id} ${paneId}\n`);
  return 0;
}
