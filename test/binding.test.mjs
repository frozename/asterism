import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BINDING_STATES,
  descendsFrom,
  parseVendorPaneWitness,
  STRONG_WITNESSES,
  transition,
  WEAK_WITNESSES,
  writable,
} from '../src/core/binding.js';

// ---- the exhaustive table: 4 states x 8 events = 32 cells ----

const TRANSITION_TABLE = [
  ['Unbound', { type: 'witness', by: 'SpawnMinted' }, 'Bound'],
  ['Unbound', { type: 'witness', by: 'AgentAsserted' }, 'Bound'],
  ['Unbound', { type: 'witness', by: 'HumanAsserted' }, 'Bound'],
  ['Unbound', { type: 'witness', by: 'VendorRegistry' }, 'Candidate'],
  ['Unbound', { type: 'witness', by: 'Heuristic' }, 'Candidate'],
  ['Unbound', { type: 'server-pid-mismatch' }, 'Unbound'],
  ['Unbound', { type: 'pane-dead' }, 'Poisoned'],
  ['Unbound', { type: 'pid-absent' }, 'Poisoned'],

  ['Candidate', { type: 'witness', by: 'SpawnMinted' }, 'Bound'],
  ['Candidate', { type: 'witness', by: 'AgentAsserted' }, 'Bound'],
  ['Candidate', { type: 'witness', by: 'HumanAsserted' }, 'Bound'],
  ['Candidate', { type: 'witness', by: 'VendorRegistry' }, 'Candidate'],
  ['Candidate', { type: 'witness', by: 'Heuristic' }, 'Candidate'],
  ['Candidate', { type: 'server-pid-mismatch' }, 'Unbound'],
  ['Candidate', { type: 'pane-dead' }, 'Poisoned'],
  ['Candidate', { type: 'pid-absent' }, 'Poisoned'],

  ['Bound', { type: 'witness', by: 'SpawnMinted' }, 'Bound'],
  ['Bound', { type: 'witness', by: 'AgentAsserted' }, 'Bound'],
  ['Bound', { type: 'witness', by: 'HumanAsserted' }, 'Bound'],
  ['Bound', { type: 'witness', by: 'VendorRegistry' }, 'Bound'],
  ['Bound', { type: 'witness', by: 'Heuristic' }, 'Bound'],
  ['Bound', { type: 'server-pid-mismatch' }, 'Unbound'],
  ['Bound', { type: 'pane-dead' }, 'Poisoned'],
  ['Bound', { type: 'pid-absent' }, 'Poisoned'],

  ['Poisoned', { type: 'witness', by: 'SpawnMinted' }, 'Poisoned'],
  ['Poisoned', { type: 'witness', by: 'AgentAsserted' }, 'Poisoned'],
  ['Poisoned', { type: 'witness', by: 'HumanAsserted' }, 'Poisoned'],
  ['Poisoned', { type: 'witness', by: 'VendorRegistry' }, 'Poisoned'],
  ['Poisoned', { type: 'witness', by: 'Heuristic' }, 'Poisoned'],
  ['Poisoned', { type: 'server-pid-mismatch' }, 'Poisoned'],
  ['Poisoned', { type: 'pane-dead' }, 'Poisoned'],
  ['Poisoned', { type: 'pid-absent' }, 'Poisoned'],
];

test('exhaustive table: all 4 states x 8 events match the expected transition (32 cells)', () => {
  assert.equal(TRANSITION_TABLE.length, 32);
  for (const [state, event, expected] of TRANSITION_TABLE) {
    assert.equal(transition(state, event), expected, `${state} + ${JSON.stringify(event)}`);
  }
});

test('a weak witness is never Bound unless the state already was Bound (kill-shot for a heuristic-to-Bound bug)', () => {
  for (const state of BINDING_STATES) {
    for (const by of WEAK_WITNESSES) {
      const result = transition(state, { type: 'witness', by });
      if (state !== 'Bound') {
        assert.notEqual(result, 'Bound', `${state} + weak witness(${by}) must not become Bound`);
      }
    }
  }
});

test('control: a strong witness from Candidate IS Bound; a weak witness from Candidate is not', () => {
  assert.equal(transition('Candidate', { type: 'witness', by: 'SpawnMinted' }), 'Bound');
  assert.notEqual(transition('Candidate', { type: 'witness', by: 'VendorRegistry' }), 'Bound');
});

// ---- writable ----

test('writable: every strong by with state Bound is writable', () => {
  for (const by of STRONG_WITNESSES) {
    assert.equal(writable({ state: 'Bound', by }), true);
  }
});

test('writable: every weak by is not writable, even with state forced to Bound', () => {
  for (const by of WEAK_WITNESSES) {
    assert.equal(writable({ state: 'Bound', by }), false);
  }
});

test('writable: Candidate/Unbound/Poisoned are never writable regardless of by', () => {
  for (const state of ['Candidate', 'Unbound', 'Poisoned']) {
    for (const by of [...STRONG_WITNESSES, ...WEAK_WITNESSES]) {
      assert.equal(writable({ state, by }), false);
    }
  }
});

// ---- parseVendorPaneWitness ----

test('parseVendorPaneWitness: right-to-left parse of session:@window.%pane, session name discarded', () => {
  const cases = [
    ['0:@0.%0', { windowId: '@0', paneId: '%0' }],
    ['my:sess.io:@12.%34', { windowId: '@12', paneId: '%34' }],
    ['sess:@3.%7', { windowId: '@3', paneId: '%7' }],
  ];

  for (const [input, expected] of cases) {
    const result = parseVendorPaneWitness(input);
    assert.deepEqual(result, expected);
    assert.deepEqual(Object.keys(result).sort(), ['paneId', 'windowId']);
  }

  // must-hit control: the discarded session name never appears in the result.
  const withName = parseVendorPaneWitness('my:sess.io:@12.%34');
  assert.ok(!JSON.stringify(withName).includes('my:sess.io'));
});

test('parseVendorPaneWitness rejects malformed witnesses to null', () => {
  for (const input of ['sess:@3.7', 'sess:@x.%7', 'sess.%7', '', 42]) {
    assert.equal(parseVendorPaneWitness(input), null);
  }
});

// ---- descendsFrom ----

test('descendsFrom over an injected pid table: chain 300 -> 200 -> 100', () => {
  const table = new Map([
    [300, 200],
    [200, 100],
  ]);
  assert.equal(descendsFrom(table, 300, 100), true);
  assert.equal(descendsFrom(table, 300, 300), true);
  assert.equal(descendsFrom(table, 100, 300), false);
  assert.equal(descendsFrom(table, 999, 100), false);
});

test('descendsFrom returns false on a cyclic table instead of looping forever', () => {
  const table = new Map([
    [1, 2],
    [2, 1],
  ]);
  assert.equal(descendsFrom(table, 1, 999), false);
});

test('descendsFrom throws on a non-number pid', () => {
  const table = new Map([[300, 200]]);
  assert.throws(() => descendsFrom(table, '300', 200), TypeError);
  assert.throws(() => descendsFrom(table, 300, '200'), TypeError);
});

// ---- invalid transition inputs ----

test('transition throws TypeError on unknown state, unknown event type, or unknown by -- beside a legal-input control', () => {
  assert.throws(() => transition('Bogus', { type: 'server-pid-mismatch' }), TypeError);
  assert.throws(() => transition('Unbound', { type: 'bogus-event' }), TypeError);
  assert.throws(() => transition('Unbound', { type: 'witness', by: 'BogusWitness' }), TypeError);

  assert.equal(transition('Unbound', { type: 'server-pid-mismatch' }), 'Unbound');
});
