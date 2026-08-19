import assert from 'node:assert/strict';
import test from 'node:test';
import { adapters } from '../src/adapters/index.js';
import { REFUSE_RULES, refuseIfAgentInvoked, ruleById } from '../src/core/refuse.js';

test('exactly nine refuse rules, ids R1..R9 unique and in order', () => {
  assert.equal(REFUSE_RULES.length, 9);
  assert.deepEqual(
    REFUSE_RULES.map((rule) => rule.id),
    ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9'],
  );
});

test('the rule array and every member are frozen', () => {
  assert.ok(Object.isFrozen(REFUSE_RULES));
  for (const rule of REFUSE_RULES) {
    assert.ok(Object.isFrozen(rule), `rule ${rule.id} should be frozen`);
  }
});

test('ruleById resolves a known id and returns undefined for an unknown one', () => {
  const rule = ruleById('R5');
  assert.equal(rule.id, 'R5');
  assert.equal(rule.title, 'run a mutating verb while inside an agent session');
  assert.equal(ruleById('R99'), undefined);
});

test('every registered adapter marker triggers R5', () => {
  assert.ok(adapters.size > 0, 'expected at least one registered adapter');

  for (const adapter of adapters.values()) {
    assert.ok(adapter.agentEnvMarkers.length > 0, `${adapter.id} should list at least one marker`);

    for (const marker of adapter.agentEnvMarkers) {
      const result = refuseIfAgentInvoked({ [marker]: '' }, adapters);
      assert.deepEqual(result, { rule: 'R5', adapter: adapter.id, marker });
    }
  }
});

test('a clean environment, or one with only an unrelated key, does not refuse', () => {
  assert.equal(refuseIfAgentInvoked({}, adapters), null);
  assert.equal(refuseIfAgentInvoked({ SOME_UNRELATED_KEY: 'x' }, adapters), null);
});
