import { resolveSessionRef } from '../pipeline.js';
import { LifecycleVocabularyError, transition } from '../../core/lifecycle.js';
import { openStore, readArchive, readSessions } from '../../io/store.js';

export const mutating = true;
export const summary = 'move a live or parked session into the archive';

const USAGE = 'usage: ast archive <sessionRef>\n';

function refusal(message) {
  process.stderr.write(`ast archive: ${message}\n`);
  return 1;
}

export async function run(argv, ctx) {
  if (argv.length !== 1) {
    process.stderr.write(USAGE);
    return 2;
  }

  const store = await openStore({ env: ctx.env });
  const sessions = await readSessions(store.stateDir);
  let resolved = resolveSessionRef(sessions.records.map((entry) => entry.record), argv[0]);

  if (resolved.error?.startsWith('no session matches ')) {
    const archive = await readArchive(store.stateDir);
    const archived = resolveSessionRef(archive.records.map((entry) => entry.record), argv[0]);
    if (archived.record !== undefined) resolved = archived;
  }
  if (resolved.error) return refusal(resolved.error);

  const state = resolved.record.lifecycle ?? 'Live';
  let lifecycle;
  try {
    lifecycle = transition(state, 'archive');
  } catch (error) {
    if (error instanceof LifecycleVocabularyError) {
      return refusal(`${resolved.record.agent.sessionId}: ${state}: ${error.message}`);
    }
    return refusal(`${state}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const archived = { ...resolved.record, lifecycle };
  await store.archiveSession(archived.id, archived);
  process.stdout.write(`${archived.agent.sessionId} -> ${archived.lifecycle}\n`);
  return 0;
}
