import os from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { collectSessions, sessionsPayload } from '../pipeline.js';
import { compareRecords, statusLabel } from '../../core/reconcile.js';
import { table, untrusted } from '../../core/render.js';
import { openStore } from '../../io/store.js';

export const mutating = false;
export const summary = 'list every discovered agent session, blocked first';

const USAGE = 'usage: ast ls [--json] [--watch]\n';

function parseArgs(argv) {
  const options = { json: false, watch: false, watchIterations: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--watch') {
      options.watch = true;
    } else if (arg === '--watch-iterations') {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value <= 0) return null;
      options.watchIterations = value;
      index += 1;
    } else {
      return null;
    }
  }
  return options;
}

export function formatLs(records, { maxWidth = 40 } = {}) {
  const sorted = [...records].sort(compareRecords);
  const waiting = sorted.filter((record) => record.observed.status === 'waiting').length;
  const header = `${sorted.length} ${sorted.length === 1 ? 'session' : 'sessions'} · ${waiting} ${waiting === 1 ? 'needs' : 'need'} you`;
  const rows = sorted.map((record) => [
    statusLabel(record.observed.status),
    record.adapter,
    untrusted(record.agent.sessionId, { maxWidth }),
    untrusted(record.observed.waitingFor ?? '', { maxWidth }),
    record.flags.writeDisabled ? 'read-only' : '',
  ]);
  const body = table(rows);
  return body.length === 0 ? `${header}\n` : `${header}\n${body}\n`;
}

function emitNotes(notes) {
  for (const entry of notes) {
    process.stderr.write(`note: ${entry.adapter}: ${entry.note}: ${entry.detail}\n`);
  }
}

function waitingExit(waiting) {
  return Math.min(waiting, 125);
}

export async function run(argv, ctx) {
  const options = parseArgs(argv);
  if (options === null) {
    process.stderr.write(USAGE);
    return 2;
  }

  const home = os.homedir();
  const store = await openStore({ env: ctx.env });

  async function renderOnce() {
    const { records, notes } = await collectSessions({
      env: ctx.env,
      adapters: ctx.adapters,
      home,
      store,
    });
    emitNotes(notes);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(sessionsPayload(records), null, 2)}\n`);
    } else {
      process.stdout.write(formatLs(records));
    }
    return records.filter((record) => record.observed.status === 'waiting').length;
  }

  if (!options.watch) {
    const waiting = await renderOnce();
    return waitingExit(waiting);
  }

  process.once('SIGINT', () => process.exit(0));
  let remaining = options.watchIterations;
  while (true) {
    const waiting = await renderOnce();
    if (remaining !== null) {
      remaining -= 1;
      if (remaining === 0) {
        return waitingExit(waiting);
      }
    }
    await setTimeout(2000);
  }
}
