import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isLegal,
  LIFECYCLE_EVENTS,
  LIFECYCLE_STATES,
  transition,
} from '../src/core/lifecycle.js';

const EXPECTED = Object.freeze({
  'Live|park': 'Parked',
  'Live|unpark': null,
  'Live|archive': 'Archived',
  'Parked|park': null,
  'Parked|unpark': 'Live',
  'Parked|archive': 'Archived',
  'Archived|park': null,
  'Archived|unpark': null,
  'Archived|archive': null,
});

function thrown(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

test('lifecycle vocabulary is exact and frozen', () => {
  assert.deepEqual(LIFECYCLE_STATES, ['Live', 'Parked', 'Archived']);
  assert.deepEqual(LIFECYCLE_EVENTS, ['park', 'unpark', 'archive']);
  assert.equal(Object.isFrozen(LIFECYCLE_STATES), true);
  assert.equal(Object.isFrozen(LIFECYCLE_EVENTS), true);
});

test('the expected table exactly covers the lifecycle cartesian product', () => {
  const product = LIFECYCLE_STATES.flatMap((state) =>
    LIFECYCLE_EVENTS.map((event) => `${state}|${event}`),
  );
  const expectedKeys = Object.keys(EXPECTED);

  assert.equal(LIFECYCLE_STATES.length * LIFECYCLE_EVENTS.length, expectedKeys.length);
  assert.deepEqual(new Set(expectedKeys), new Set(product));
});

test('transition implements every legal and illegal table cell', () => {
  for (const state of LIFECYCLE_STATES) {
    for (const event of LIFECYCLE_EVENTS) {
      const key = `${state}|${event}`;
      const expected = EXPECTED[key];

      if (expected === null) {
        const error = thrown(() => transition(state, event));
        assert.equal(error?.constructor, Error, key);
        assert.equal(error?.message, `lifecycle: illegal transition "${state}" + "${event}"`, key);
      } else {
        assert.equal(transition(state, event), expected, key);
      }
    }
  }
});

test('unknown state throws TypeError while a known transition remains accepted', () => {
  const error = thrown(() => transition('Dormant', 'park'));

  assert.equal(error?.constructor, TypeError);
  assert.equal(error?.message, 'lifecycle: unknown state "Dormant"');
  assert.equal(transition('Live', 'park'), 'Parked');
});

test('unknown event throws TypeError while a known transition remains accepted', () => {
  const error = thrown(() => transition('Live', 'resume'));

  assert.equal(error?.constructor, TypeError);
  assert.equal(error?.message, 'lifecycle: unknown event "resume"');
  assert.equal(transition('Live', 'park'), 'Parked');
});

test('isLegal matches the independent expected table on every cell', () => {
  for (const state of LIFECYCLE_STATES) {
    for (const event of LIFECYCLE_EVENTS) {
      assert.equal(isLegal(state, event), EXPECTED[`${state}|${event}`] !== null, `${state}|${event}`);
    }
  }

  assert.equal(isLegal('Live', 'park'), true);
  assert.equal(isLegal('Parked', 'park'), false);
});

test('isLegal fails closed on unknown vocabulary', () => {
  const stateError = thrown(() => isLegal('Dormant', 'park'));
  const eventError = thrown(() => isLegal('Live', 'resume'));

  assert.equal(stateError?.constructor, TypeError);
  assert.equal(stateError?.message, 'lifecycle: unknown state "Dormant"');
  assert.equal(eventError?.constructor, TypeError);
  assert.equal(eventError?.message, 'lifecycle: unknown event "resume"');
  assert.equal(isLegal('Live', 'park'), true);
  assert.equal(isLegal('Parked', 'park'), false);
});

test('illegal transition errors name both the state and event and stay plain Error', () => {
  const error = thrown(() => transition('Parked', 'park'));

  assert.equal(error?.constructor, Error);
  assert.equal(error?.message, 'lifecycle: illegal transition "Parked" + "park"');
  assert.match(error.message, /Parked/);
  assert.match(error.message, /park/);
});

test('Archived is absorbing by rejecting every lifecycle event', () => {
  for (const event of LIFECYCLE_EVENTS) {
    const error = thrown(() => transition('Archived', event));
    assert.equal(error?.constructor, Error, event);
    assert.equal(error?.message, `lifecycle: illegal transition "Archived" + "${event}"`);
    assert.equal(isLegal('Archived', event), false);
  }
});
