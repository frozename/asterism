import { spawn } from 'node:child_process';
import path from 'node:path';
import { parseListClients, parseListPanes, parseServerInfo } from '../core/tmuxparse.js';
import { procexec } from './procexec.js';

export const TARGET_ID = /^[$@%]\d+$/;
export const FORMAT_REJECT = /[#;$\n\r\x00-\x1f]/;
export const LIST_PANES_FORMAT = '#{pane_id}|#{pane_pid}|#{session_id}|#{window_id}|#{pane_dead}|#{pane_mode}|#{@asterism_sid}';
export const LIST_CLIENTS_FORMAT = '#{client_name}|#{session_id}|#{client_activity}';
export const NEW_WINDOW_FORMAT = '#{pane_id}';

/**
 * @typedef {{
 *   socketPath: string,
 *   env: Record<string, string | undefined>,
 *   execute?: typeof procexec,
 *   command?: string[],
 * }} ExecTmuxOptions
 */

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

function assertCommandArgv(command) {
  if (!Array.isArray(command)) throw new Error('new-window command argv must be an array');
  for (const element of command) {
    if (typeof element !== 'string' || /[\n\r\x00]/.test(element)) {
      throw new Error(`new-window command argv contains an invalid element: ${JSON.stringify(element)}`);
    }
  }
}

// The only low-level tmux runner. -u is always applied so an LC_ALL=C client
// cannot mangle a -F row into a single dropped field (see the tab byte-diff
// invariant in test/tmux-l3.test.mjs); every -t target is validated before
// the spawn, never rewritten.
/** @param {string[]} args @param {ExecTmuxOptions} opts */
export async function execTmux(args, { socketPath, env, execute = procexec, command = [] }) {
  assertTestSocketAllowed(socketPath, env);

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '-t') assertValidTarget(args[index + 1]);
  }

  return execute(['tmux', '-u', '-S', socketPath, ...args, ...(command.length > 0 ? ['--', ...command] : [])], { env });
}

// Detached is the default because spawning a pane must not move the human's
// current tmux view. `detached: false` is the explicit --switch opt-in.
/**
 * @param {{
 *   cwd?: string,
 *   command?: string[],
 *   detached?: boolean,
 *   socketPath?: string,
 *   env?: Record<string, string | undefined>,
 *   execute?: typeof procexec,
 * }} [options]
 */
export async function newWindow({ cwd, command = [], detached = true, socketPath, env, execute } = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    throw new Error(`new-window cwd ${JSON.stringify(cwd)} must be an absolute path`);
  }
  assertFormatSafe(cwd);
  assertCommandArgv(command);

  const result = await execTmux(
    ['new-window', ...(detached ? ['-d'] : []), '-P', '-F', NEW_WINDOW_FORMAT, '-c', cwd],
    { socketPath, env, execute, command },
  );
  const stderr = result.stderr.toString('utf8').trim();
  if (result.code !== 0) {
    throw new Error(`tmux new-window failed: ${stderr}`);
  }

  const paneId = result.stdout.toString('utf8').trim();
  if (!TARGET_ID.test(paneId) || !paneId.startsWith('%')) {
    throw new Error(`tmux new-window returned invalid pane id ${JSON.stringify(paneId)}`);
  }
  return paneId;
}

/** @param {Partial<ExecTmuxOptions> & { paneCount?: number }} [options] */
export async function listPanes({ paneCount, socketPath, env, execute, command } = {}) {
  const result = await execTmux(['list-panes', '-a', '-F', LIST_PANES_FORMAT], { socketPath, env, execute, command });
  return parseListPanes(result.stdout.toString('utf8'), { paneCount });
}

/** @param {Partial<ExecTmuxOptions>} [opts] */
export async function listClients({ socketPath, env, execute, command } = {}) {
  const result = await execTmux(['list-clients', '-F', LIST_CLIENTS_FORMAT], { socketPath, env, execute, command });
  return parseListClients(result.stdout.toString('utf8'));
}

/** @param {string} format @param {Partial<ExecTmuxOptions>} [opts] */
export async function display(format, { socketPath, env, execute, command } = {}) {
  const result = await execTmux(['display-message', '-p', format], { socketPath, env, execute, command });
  return result.stdout.toString('utf8').trim();
}

/** @param {Partial<ExecTmuxOptions>} [opts] */
export async function serverInfo(opts = {}) {
  const text = await display('#{socket_path},#{pid},#{version}', opts);
  return parseServerInfo(text);
}

/** @param {ExecTmuxOptions & { clientName?: string, target: string }} options */
export async function switchClient({ clientName, target, ...opts }) {
  assertValidTarget(target);
  const args = ['switch-client', ...(clientName ? ['-c', clientName] : []), '-t', target];
  return execTmux(args, opts);
}

/** @param {string} name @param {string} value @param {ExecTmuxOptions & { target: string }} options */
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
