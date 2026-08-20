export const BINDING_STATES = Object.freeze(['Unbound', 'Candidate', 'Bound', 'Poisoned']);
export const STRONG_WITNESSES = Object.freeze(['SpawnMinted', 'AgentAsserted', 'HumanAsserted']);
export const WEAK_WITNESSES = Object.freeze(['VendorRegistry', 'Heuristic']);

const WITNESS_BY_VALUES = new Set([...STRONG_WITNESSES, ...WEAK_WITNESSES]);
const EVENT_TYPES = new Set(['witness', 'server-pid-mismatch', 'pane-dead', 'pid-absent']);

// A total function over the event vocabulary: every (state, event) pair below
// resolves to a state, never undefined. Poisoned is absorbing; a weak witness
// (VendorRegistry, Heuristic) can reach Candidate but never Bound on its own --
// there is no code path from a weak witness to Bound.
export function transition(state, event) {
  if (!BINDING_STATES.includes(state)) {
    throw new TypeError(`binding: unknown state "${state}"`);
  }
  if (event === null || typeof event !== 'object' || !EVENT_TYPES.has(event.type)) {
    throw new TypeError(`binding: unknown event type "${event?.type}"`);
  }
  if (event.type === 'witness' && !WITNESS_BY_VALUES.has(event.by)) {
    throw new TypeError(`binding: unknown witness "by" value "${event.by}"`);
  }

  if (state === 'Poisoned') return 'Poisoned';
  if (event.type === 'pane-dead' || event.type === 'pid-absent') return 'Poisoned';
  if (event.type === 'server-pid-mismatch') return 'Unbound';

  if (STRONG_WITNESSES.includes(event.by)) return 'Bound';
  return state === 'Bound' ? 'Bound' : 'Candidate';
}

export function writable(binding) {
  return binding.state === 'Bound' && STRONG_WITNESSES.includes(binding.by);
}

const PANE_ID_PATTERN = /^%\d+$/;
const WINDOW_TAIL_PATTERN = /(?:^|:)(@\d+)$/;

// The vendor pane witness is "session:@window.%pane"; a session NAME may
// itself contain ":" and ".", so the id components must be peeled off from
// the right: last "." separates the pane, then the trailing "@N" of what is
// left separates the window. The name is discarded, never returned.
export function parseVendorPaneWitness(value) {
  if (typeof value !== 'string') return null;

  const dotIndex = value.lastIndexOf('.');
  if (dotIndex === -1) return null;

  const paneId = value.slice(dotIndex + 1);
  if (!PANE_ID_PATTERN.test(paneId)) return null;

  const remainder = value.slice(0, dotIndex);
  const windowMatch = WINDOW_TAIL_PATTERN.exec(remainder);
  if (windowMatch === null) return null;

  return Object.freeze({ windowId: windowMatch[1], paneId });
}

export function descendsFrom(pidTable, childPid, ancestorPid) {
  if (typeof childPid !== 'number' || typeof ancestorPid !== 'number') {
    throw new TypeError('descendsFrom: childPid and ancestorPid must be numbers');
  }
  if (childPid === ancestorPid) return true;

  const visited = new Set([childPid]);
  let current = childPid;

  while (pidTable.has(current)) {
    const parent = pidTable.get(current);
    if (parent === ancestorPid) return true;
    if (visited.has(parent)) return false;
    visited.add(parent);
    current = parent;
  }

  return false;
}
