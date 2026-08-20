import { transition } from './lifecycle.js';

export function applyLifecycle(record, event, { at }) {
  const lifecycle = transition(record.lifecycle ?? 'Live', event);
  const provenance = Object.freeze({ source: 'human', confidence: 'high', at });

  return Object.freeze({
    ...record,
    lifecycle,
    flags: Object.freeze({ ...record.flags, parked: lifecycle === 'Parked' }),
    prov: Object.freeze({
      ...record.prov,
      lifecycle: provenance,
      'flags.parked': provenance,
    }),
  });
}
