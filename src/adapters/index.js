import claude from './claude/index.js';
import fake from './fake/index.js';

export function buildRegistry(env) {
  if (env === null || typeof env !== 'object') {
    throw new Error('buildRegistry: env must be an object');
  }

  /** @type {Map<string, typeof claude | typeof fake>} */
  const registry = new Map([[claude.id, claude]]);

  if (typeof env.ASTERISM_FAKE_ROOT === 'string' && env.ASTERISM_FAKE_ROOT.length > 0) {
    registry.set(fake.id, fake);
  }

  return registry;
}

export const adapters = buildRegistry(process.env);
