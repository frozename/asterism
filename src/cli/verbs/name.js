import { resolveSessionRef } from '../pipeline.js';
import { displayWidth } from '../../core/width.js';
import { openStore, readSessions } from '../../io/store.js';

export const mutating = true;
export const summary = 'set a display name for an agent session';

export const MAX_NAME_WIDTH = 40;

const USAGE = 'usage: ast name <sessionRef> <name>\n';
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

function refusal(message) {
  process.stderr.write(`ast name: ${message}\n`);
  return 1;
}

function validateName(name) {
  if (name.trim().length === 0) return { error: 'name must not be empty or whitespace-only' };
  if (CONTROL.test(name)) return { error: 'name must not contain a control character' };
  if (name.includes('#{')) return { error: 'name must not contain a tmux format sequence' };
  const width = displayWidth(name);
  if (width > MAX_NAME_WIDTH) return { error: `name display width ${width} exceeds ${MAX_NAME_WIDTH}` };
  return { value: name };
}

function applyName(record, name, { at }) {
  return Object.freeze({
    ...record,
    name,
    prov: Object.freeze({
      ...(record.prov ?? {}),
      name: Object.freeze({ source: 'human', confidence: 'high', at }),
    }),
  });
}

export async function run(argv, ctx) {
  if (argv.length !== 2) {
    process.stderr.write(USAGE);
    return 2;
  }

  const validation = validateName(argv[1]);
  if (validation.error) return refusal(validation.error);

  const store = await openStore({ env: ctx.env });
  const prior = await readSessions(store.stateDir);
  const resolved = resolveSessionRef(prior.records.map((entry) => entry.record), argv[0]);
  if (resolved.error) return refusal(resolved.error);

  const updated = applyName(resolved.record, validation.value, { at: Date.now() });
  await store.writeSession(updated.id, updated);
  process.stdout.write(`${updated.agent.sessionId} -> ${updated.name}\n`);
  return 0;
}
