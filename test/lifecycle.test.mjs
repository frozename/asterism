import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  isLegal,
  LIFECYCLE_EVENTS,
  LIFECYCLE_STATES,
  LifecycleVocabularyError,
  transition,
} from '../src/core/lifecycle.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

function lifecycleTableVocabularyOffenses(source) {
  const parseVocabulary = (name) => {
    const match = new RegExp(`export const ${name} = Object\\.freeze\\(\\[([^\\]]*)\\]\\);`).exec(source);
    assert.ok(match, `${name} declaration was not parseable`);
    return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
  };
  const states = new Set(parseVocabulary('LIFECYCLE_STATES'));
  const events = new Set(parseVocabulary('LIFECYCLE_EVENTS'));
  const tableMatch = /const TABLE = Object\.freeze\(\{([\s\S]*?)\n\}\);/.exec(source);
  assert.ok(tableMatch, 'TABLE declaration was not parseable');
  const rows = [...tableMatch[1].matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*): Object\.freeze\(\{([^}]*)\}\),$/gm)];
  assert.ok(rows.length > 0, 'TABLE held no parseable rows');

  const offenses = [];
  for (const [, state, row] of rows) {
    if (!states.has(state)) offenses.push(`TABLE state ${state} is absent from LIFECYCLE_STATES`);
    for (const match of row.matchAll(/(?:^|,)\s*([A-Za-z][A-Za-z0-9]*)\s*:/g)) {
      if (!events.has(match[1])) offenses.push(`TABLE event ${state}.${match[1]} is absent from LIFECYCLE_EVENTS`);
    }
  }
  return offenses;
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

test('private TABLE keys are all declared in the public lifecycle vocabulary', () => {
  const source = readFileSync(path.join(ROOT, 'src', 'core', 'lifecycle.js'), 'utf8');
  assert.deepEqual(lifecycleTableVocabularyOffenses(source), []);
});

test('lifecycle TABLE vocabulary checker flags synthetic stray state and event keys', () => {
  const synthetic = `export const LIFECYCLE_STATES = Object.freeze(['Live']);
export const LIFECYCLE_EVENTS = Object.freeze(['park']);
const TABLE = Object.freeze({
  Live: Object.freeze({ park: 'Live', resume: 'Live' }),
  Dormant: Object.freeze({}),
});`;
  assert.deepEqual(lifecycleTableVocabularyOffenses(synthetic), [
    'TABLE event Live.resume is absent from LIFECYCLE_EVENTS',
    'TABLE state Dormant is absent from LIFECYCLE_STATES',
  ]);
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

test('unknown state throws LifecycleVocabularyError while a known transition remains accepted', () => {
  const error = thrown(() => transition('Dormant', 'park'));

  assert.equal(error?.constructor, LifecycleVocabularyError);
  assert.equal(error instanceof TypeError, true);
  assert.equal(error?.message, 'lifecycle: unknown state "Dormant"');
  assert.equal(transition('Live', 'park'), 'Parked');
});

test('unknown event throws LifecycleVocabularyError while a known transition remains accepted', () => {
  const error = thrown(() => transition('Live', 'resume'));

  assert.equal(error?.constructor, LifecycleVocabularyError);
  assert.equal(error instanceof TypeError, true);
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

  assert.equal(stateError?.constructor, LifecycleVocabularyError);
  assert.equal(stateError instanceof TypeError, true);
  assert.equal(stateError?.message, 'lifecycle: unknown state "Dormant"');
  assert.equal(eventError?.constructor, LifecycleVocabularyError);
  assert.equal(eventError instanceof TypeError, true);
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
