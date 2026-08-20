import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isSupportedTmuxVersion, parseTmuxVersion } from '../src/core/tmuxver.js';
import { procexec } from '../src/io/procexec.js';

const MIN_MAJOR = 3;
const MIN_MINOR = 7;
const ATTACH_SETTLE_MS = 300;
const bootProbeCache = new WeakMap();

let bootProbeSequence = 0;

export function decideL3({ env, versionOutput }) {
  if (env.ASTERISM_L3 === '1') {
    return { mode: 'run', hard: true };
  }

  const version = parseTmuxVersion(versionOutput);
  if (version !== null && isSupportedTmuxVersion(version)) {
    return { mode: 'run' };
  }

  const reason =
    version === null
      ? `L3 gated: tmux was not resolvable/parseable on PATH (floor is ${MIN_MAJOR}.${MIN_MINOR}c)`
      : `L3 gated: found tmux ${version.raw}, below the required ${MIN_MAJOR}.${MIN_MINOR}c floor`;

  return { mode: 'todo', reason };
}

function environmentCacheKey(env) {
  const effective = Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => [name, String(value)])
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(effective);
}

function commandErrorText(result) {
  const stderr = result?.stderr?.toString('utf8').trim() ?? '';
  const stdout = result?.stdout?.toString('utf8').trim() ?? '';
  const detail = stderr.length > 0 ? stderr : stdout;

  if (result?.timedOut === true) return `tmux probe timed out${detail.length > 0 ? `: ${detail}` : ''}`;
  if (result?.truncated === true) return `tmux probe exceeded its output limit${detail.length > 0 ? `: ${detail}` : ''}`;
  if (detail.length > 0) return detail;
  return `tmux probe exited ${result?.code ?? 'without a status'}`;
}

function reportedProbeSocketPath(result, label) {
  const socketPath = result?.stdout?.toString('utf8').trim() ?? '';
  if (!path.isAbsolute(socketPath)) return null;
  if (path.basename(socketPath) !== label) return null;
  if (!path.basename(path.dirname(socketPath)).startsWith('tmux-')) return null;
  return socketPath;
}

function bootFailureText(result) {
  if (result?.code !== 0 || result?.timedOut === true || result?.truncated === true) {
    return commandErrorText(result);
  }

  const stderr = result?.stderr?.toString('utf8').trim() ?? '';
  if (stderr.length > 0) return stderr;
  const stdout = result?.stdout?.toString('utf8').trim() ?? '';
  return stdout.length > 0
    ? `tmux probe reported an invalid socket path: "${stdout}"`
    : 'tmux probe did not report its socket path';
}

function reportsNoServer(result) {
  if (result?.code === 0 || result?.timedOut === true || result?.truncated === true) return false;
  const text = `${result?.stderr?.toString('utf8') ?? ''}\n${result?.stdout?.toString('utf8') ?? ''}`.toLowerCase();
  return text.includes('no server running') || text.includes('no such file or directory');
}

async function probeServerGone(label, env, execute) {
  try {
    const result = await execute(['tmux', '-L', label, 'display-message', '-p', '#{socket_path}'], { env });
    return reportsNoServer(result);
  } catch {
    return false;
  }
}

function removeProbeSocket(socketPath) {
  try {
    unlinkSync(socketPath);
  } catch (error) {
    if (error.code !== 'ENOENT') return `failed to remove probe socket "${socketPath}": ${error.message}`;
  }
  return existsSync(socketPath) ? `probe socket "${socketPath}" still exists after kill-server` : null;
}

async function probeServerBoot(env, execute) {
  bootProbeSequence += 1;
  const label = `asterism-test-l3-probe-${process.pid}-${bootProbeSequence}`;
  let result;
  let bootErrorText = null;

  try {
    result = await execute(
      [
        'tmux', '-u', '-L', label, '-f', '/dev/null', 'new-session', '-d', '-P', '-F', '#{socket_path}',
        '-x', '80', '-y', '24',
      ],
      { env },
    );
  } catch (error) {
    bootErrorText = error?.message ?? String(error);
  }

  const socketPath = reportedProbeSocketPath(result, label);
  if (
    bootErrorText === null &&
    (result?.code !== 0 || result.timedOut === true || result.truncated === true || socketPath === null)
  ) {
    bootErrorText = bootFailureText(result);
  }

  let killErrorText = null;
  let serverGone = false;
  try {
    const killResult = await execute(['tmux', '-L', label, 'kill-server'], { env });
    if (killResult.code === 0 && killResult.timedOut !== true && killResult.truncated !== true) {
      serverGone = true;
    } else {
      killErrorText = commandErrorText(killResult);
      serverGone = reportsNoServer(killResult);
    }
  } catch (error) {
    killErrorText = error?.message ?? String(error);
  }

  if (!serverGone) serverGone = await probeServerGone(label, env, execute);
  if (!serverGone) {
    const bootDetail = bootErrorText === null ? '' : `${bootErrorText}; `;
    return { ok: false, detail: `${bootDetail}probe cleanup failed: ${killErrorText ?? 'server still reachable'}` };
  }

  if (socketPath !== null) {
    const removalError = removeProbeSocket(socketPath);
    if (removalError !== null) {
      const bootDetail = bootErrorText === null ? '' : `${bootErrorText}; `;
      return { ok: false, detail: `${bootDetail}${removalError}` };
    }
  }
  if (bootErrorText !== null) return { ok: false, detail: bootErrorText };
  return { ok: true };
}

