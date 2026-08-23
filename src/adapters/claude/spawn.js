import { UUID_PATTERN } from '../../core/uuid.js';

export function spawnArgv({ sessionId }) {
  if (!UUID_PATTERN.test(sessionId)) {
    throw new Error(`spawnArgv: sessionId ${JSON.stringify(sessionId)} must be a canonical lowercase version-4 UUID`);
  }
  return Object.freeze(['claude', '--session-id', sessionId]);
}

export function resumeArgv({ sessionId }) {
  if (!UUID_PATTERN.test(sessionId)) {
    throw new Error(`resumeArgv: sessionId ${JSON.stringify(sessionId)} must be a canonical lowercase version-4 UUID`);
  }
  return Object.freeze(['claude', '--resume', sessionId]);
}
