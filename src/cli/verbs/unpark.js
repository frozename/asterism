import { resolveSessionRef } from '../pipeline.js';
import { LifecycleVocabularyError } from '../../core/lifecycle.js';
import { applyLifecycle } from '../../core/parkstate.js';
import { openStore, readSessions } from '../../io/store.js';

export const mutating = true;
export const summary = 'return a parked agent session to live';

const USAGE = 'usage: ast unpark <sessionRef>\n';

function refusal(message) {
  process.stderr.write(`ast unpark: ${message}\n`);
  return 1;
}

function assertInvariant(record) {
  if (record.flags?.parked !== (record.lifecycle === 'Parked')) {
    throw new Error(`lifecycle invariant failed for ${record.id}`);
  }
}

function shapedTargetRefusal(record, state, error) {
  return `${record.agent.sessionId}: ${state}: ${error instanceof Error ? error.message : String(error)}`;
}

export async function run(argv, ctx) {
  if (argv.length !== 1) {
    process.stderr.write(USAGE);
    return 2;
  }

  const store = await openStore({ env: ctx.env });
  const prior = await readSessions(store.stateDir);
  const resolved = resolveSessionRef(prior.records.map((entry) => entry.record), argv[0]);
  if (resolved.error) return refusal(resolved.error);

  const record = resolved.record;
  const state = record.lifecycle ?? 'Live';
  try {
    assertInvariant(record);
  } catch (error) {
    return refusal(shapedTargetRefusal(record, state, error));
  }
  let updated;
  try {
    updated = applyLifecycle(record, 'unpark', { at: Date.now() });
  } catch (error) {
    if (error instanceof LifecycleVocabularyError) {
      return refusal(shapedTargetRefusal(record, state, error));
    }
    assertInvariant(record);
    return refusal(`${state}: ${error instanceof Error ? error.message : String(error)}`);
  }

  assertInvariant(updated);
  await store.writeSession(updated.id, updated);
  process.stdout.write(`${updated.agent.sessionId} -> ${updated.lifecycle}\n`);
  return 0;
}
