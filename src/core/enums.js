export const NoteKind = Object.freeze({
  Result: 'result',
  Handoff: 'handoff',
  Message: 'message',
});

// Deliberately no `now`/`urgent` value: an external system may not preempt
// the user's turn.
export const Priority = Object.freeze({
  Low: 'low',
  Normal: 'normal',
  High: 'high',
});

export const NOTE_KINDS = Object.freeze(Object.values(NoteKind));
export const PRIORITIES = Object.freeze(Object.values(Priority));

export function isNoteKind(value) {
  return NOTE_KINDS.includes(value);
}

export function isPriority(value) {
  return PRIORITIES.includes(value);
}
