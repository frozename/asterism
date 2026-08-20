export const LIFECYCLE_STATES = Object.freeze(['Live', 'Parked', 'Archived']);
export const LIFECYCLE_EVENTS = Object.freeze(['park', 'unpark', 'archive']);
export class LifecycleVocabularyError extends TypeError {}

// Archived is absorbing because Phase 2 deliberately has no unarchive verb.
// Repeating park or unpark is illegal, not idempotent: the refusal preserves
// the fact that a session was already in the requested state for the human.
// Throws on a legal-vocabulary-but-illegal state+event pair.
const TABLE = Object.freeze({
  Live: Object.freeze({ park: 'Parked', archive: 'Archived' }),
  Parked: Object.freeze({ unpark: 'Live', archive: 'Archived' }),
  Archived: Object.freeze({}),
});

function assertKnown(state, event) {
  if (!Object.hasOwn(TABLE, state)) {
    throw new LifecycleVocabularyError(`lifecycle: unknown state "${state}"`);
  }
  if (!LIFECYCLE_EVENTS.includes(event)) {
    throw new LifecycleVocabularyError(`lifecycle: unknown event "${event}"`);
  }
}

export function transition(state, event) {
  assertKnown(state, event);
  if (!Object.hasOwn(TABLE[state], event)) {
    throw new Error(`lifecycle: illegal transition "${state}" + "${event}"`);
  }
  return TABLE[state][event];
}

export function isLegal(state, event) {
  assertKnown(state, event);
  return Object.hasOwn(TABLE[state], event);
}