function cachedServerBootProbe(env, execute) {
  let byEnvironment = bootProbeCache.get(execute);
  if (byEnvironment === undefined) {
    byEnvironment = new Map();
    bootProbeCache.set(execute, byEnvironment);
  }

  const key = environmentCacheKey(env);
  let probe = byEnvironment.get(key);
  if (probe === undefined) {
    probe = probeServerBoot(env, execute);
    byEnvironment.set(key, probe);
  }
  return probe;
}

export async function l3Gate(env, { execute = procexec } = {}) {
  let versionOutput = null;
  try {
    const result = await execute(['tmux', '-V'], { env });
    if (result.code === 0) versionOutput = result.stdout.toString('utf8');
  } catch {
    versionOutput = null;
  }

  const decision = decideL3({ env, versionOutput });
  if (decision.mode !== 'run' || decision.hard === true) return decision;

  const boot = await cachedServerBootProbe(env, execute);
  if (!boot.ok) {
    return { mode: 'todo', reason: `L3 gated: tmux server boot probe failed: ${boot.detail}` };
  }
  return decision;
}

// kill-server stops the server process but does not reliably unlink its
// socket file (measured on tmux 3.7c: the file survives 3s+ after a
// successful kill-server). A lazy teardown that only confirms the server is
// gone walks straight past the leftover file, so teardown must remove it
// itself and then verify the removal actually took.
export async function killAndAssertGone(label, env, socketPath, { execute = procexec } = {}) {
  let killErrorText = null;
  let serverGone = false;
  try {
    const killResult = await execute(['tmux', '-L', label, 'kill-server'], { env });
    if (killResult.code === 0 && killResult.timedOut !== true && killResult.truncated !== true) {
      serverGone = true;
    } else {
      killErrorText = commandErrorText(killResult);
      serverGone = reportsNoServer(killResult);
    }
  } catch (error) {
    killErrorText = error?.message ?? String(error);
  }

  if (!serverGone) serverGone = await probeServerGone(label, env, execute);
  if (!serverGone) {
    throw new Error(
      `withSandboxServer: failed to stop tmux server "${label}": ${killErrorText ?? 'kill-server status unavailable'}; server still reachable`,
    );
  }

  try {
    unlinkSync(socketPath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`withSandboxServer: failed to remove socket file "${socketPath}" after kill-server: ${err.message}`);
    }
  }
  if (existsSync(socketPath)) {
    throw new Error(`withSandboxServer: socket file "${socketPath}" still exists after kill-server`);
  }
}

async function sandboxSocketPath(label, env, execute) {
  const result = await execute(['tmux', '-u', '-L', label, 'display-message', '-p', '#{socket_path}'], { env });
  return result.stdout.toString('utf8').trim();
}

export async function withSandboxServer(fn, { env, execute = procexec }) {
  const label = `asterism-test-${process.pid}`;

  await execute(['tmux', '-u', '-L', label, '-f', '/dev/null', 'new-session', '-d', '-x', '80', '-y', '24'], { env });
  const socketPath = await sandboxSocketPath(label, env, execute);

  const raw = (args, { env: callEnv = env } = {}) => execute(['tmux', '-L', label, ...args], { env: callEnv });

  try {
    return await fn({ label, socketPath, raw });
  } finally {
    await killAndAssertGone(label, env, socketPath, { execute });
  }
}

export async function withAttachedClient(fn, { env, execute = procexec }) {
  const probeLabel = `asterism-test-probe-${process.pid}`;
  const hostLabel = `asterism-test-host-${process.pid}`;

  await execute(
    ['tmux', '-u', '-L', probeLabel, '-f', '/dev/null', 'new-session', '-d', '-x', '80', '-y', '24'],
    { env },
  );
  const probeSocketPath = await sandboxSocketPath(probeLabel, env, execute);

  await execute(
    [
      'tmux', '-u', '-L', hostLabel, '-f', '/dev/null', 'new-session', '-d', '-x', '80', '-y', '24',
      `tmux -u -L ${probeLabel} attach`,
    ],
    { env },
  );
  const hostSocketPath = await sandboxSocketPath(hostLabel, env, execute);
  // The host's attach client needs a moment to connect to the probe server
  // after new-session returns -- without this, list-clients on the probe can
  // observe zero clients (measured: a fixed race, not a fixture of the
  // scenario).
  await delay(ATTACH_SETTLE_MS);

  const raw = (args, { env: callEnv = env } = {}) => execute(['tmux', '-L', probeLabel, ...args], { env: callEnv });

  try {
    return await fn({ probeLabel, hostLabel, socketPath: probeSocketPath, raw });
  } finally {
    await killAndAssertGone(hostLabel, env, hostSocketPath, { execute });
    await killAndAssertGone(probeLabel, env, probeSocketPath, { execute });
  }
}
