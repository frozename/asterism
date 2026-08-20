import { UUID_PATTERN } from '../../core/uuid.js';

export function spawnArgv({ sessionId }) {
  if (!UUID_PATTERN.test(sessionId)) {
    throw new Error(`spawnArgv: sessionId ${JSON.stringify(sessionId)} must be a canonical lowercase UUID`);
  }
  return Object.freeze(['fake-agent', '--session-id', sessionId]);
}
