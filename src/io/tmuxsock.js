import { existsSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

// DARWIN_USER_TEMP_DIR is deliberately not a rung on this ladder: it is
// absent from tmux(1), and `getconf DARWIN_USER_TEMP_DIR` throws on Linux --
// a platform-conditional rung here would need its own guard for no
// measured benefit, since $TMUX and the /tmp/tmux-<uid> glob already cover
// every socket tmux itself will ever create.
function candidatesFromTmuxEnv(tmuxEnv) {
  if (typeof tmuxEnv !== 'string' || tmuxEnv.length === 0) return [];
  const [socketPath, serverPid] = tmuxEnv.split(',');
  if (!socketPath) return [];
  return [{ socketPath, serverPid: serverPid ? Number(serverPid) : null }];
}

function candidatesFromDir(dir, listDir) {
  let entries;
  try {
    entries = listDir(dir);
  } catch {
    return [];
  }
  return entries.map((name) => ({ socketPath: path.join(dir, name), serverPid: null }));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function addNote(notes, name, socketPath, error) {
  notes.push(Object.freeze({ adapter: 'tmux', note: name, detail: `${socketPath}: ${errorMessage(error)}` }));
}

function canonicalize(socketPath, realpath, notes) {
  try {
    return { socketPath: realpath(socketPath), canonical: true };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    addNote(notes, 'socket-canonicalization-failed', socketPath, error);
    return { socketPath, canonical: false };
  }
}

export async function resolveServer({ env, uid, probe, realpath = realpathSync, exists = existsSync, listDir = readdirSync }) {
  const rungs = [];

  rungs.push(...candidatesFromTmuxEnv(env.TMUX));

  if (typeof env.TMUX_TMPDIR === 'string' && env.TMUX_TMPDIR.length > 0) {
    rungs.push(...candidatesFromDir(path.join(env.TMUX_TMPDIR, `tmux-${uid}`), listDir));
  }

  rungs.push(...candidatesFromDir(path.join('/tmp', `tmux-${uid}`), listDir));

  for (const candidate of rungs) {
    if (!exists(candidate.socketPath)) continue;

    let probed;
    try {
      probed = await probe({ socketPath: candidate.socketPath, env });
    } catch {
      continue;
    }
    if (!probed || probed.ok !== true) continue;

    let candidateReal;
    let probedReal;
    try {
      candidateReal = realpath(candidate.socketPath);
      probedReal = realpath(probed.socketPath);
    } catch {
      continue;
    }
    if (candidateReal !== probedReal) continue;

    return {
      ok: true,
      socketPath: candidateReal,
      serverPid: candidate.serverPid ?? probed.pid,
      version: probed.version,
    };
  }

  return { ok: false, reason: 'no-server' };
}

export async function resolveServers({ env, uid, probe, realpath = realpathSync, exists = existsSync, listDir = readdirSync, notes = [] }) {
  const rungs = [];
  rungs.push(...candidatesFromTmuxEnv(env.TMUX));
  if (typeof env.TMUX_TMPDIR === 'string' && env.TMUX_TMPDIR.length > 0) {
    rungs.push(...candidatesFromDir(path.join(env.TMUX_TMPDIR, `tmux-${uid}`), listDir));
  }
  rungs.push(...candidatesFromDir(path.join('/tmp', `tmux-${uid}`), listDir));

  const servers = [];
  const seen = new Set();
  for (const candidate of rungs) {
    if (!exists(candidate.socketPath)) continue;
    const candidateResolved = canonicalize(candidate.socketPath, realpath, notes);
    if (candidateResolved === null) continue;
    let probed;
    try {
      probed = await probe({ socketPath: candidateResolved.socketPath, env });
    } catch (error) {
      if (error?.code !== 'ENOENT') addNote(notes, 'socket-probe-failed', candidate.socketPath, error);
      continue;
    }
    if (!probed || probed.ok !== true) continue;

    const probedResolved = canonicalize(probed.socketPath, realpath, notes);
    if (probedResolved === null) continue;
    if (candidateResolved.canonical && probedResolved.canonical && candidateResolved.socketPath !== probedResolved.socketPath) continue;
    const socketPath = candidateResolved.canonical
      ? candidateResolved.socketPath
      : probedResolved.canonical
        ? probedResolved.socketPath
        : candidate.socketPath;
    const identity = Number.isInteger(probed.pid) ? `pid:${probed.pid}` : `socket:${socketPath}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    servers.push(Object.freeze({
      socketPath,
      serverPid: candidate.serverPid ?? probed.pid,
      version: probed.version,
    }));
  }
  return Object.freeze(servers);
}
