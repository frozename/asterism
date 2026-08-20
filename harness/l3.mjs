import { existsSync, unlinkSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { isSupportedTmuxVersion, parseTmuxVersion } from '../src/core/tmuxver.js';
import { procexec } from '../src/io/procexec.js';

const MIN_MAJOR = 3;
const MIN_MINOR = 7;
const ATTACH_SETTLE_MS = 300;

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

export async function l3Gate(env) {
  let versionOutput = null;
  try {
    const result = await procexec(['tmux', '-V'], { env });
    if (result.code === 0) versionOutput = result.stdout.toString('utf8');
  } catch {
    versionOutput = null;
  }

  return decideL3({ env, versionOutput });
}

// kill-server stops the server process but does not reliably unlink its
// socket file (measured on tmux 3.7c: the file survives 3s+ after a
// successful kill-server). A lazy teardown that only confirms the server is
// gone walks straight past the leftover file, so teardown must remove it
// itself and then verify the removal actually took.
async function killAndAssertGone(label, env, socketPath) {
  await procexec(['tmux', '-L', label, 'kill-server'], { env }).catch(() => {});
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

async function sandboxSocketPath(label, env) {
  const result = await procexec(['tmux', '-u', '-L', label, 'display-message', '-p', '#{socket_path}'], { env });
  return result.stdout.toString('utf8').trim();
}

export async function withSandboxServer(fn, { env }) {
  const label = `asterism-test-${process.pid}`;

  await procexec(['tmux', '-u', '-L', label, '-f', '/dev/null', 'new-session', '-d', '-x', '80', '-y', '24'], { env });
  const socketPath = await sandboxSocketPath(label, env);

  const raw = (args, { env: callEnv = env } = {}) => procexec(['tmux', '-L', label, ...args], { env: callEnv });

  try {
    return await fn({ label, socketPath, raw });
  } finally {
    await killAndAssertGone(label, env, socketPath);
  }
}

export async function withAttachedClient(fn, { env }) {
  const probeLabel = `asterism-test-probe-${process.pid}`;
  const hostLabel = `asterism-test-host-${process.pid}`;

  await procexec(
    ['tmux', '-u', '-L', probeLabel, '-f', '/dev/null', 'new-session', '-d', '-x', '80', '-y', '24'],
    { env },
  );
  const probeSocketPath = await sandboxSocketPath(probeLabel, env);

  await procexec(
    [
      'tmux', '-u', '-L', hostLabel, '-f', '/dev/null', 'new-session', '-d', '-x', '80', '-y', '24',
      `tmux -u -L ${probeLabel} attach`,
    ],
    { env },
  );
  const hostSocketPath = await sandboxSocketPath(hostLabel, env);
  // The host's attach client needs a moment to connect to the probe server
  // after new-session returns -- without this, list-clients on the probe can
  // observe zero clients (measured: a fixed race, not a fixture of the
  // scenario).
  await delay(ATTACH_SETTLE_MS);

  const raw = (args, { env: callEnv = env } = {}) => procexec(['tmux', '-L', probeLabel, ...args], { env: callEnv });

  try {
    return await fn({ probeLabel, hostLabel, socketPath: probeSocketPath, raw });
  } finally {
    await killAndAssertGone(hostLabel, env, hostSocketPath);
    await killAndAssertGone(probeLabel, env, probeSocketPath);
  }
}
