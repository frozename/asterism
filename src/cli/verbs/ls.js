import os from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { emitNotes } from '../notes.js';
import { collectSessions, sessionsPayload } from '../pipeline.js';
import { compareRecords, statusLabel } from '../../core/reconcile.js';
import { table, untrusted } from '../../core/render.js';
import { openStore, readArchive } from '../../io/store.js';

export const mutating = false;
export const summary = 'list every discovered agent session, blocked first';

const USAGE = 'usage: ast ls [--all] [--json] [--watch]\n';

function parseArgs(argv) {
  const options = { all: false, json: false, watch: false, watchIterations: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--all') {
      options.all = true;
    } else if (arg === '--json') {
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

function needsAttention(record) {
  return record.lifecycle !== 'Archived' && record.observed.status === 'waiting';
}

export function formatLs(records, { maxWidth = 40 } = {}) {
  const sorted = [...records].sort(compareRecords);
  const waiting = sorted.filter(needsAttention).length;
  const header = `${sorted.length} ${sorted.length === 1 ? 'session' : 'sessions'} · ${waiting} ${waiting === 1 ? 'needs' : 'need'} you`;
  const rows = sorted.map((record) => [
    record.lifecycle === 'Archived' ? 'archived' : statusLabel(record.observed.status),
    record.adapter,
    untrusted(record.name ?? record.agent.name ?? record.id, { maxWidth }),
    untrusted(record.observed.waitingFor ?? '', { maxWidth }),
    record.flags.writeDisabled ? 'read-only' : '',
  ]);
  const body = table(rows);
  return body.length === 0 ? `${header}\n` : `${header}\n${body}\n`;
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
    const { records: active, notes } = await collectSessions({
      env: ctx.env,
      adapters: ctx.adapters,
      home,
      store,
    });
    const archived = options.all ? (await readArchive(store.stateDir)).records.map((entry) => entry.record) : [];
    const records = [...active, ...archived];
    emitNotes(notes);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(sessionsPayload(records), null, 2)}\n`);
    } else {
      process.stdout.write(formatLs(records));
    }
    return records.filter(needsAttention).length;
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
