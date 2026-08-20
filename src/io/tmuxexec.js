import { spawn } from 'node:child_process';
import path from 'node:path';
import { parseListClients, parseListPanes, parseServerInfo } from '../core/tmuxparse.js';
import { procexec } from './procexec.js';

export const TARGET_ID = /^[$@%]\d+$/;
export const FORMAT_REJECT = /[#;$\n\r\x00-\x1f]/;
export const LIST_PANES_FORMAT = '#{pane_id}|#{pane_pid}|#{session_id}|#{window_id}|#{pane_dead}|#{pane_mode}|#{@asterism_sid}';
export const LIST_CLIENTS_FORMAT = '#{client_name}|#{session_id}|#{client_activity}';

function assertValidTarget(target) {
  if (typeof target !== 'string' || !TARGET_ID.test(target)) {
    throw new Error(`target "${target}" does not match ${TARGET_ID}`);
  }
}

function assertTestSocketAllowed(socketPath, env) {
  if (env.ASTERISM_TEST === '1' && !path.basename(socketPath).startsWith('asterism-test')) {
    throw new Error(`ASTERISM_TEST=1 requires a socket basename starting with "asterism-test", got "${path.basename(socketPath)}"`);
  }
}

export function assertFormatSafe(value) {
  if (FORMAT_REJECT.test(value)) {
    throw new Error(`value contains a format-unsafe character: ${JSON.stringify(value)}`);
  }
}

// The only low-level tmux runner. -u is always applied so an LC_ALL=C client
// cannot mangle a -F row into a single dropped field (see the tab byte-diff
// invariant in test/tmux-l3.test.mjs); every -t target is validated before
// the spawn, never rewritten.
export async function execTmux(args, { socketPath, env, execute = procexec }) {
  assertTestSocketAllowed(socketPath, env);

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '-t') assertValidTarget(args[index + 1]);
  }

  return execute(['tmux', '-u', '-S', socketPath, ...args], { env });
}

export async function listPanes({ paneCount, ...opts } = {}) {
  const result = await execTmux(['list-panes', '-a', '-F', LIST_PANES_FORMAT], opts);
  return parseListPanes(result.stdout.toString('utf8'), { paneCount });
}

export async function listClients(opts = {}) {
  const result = await execTmux(['list-clients', '-F', LIST_CLIENTS_FORMAT], opts);
  return parseListClients(result.stdout.toString('utf8'));
}

export async function display(format, opts = {}) {
  const result = await execTmux(['display-message', '-p', format], opts);
  return result.stdout.toString('utf8').trim();
}

export async function serverInfo(opts = {}) {
  const text = await display('#{socket_path},#{pid},#{version}', opts);
  return parseServerInfo(text);
}

export async function switchClient({ clientName, target, ...opts }) {
  assertValidTarget(target);
  const args = ['switch-client', ...(clientName ? ['-c', clientName] : []), '-t', target];
  return execTmux(args, opts);
}

export async function setUserOption(name, value, { target, ...opts }) {
  if (!/^@[a-z0-9_-]+$/i.test(name)) {
    throw new Error(`setUserOption: name "${name}" does not match /^@[a-z0-9_-]+$/i`);
  }
  assertFormatSafe(value);
  assertValidTarget(target);
  return execTmux(['set-option', '-p', '-t', target, name, value], opts);
}

export function attachSessionArgv(target, { socketPath }) {
  assertValidTarget(target);
  return Object.freeze(['tmux', '-u', '-S', socketPath, 'attach-session', '-t', target]);
}

// The one spawn not routed through procexec: procexec's stdio is hardcoded to
// pipe, and a foreground attach needs the real terminal. tmuxexec is a
// pre-allowed child_process importer, so no verb file ever touches
// child_process directly.
export function attachSessionForeground(target, { socketPath, env }) {
  assertValidTarget(target);
  assertTestSocketAllowed(socketPath, env);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('tmux', ['-u', '-S', socketPath, 'attach-session', '-t', target], { env, stdio: 'inherit' });
    } catch (error) {
      reject(error);
      return;
    }

    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
}
