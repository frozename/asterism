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
