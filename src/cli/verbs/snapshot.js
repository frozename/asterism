import os from 'node:os';
import path from 'node:path';
import { collectSessions } from '../pipeline.js';
import { openStore, resolveStateDir } from '../../io/store.js';

export const mutating = true;
export const summary = 'capture restorable agent session metadata';

const USAGE = 'usage: ast snapshot [--force] [--dry-run]\n';

function parseArgs(argv) {
  const options = { force: false, dryRun: false };
  for (const arg of argv) {
    if (arg === '--force' && options.force === false) options.force = true;
    else if (arg === '--dry-run' && options.dryRun === false) options.dryRun = true;
    else return null;
  }
  return options;
}

function refusal(error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ast snapshot: ${message}\n`);
  return 1;
}

function layoutEntry(record) {
  const adapter = record?.adapter;
  const sessionId = record?.agent?.sessionId;
  const cwd = record?.agent?.cwd;
  if (
    typeof adapter !== 'string' || adapter.length === 0 ||
    typeof sessionId !== 'string' || sessionId.length === 0 ||
    typeof cwd !== 'string' || !path.isAbsolute(cwd)
  ) {
    return null;
  }
  return Object.freeze({ adapter, sessionId, cwd });
}

function receipt(count, dryRun) {
  const sessions = count === 1 ? 'session' : 'sessions';
  process.stdout.write(`snapshot: ${dryRun ? 'would capture' : 'captured'} ${count} ${sessions}\n`);
}

export async function run(argv, ctx) {
  const options = parseArgs(argv);
  if (options === null) {
    process.stderr.write(USAGE);
    return 2;
  }

  try {
    const store = options.dryRun
      ? { stateDir: resolveStateDir(ctx.env) }
      : await openStore({ env: ctx.env });
    const { records } = await collectSessions({
      env: ctx.env,
      adapters: ctx.adapters,
      home: os.homedir(),
      store,
      persist: false,
    });
    const doc = {
      version: 1,
      capturedAt: new Date().toISOString(),
      entries: records.map(layoutEntry).filter((entry) => entry !== null),
    };

    if (!options.dryRun) await store.writeLayout(doc, options.force ? { force: true } : {});
    receipt(doc.entries.length, options.dryRun);
    return 0;
  } catch (error) {
    return refusal(error);
  }
}
