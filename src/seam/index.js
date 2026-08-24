export function buildIndexPayload(records) {
  return {
    version: 1,
    sessions: records.map((record) => ({
      id: record.id,
      adapter: record.adapter,
      sessionId: record.agent.sessionId,
      status: record.observed.status,
      waitingFor: record.observed.waitingFor,
      lastSeen: record.observed.lastSeen,
      diedAt: record.diedAt,
      writeDisabled: record.flags.writeDisabled,
      reason: record.flags.reason,
    })),
  };
}

export async function writeSeamIndex(store, records, { now }) {
  await store.writeIndex(buildIndexPayload(records), { now });
}
