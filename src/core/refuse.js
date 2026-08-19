export const REFUSE_RULES = Object.freeze([
  Object.freeze({ id: 'R1', title: "answer a permission prompt on the human's behalf, through any channel", since: 0 }),
  Object.freeze({ id: 'R2', title: "write another program's config in place, or repair a drift it detected", since: 0 }),
  Object.freeze({ id: 'R3', title: 'route model-authored free text into another live agent session', since: 0 }),
  Object.freeze({ id: 'R4', title: 'auto-inject a handoff into a session the human did not explicitly resume', since: 0 }),
  Object.freeze({ id: 'R5', title: 'run a mutating verb while inside an agent session', since: 0 }),
  Object.freeze({ id: 'R6', title: 'write to a pane whose binding is not spawn-, agent-, or human-asserted and freshly revalidated', since: 0 }),
  Object.freeze({ id: 'R7', title: 'answer the same prompt twice; one attempt, then escalate loudly', since: 0 }),
  Object.freeze({ id: 'R8', title: 'pass a dangerous bypass flag, hook-disable, or hook-trust bypass to a spawned CLI', since: 0 }),
  Object.freeze({ id: 'R9', title: "act on asterism's own state or binary when identity.json's sha does not match", since: 0 }),
]);

export function ruleById(id) {
  return REFUSE_RULES.find((rule) => rule.id === id);
}

export function refuseIfAgentInvoked(env, adapters) {
  for (const adapter of adapters.values()) {
    for (const marker of adapter.agentEnvMarkers) {
      if (Object.hasOwn(env, marker)) {
        return { rule: 'R5', adapter: adapter.id, marker };
      }
    }
  }

  return null;
}
