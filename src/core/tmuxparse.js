const PANE_ID_SHAPE = /^%\d+$/;
const SESSION_ID_SHAPE = /^\$\d+$/;

// A short listing under -u newline injection reads as extra rows for the same
// field count, not as a field-count mismatch -- paneCount is the guard that
// catches it: reject the whole listing rather than pad or drop a row.
/** @param {string} text @param {{ paneCount?: number }} [options] */
export function parseListPanes(text, { paneCount } = {}) {
  const lines = String(text).split('\n').filter((line, index, all) => !(line.length === 0 && index === all.length - 1));

  if (lines.length === 0 && paneCount === 0) {
    return { ok: true, rows: [] };
  }

  // Checked against the raw line count before any per-row parsing: an
  // embedded newline in a caller-controlled -F value (see FORMAT_REJECT in
  // tmuxexec.js) forges an extra line for the same pane, and this is the
  // guard that catches it even when the forged line happens to look
  // superficially row-shaped.
  if (typeof paneCount === 'number' && lines.length !== paneCount) {
    return {
      ok: false,
      reason: `list-panes returned ${lines.length} rows but the server reports ${paneCount} pane(s)`,
    };
  }

  const rows = [];
  for (const line of lines) {
    const fields = line.split('|');
    if (fields.length !== 7) {
      return { ok: false, reason: `list-panes row "${line}" has ${fields.length} field(s), expected 7` };
    }

    const [paneId, panePid, sessionId, windowId, paneDead, paneMode, asterismSid] = fields;
    if (!PANE_ID_SHAPE.test(paneId)) {
      return { ok: false, reason: `list-panes row "${line}": pane id "${paneId}" does not match ${PANE_ID_SHAPE}` };
    }

    rows.push(Object.freeze({ paneId, panePid, sessionId, windowId, paneDead, paneMode, asterismSid }));
  }

  return { ok: true, rows };
}

export function parseListClients(text) {
  const lines = String(text).split('\n').filter((line, index, all) => !(line.length === 0 && index === all.length - 1));

  const rows = [];
  for (const line of lines) {
    const fields = line.split('|');
    if (fields.length !== 3) {
      return { ok: false, reason: `list-clients row "${line}" has ${fields.length} field(s), expected 3` };
    }

    const [clientName, sessionId, clientActivity] = fields;
    if (!SESSION_ID_SHAPE.test(sessionId)) {
      return { ok: false, reason: `list-clients row "${line}": session id "${sessionId}" does not match ${SESSION_ID_SHAPE}` };
    }

    rows.push(Object.freeze({ clientName, sessionId, clientActivity }));
  }

  return { ok: true, rows };
}

// Parsed right-to-left: a socket path may itself contain commas, so the last
// comma-field is the version and the second-last must be the numeric pid.
export function parseServerInfo(text) {
  const trimmed = String(text).trim();
  const lastComma = trimmed.lastIndexOf(',');
  if (lastComma === -1) {
    return { ok: false, reason: `server-info "${trimmed}" has no comma-separated version field` };
  }

  const version = trimmed.slice(lastComma + 1);
  const rest = trimmed.slice(0, lastComma);

  const secondComma = rest.lastIndexOf(',');
  if (secondComma === -1) {
    return { ok: false, reason: `server-info "${trimmed}" has no comma-separated pid field` };
  }

  const pidText = rest.slice(secondComma + 1);
  const socketPath = rest.slice(0, secondComma);

  if (!/^\d+$/.test(pidText)) {
    return { ok: false, reason: `server-info "${trimmed}": pid field "${pidText}" is not numeric` };
  }

  if (socketPath.length === 0) {
    return { ok: false, reason: `server-info "${trimmed}" has an empty socket path` };
  }

  return { ok: true, socketPath, pid: Number(pidText), version };
}
