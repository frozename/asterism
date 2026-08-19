import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isNoteKind,
  isPriority,
  NOTE_KINDS,
  NoteKind,
  Priority,
  PRIORITIES,
} from '../src/core/enums.js';

test('NoteKind is frozen with exactly the three expected values', () => {
  assert.ok(Object.isFrozen(NoteKind));
  assert.deepEqual(NoteKind, { Result: 'result', Handoff: 'handoff', Message: 'message' });
  assert.deepEqual(new Set(NOTE_KINDS), new Set(['result', 'handoff', 'message']));
  assert.equal(NOTE_KINDS.length, 3);
  assert.ok(Object.isFrozen(NOTE_KINDS));
});

test('Priority is frozen with exactly the three expected values and no preempting value', () => {
  assert.ok(Object.isFrozen(Priority));
  assert.deepEqual(Priority, { Low: 'low', Normal: 'normal', High: 'high' });
  assert.deepEqual(new Set(PRIORITIES), new Set(['low', 'normal', 'high']));
  assert.equal(PRIORITIES.length, 3);
  assert.ok(Object.isFrozen(PRIORITIES));
  assert.ok(!PRIORITIES.includes('now'));
  assert.ok(!PRIORITIES.includes('urgent'));
});

test('isNoteKind recognizes exactly the closed set', () => {
  for (const value of NOTE_KINDS) {
    assert.equal(isNoteKind(value), true, `${value} should be a valid NoteKind`);
  }
  assert.equal(isNoteKind('result'), true);
  assert.equal(isNoteKind('bogus'), false);
  assert.equal(isNoteKind(''), false);
  assert.equal(isNoteKind(undefined), false);
});

test('isPriority recognizes exactly the closed set and rejects a preempting value', () => {
  for (const value of PRIORITIES) {
    assert.equal(isPriority(value), true, `${value} should be a valid Priority`);
  }
  assert.equal(isPriority('now') === false, true);
  assert.equal(isPriority('urgent'), false);
  assert.equal(isPriority(undefined), false);
});
