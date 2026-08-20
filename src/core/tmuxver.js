const MIN_MAJOR = 3;
const MIN_MINOR = 7;

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

// execute is injected with the contract execute(tmuxArgs, {env}) -> Promise<{code, stdout, stderr}>,
// tmuxArgs excluding the tmux binary name -- core stays pure and never builds a tmux argv array
// itself. The production binder is sourced out of tmuxexec.execTmux.
export async function checkTmuxVersionFloor({ env, execute }) {
  let result;
  try {
    result = await execute(['-V'], { env });
  } catch (error) {
    return { status: 'unknown', detail: `tmux could not be resolved on PATH: ${error?.message ?? error}` };
  }

  if (result.code !== 0) {
    return { status: 'unknown', detail: `tmux -V exited ${result.code}; could not resolve a version` };
  }

  const version = parseTmuxVersion(result.stdout.toString('utf8'));
  if (version === null) {
    return { status: 'unknown', detail: `tmux -V output could not be parsed: "${result.stdout.toString('utf8').trim()}"` };
  }

  if (!isSupportedTmuxVersion(version)) {
    return { status: 'fail', detail: `found tmux ${version.raw}, below the required ${MIN_MAJOR}.${MIN_MINOR}` };
  }

  return { status: 'pass', detail: `found tmux ${version.raw}, at or above the required ${MIN_MAJOR}.${MIN_MINOR}` };
}

// #{pane_pipe} as the occupancy token is inferred from tmux formats, not pinned by a measured
// capture -- this is the seam a live doctor run verifies.
export async function checkPipePaneOccupied({ env, execute }) {
  let result;
  try {
    result = await execute(['list-panes', '-a', '-F', '#{pane_id}|#{@asterism_sid}|#{pane_pipe}']);
  } catch {
    return { status: 'unknown', detail: 'no tmux server reachable' };
  }

  if (result.code !== 0) {
    return { status: 'unknown', detail: 'no tmux server reachable' };
  }

  const text = result.stdout.toString('utf8');
  const lines = text.split('\n').filter((line) => line.length > 0);

  const occupied = [];
  for (const line of lines) {
    const fields = line.split('|');
    const [paneId, asterismSid, panePipe] = fields;
    if (typeof asterismSid === 'string' && asterismSid.length > 0 && panePipe === '1') {
      occupied.push(paneId);
    }
  }

  if (occupied.length > 0) {
    return { status: 'fail', detail: `pane(s) marked by asterism have an occupied pipe: ${occupied.join(', ')}` };
  }

  return { status: 'pass', detail: `no marked pane has an occupied pipe (${lines.length} pane(s) checked)` };
}
