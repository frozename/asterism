import { openStore } from '../io/store.js';
import { run as runNotification } from './events/notification.js';
import { run as runSessionStart } from './events/session-start.js';

export const STDIN_CAP_BYTES = 65536;

const EVENT_RUNNERS = Object.freeze({
  'session-start': runSessionStart,
  notification: runNotification,
});

export async function readStdinBounded(stream, cap = STDIN_CAP_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (total + bytes.length > cap) {
      chunks.push(bytes.subarray(0, cap - total));
      return { bytes: Buffer.concat(chunks, cap), truncated: true };
    }
    chunks.push(bytes);
    total += bytes.length;
  }
  return { bytes: Buffer.concat(chunks, total), truncated: false };
}

export async function runHook({ argv, stdin, env, adapters, platform, now, exec, random }) {
  const [adapterId, event] = argv;
  const adapter = adapters.get(adapterId);
  const runner = EVENT_RUNNERS[event];
  if (!adapter || !adapter.hooks || !runner || !adapter.hooks.events.includes(event)) return;

  try {
    const store = await openStore({ env });
    const input = await readStdinBounded(stdin);
    if (input.truncated) {
      await store.appendHookError(
        `${new Date(now()).toISOString()} ast-hook ${adapterId}/${event}: [truncated] stdin exceeded ${STDIN_CAP_BYTES} bytes`,
      );
      return;
    }

    const payload = JSON.parse(input.bytes.toString('utf8'));
    await runner({ adapter, adapterId, payload, env, store, now, random, exec, platform });
  } catch (error) {
    try {
      const store = await openStore({ env });
      await store.appendHookError(
        `${new Date(now()).toISOString()} ast-hook ${adapterId ?? '?'}/${event ?? '?'}: ${error.message}`,
      );
    } catch {}
  }
}
