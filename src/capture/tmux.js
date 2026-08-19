import { setTimeout as delay } from 'node:timers/promises';
import { procexec } from '../io/procexec.js';

const MIN_MAJOR = 3;
const MIN_MINOR = 7;
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

export function parseTmuxVersion(output) {
  const match = /tmux\s+(\d+)\.(\d+)/i.exec(String(output));
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]), raw: String(output).trim() };
}

export function isSupportedTmuxVersion(version) {
  if (version === null) return false;
  if (version.major !== MIN_MAJOR) return version.major > MIN_MAJOR;
  return version.minor >= MIN_MINOR;
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

async function runCell(cell, { env }, exec = procexec) {
  const availability = await checkTmux(env, exec);
  if (!availability.ok) return { ok: false, message: availability.message };

  const pid = process.pid;
  const plan = buildTmuxPlan(cell, pid);
  let capture;

  try {
    await exec(plan[0], { env });

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

  return {
    ok: true,
    text: capture.stdout.toString('utf8'),
    command: plan[plan.length - 2].join(' '),
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
