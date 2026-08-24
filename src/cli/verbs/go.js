import os from 'node:os';
import { emitNotes } from '../notes.js';
import { collectSessions, resolveSessionRef } from '../pipeline.js';
import { descendsFrom, parseVendorPaneWitness, STRONG_WITNESSES, WEAK_WITNESSES } from '../../core/binding.js';
import { ancestry } from '../../io/procs.js';
import { openStore, readBindings } from '../../io/store.js';
import { attachSessionForeground, listClients, listPanes, serverInfo, switchClient } from '../../io/tmuxexec.js';
import { resolveServers } from '../../io/tmuxsock.js';

export const mutating = true;
export const summary = 'move a tmux client to an agent session';

const USAGE = 'usage: ast go [<sessionRef>] [--client <name>]\n';
const CONFIDENCE = Object.freeze({
  SpawnMinted: 'spawn-minted',
  AgentAsserted: 'agent-asserted',
  HumanAsserted: 'human-asserted',
  VendorRegistry: 'vendor-registry (server-qualified)',
  Heuristic: 'heuristic match',
});

function parseArgs(argv) {
  let ref = null;
  let client = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--client') {
      if (client !== null || typeof argv[index + 1] !== 'string' || argv[index + 1].startsWith('--')) return null;
      client = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('-') || ref !== null) {
      return null;
    } else {
      ref = arg;
    }
  }
  return { ref, client };
}

function refusal(message) {
  process.stderr.write(`${message}\n`);
  return 1;
}

function bindingRank(binding) {
  if (STRONG_WITNESSES.includes(binding.by)) return 0;
  if (WEAK_WITNESSES.includes(binding.by)) return 1;
  return 2;
}

function pickBinding(entries, record) {
  return entries
    .map((entry) => entry.record)
    .filter((binding) => binding.sessionId === record.agent.sessionId && binding.adapter === record.adapter && bindingRank(binding) < 2)
    .sort((a, b) => bindingRank(a) - bindingRank(b) || (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))[0] ?? null;
}

export function chooseClient(rows, { override }) {
  const names = rows.map((row) => row.clientName).sort();
  if (override !== null && override !== undefined) {
    if (!names.includes(override)) {
      return { error: `unknown client "${override}"; known clients: ${names.length === 0 ? '(none)' : names.join(', ')}` };
    }
    return { clientName: override };
  }
  if (rows.length === 0) return { clientName: null };
  const chosen = [...rows].sort((a, b) => Number(b.clientActivity) - Number(a.clientActivity) || a.clientName.localeCompare(b.clientName))[0];
  return { clientName: chosen.clientName };
}

export function qualifyCandidate({ record, panes, pidTable, serverPid, witness }) {
  const parsed = parseVendorPaneWitness(witness);
  if (parsed !== null && panes.some((row) => row.paneId === parsed.paneId && row.paneDead === '0')) {
    return { paneId: parsed.paneId, by: 'VendorRegistry' };
  }

  const agentPid = record.agent.pid;
  if (!Number.isInteger(agentPid)) return null;
  for (const row of panes) {
    const panePid = Number(row.panePid);
    if (
      row.paneDead === '0' &&
      Number.isInteger(panePid) &&
      descendsFrom(pidTable, agentPid, panePid) &&
      descendsFrom(pidTable, panePid, serverPid)
    ) {
      return { paneId: row.paneId, by: 'Heuristic' };
    }
  }
  return null;
}

async function jump({ env, record, socketPath, paneId, by, clientOverride }) {
  const confidence = CONFIDENCE[by];
  if (typeof env.TMUX === 'string' && env.TMUX.length > 0) {
    const outcome = await switchClient({ clientName: undefined, target: paneId, socketPath, env });
    if (outcome.code !== 0) return refusal(`switch-client exited ${outcome.code}`);
    process.stdout.write(`${record.agent.sessionId} -> ${paneId} (${confidence})\n`);
    return 0;
  }

  const listed = await listClients({ socketPath, env });
  if (listed.ok !== true) return refusal(listed.reason);
  const chosen = chooseClient(listed.rows, { override: clientOverride });
  if (chosen.error) return refusal(chosen.error);

  if (chosen.clientName === null) {
    process.stdout.write(`${record.agent.sessionId} -> ${paneId} (${confidence}); attach-session will block this terminal\n`);
    return attachSessionForeground(paneId, { socketPath, env });
  }

  const outcome = await switchClient({ clientName: chosen.clientName, target: paneId, socketPath, env });
  if (outcome.code !== 0) return refusal(`switch-client exited ${outcome.code}`);
  process.stdout.write(`${record.agent.sessionId} -> ${paneId} via client ${chosen.clientName} (${confidence})\n`);
  return 0;
}

export async function run(argv, ctx) {
  const options = parseArgs(argv);
  if (options === null) {
    process.stderr.write(USAGE);
    return 2;
  }

  const store = await openStore({ env: ctx.env });
  const { records, notes } = await collectSessions({ env: ctx.env, adapters: ctx.adapters, home: os.homedir(), store });
  emitNotes(notes);
  if (records.length === 0) return refusal('no sessions');
  const resolved = options.ref === null ? { record: records[0] } : resolveSessionRef(records, options.ref);
  if (resolved.error) return refusal(resolved.error);
  const record = resolved.record;

  const bindings = await readBindings(store.stateDir);
  const binding = pickBinding(bindings.records, record);
  const serverNotes = [];
  const servers = await resolveServers({
    env: ctx.env,
    uid: process.getuid(),
    probe: ({ socketPath, env }) => serverInfo({ socketPath, env }),
    notes: serverNotes,
  });
  emitNotes(serverNotes);
  if (servers.length === 0) return refusal('no tmux server reachable');

  if (binding !== null) {
    const server = servers.find((candidate) => candidate.serverPid === binding.serverPid);
    if (server === undefined) return refusal(`no tmux server reachable for binding serverPid ${binding.serverPid}`);
    const listed = await listPanes({ socketPath: server.socketPath, env: ctx.env });
    if (listed.ok !== true) return refusal(listed.reason);
    if (!listed.rows.some((row) => row.paneId === binding.target && row.paneDead === '0')) {
      return refusal(`pane ${binding.target} is missing or dead on serverPid ${binding.serverPid}`);
    }
    if (typeof ctx.env.TMUX === 'string' && ctx.env.TMUX.length > 0) {
      const invokingPid = Number(ctx.env.TMUX.split(',')[1]);
      const invokingServer = servers.find((candidate) => candidate.serverPid === invokingPid);
      if (invokingServer === undefined || invokingServer.socketPath !== server.socketPath) {
        return refusal(`cannot switch across tmux servers to binding serverPid ${binding.serverPid}`);
      }
    }
    return jump({ env: ctx.env, record, socketPath: server.socketPath, paneId: binding.target, by: binding.by, clientOverride: options.client });
  }

  const processes = await ancestry({ env: ctx.env });
  for (const server of servers) {
    const listed = await listPanes({ socketPath: server.socketPath, env: ctx.env });
    if (listed.ok !== true) return refusal(listed.reason);
    const candidate = qualifyCandidate({ record, panes: listed.rows, pidTable: processes.table, serverPid: server.serverPid, witness: null });
    if (candidate !== null) {
      return jump({ env: ctx.env, record, socketPath: server.socketPath, paneId: candidate.paneId, by: candidate.by, clientOverride: options.client });
    }
  }
  return refusal(`no pane binding for ${record.agent.sessionId}; run ast bind ${options.ref ?? record.agent.sessionId} <paneId>`);
}
