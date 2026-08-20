import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { isSupportedTmuxVersion, parseTmuxVersion } from '../core/tmuxver.js';
import { procexec } from '../io/procexec.js';

export { isSupportedTmuxVersion, parseTmuxVersion };

const SETTLE_MS = 200;
const PRINTF_COMMAND = String.raw`printf '\033[31mRED\033[0m plain\n'`;

const CELL_ARGV = Object.freeze({
  'tmux/list-panes': Object.freeze(['list-panes', '-a', '-F', '#{pane_id}|#{pane_pid}|#{pane_current_command}|#{pane_in_mode}|#{pane_mode}']),
  'tmux/list-clients': Object.freeze(['list-clients', '-F', '#{client_name}|#{session_id}|#{client_session}']),
  'tmux/capture-pane/plain': Object.freeze(['capture-pane', '-p']),
  'tmux/capture-pane/escapes': Object.freeze(['capture-pane', '-p', '-e']),
});

const PANE_CONTENT_CELLS = new Set(['tmux/capture-pane/plain', 'tmux/capture-pane/escapes']);

export const TMUX_CELLS = Object.freeze(Object.keys(CELL_ARGV));

export function socketLabel(pid) {
  return `asterism-cap-${pid}`;
}

// Pure argv-plan builder, kept separate from execution so tests can assert
// its shape without spawning a real tmux server.
export function buildTmuxPlan(cell, pid) {
  if (!Object.hasOwn(CELL_ARGV, cell)) {
    throw new Error(`unknown tmux cell: ${cell}`);
  }

  const label = socketLabel(pid);
  const withConfig = ['tmux', '-u', '-L', label, '-f', '/dev/null'];
  const client = ['tmux', '-u', '-L', label];

  const plan = [[...withConfig, 'new-session', '-d', '-x', '80', '-y', '24']];

  if (PANE_CONTENT_CELLS.has(cell)) {
    plan.push([...client, 'send-keys', PRINTF_COMMAND, 'Enter']);
  }

  plan.push([...client, ...CELL_ARGV[cell]]);
  plan.push([...client, 'kill-server']);
  return plan;
}

async function checkTmux(env, exec) {
  let result;
  try {
    result = await exec(['tmux', '-V'], { env, timeoutMs: 10000 });
  } catch {
    return { ok: false, message: 'tmux is not on PATH' };
  }

  const version = parseTmuxVersion(result.stdout.toString('utf8'));
  if (!isSupportedTmuxVersion(version)) {
    const raw = version?.raw ?? result.stdout.toString('utf8').trim();
    return { ok: false, message: `tmux version "${raw}" is below the required 3.7` };
  }

  return { ok: true, version: version.raw };
}

async function querySocketPath(env, pid, exec) {
  const client = ['tmux', '-u', '-L', socketLabel(pid)];
  const result = await exec([...client, 'display-message', '-p', '#{socket_path}'], { env });
  return result.stdout.toString('utf8').trim();
}

// exec and fsExists are injectable so a test can drive this without a real
// tmux server or a real socket file on disk.
export async function runCell(cell, { env }, exec = procexec, fsExists = existsSync) {
  const availability = await checkTmux(env, exec);
  if (!availability.ok) return { ok: false, message: availability.message };

  const pid = process.pid;
  const plan = buildTmuxPlan(cell, pid);
  let capture;
  let socketPath = null;

  try {
    await exec(plan[0], { env });
    socketPath = await querySocketPath(env, pid, exec);

    let cursor = 1;
    if (PANE_CONTENT_CELLS.has(cell)) {
      await exec(plan[cursor], { env });
      cursor += 1;
      await delay(SETTLE_MS);
    }

    capture = await exec(plan[cursor], { env });
  } finally {
    await exec(plan[plan.length - 1], { env }).catch(() => {});
  }

  if (socketPath && fsExists(socketPath)) {
    return {
      ok: false,
      message: `tmux socket "${socketPath}" still exists after kill-server -- refusing to record the capture`,
    };
  }

  return {
    ok: true,
    text: capture.stdout.toString('utf8'),
    command: plan[plan.length - 2],
    version: availability.version,
  };
}

export const captures = Object.freeze(
  TMUX_CELLS.map((cell) =>
    Object.freeze({
      cell,
      provoke: 'none',
      source: 'tmux',
      cliVersionArgv: Object.freeze(['tmux', '-V']),
      run: (context) => runCell(cell, context),
    }),
  ),
);
