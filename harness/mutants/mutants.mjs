// Hand-curated mutants. Each entry names a source file, an exact substring to
// find and replace, and the test file(s) responsible for turning red once the
// mutation lands. A claimed test must not depend on `.git`, network, or
// anything outside the tree the runner copies -- a test that needs `.git` in
// a `.git`-less temp copy would "kill" every mutant it's handed regardless of
// the mutation, which proves nothing. That is why `test/repo-hygiene.test.mjs`
// (it shells out to git) never appears in a `claimedBy` list here.

export const MUTANTS = Object.freeze([
  Object.freeze({
    id: 'MUT-REFUSE-R1',
    file: 'src/core/refuse.js',
    find: `  Object.freeze({ id: 'R1', title: "answer a permission prompt on the human's behalf, through any channel", since: 0 }),\n`,
    replace: '',
    claimedBy: Object.freeze(['test/refuse-rules.test.mjs']),
    why: 'deleting a refuse rule must turn a test red',
  }),
  Object.freeze({
    id: 'MUT-REFUSE-R2',
    file: 'src/core/refuse.js',
    find: `  Object.freeze({ id: 'R2', title: "write another program's config in place, or repair a drift it detected", since: 0 }),\n`,
    replace: '',
    claimedBy: Object.freeze(['test/refuse-rules.test.mjs']),
    why: 'deleting a refuse rule must turn a test red',
  }),
  Object.freeze({
    id: 'MUT-REFUSE-R3',
    file: 'src/core/refuse.js',
    find: `  Object.freeze({ id: 'R3', title: 'route model-authored free text into another live agent session', since: 0 }),\n`,
    replace: '',
    claimedBy: Object.freeze(['test/refuse-rules.test.mjs']),
    why: 'deleting a refuse rule must turn a test red',
  }),
  Object.freeze({
    id: 'MUT-REFUSE-R4',
    file: 'src/core/refuse.js',
    find: `  Object.freeze({ id: 'R4', title: 'auto-inject a handoff into a session the human did not explicitly resume', since: 0 }),\n`,
    replace: '',
    claimedBy: Object.freeze(['test/refuse-rules.test.mjs']),
    why: 'deleting a refuse rule must turn a test red',
  }),
  Object.freeze({
    id: 'MUT-REFUSE-R5',
    file: 'src/core/refuse.js',
    find: `  Object.freeze({ id: 'R5', title: 'run a mutating verb while inside an agent session', since: 0 }),\n`,
    replace: '',
    claimedBy: Object.freeze(['test/refuse-rules.test.mjs']),
    why: 'deleting a refuse rule must turn a test red',
  }),
  Object.freeze({
    id: 'MUT-REFUSE-R6',
    file: 'src/core/refuse.js',
    find: `  Object.freeze({ id: 'R6', title: 'write to a pane whose binding is not spawn-, agent-, or human-asserted and freshly revalidated', since: 0 }),\n`,
    replace: '',
    claimedBy: Object.freeze(['test/refuse-rules.test.mjs']),
    why: 'deleting a refuse rule must turn a test red',
  }),
  Object.freeze({
    id: 'MUT-REFUSE-R7',
    file: 'src/core/refuse.js',
    find: `  Object.freeze({ id: 'R7', title: 'answer the same prompt twice; one attempt, then escalate loudly', since: 0 }),\n`,
    replace: '',
    claimedBy: Object.freeze(['test/refuse-rules.test.mjs']),
    why: 'deleting a refuse rule must turn a test red',
  }),
  Object.freeze({
    id: 'MUT-REFUSE-R8',
    file: 'src/core/refuse.js',
    find: `  Object.freeze({ id: 'R8', title: 'pass a dangerous bypass flag, hook-disable, or hook-trust bypass to a spawned CLI', since: 0 }),\n`,
    replace: '',
    claimedBy: Object.freeze(['test/refuse-rules.test.mjs']),
    why: 'deleting a refuse rule must turn a test red',
  }),
  Object.freeze({
    id: 'MUT-REFUSE-R9',
    file: 'src/core/refuse.js',
    find: `  Object.freeze({ id: 'R9', title: "act on asterism's own state or binary when identity.json's sha does not match", since: 0 }),\n`,
    replace: '',
    claimedBy: Object.freeze(['test/refuse-rules.test.mjs']),
    why: 'deleting a refuse rule must turn a test red',
  }),
  Object.freeze({
    id: 'MUT-REFUSE-NOOP',
    file: 'src/core/refuse.js',
    find: `        return { rule: 'R5', adapter: adapter.id, marker };`,
    replace: `        return null;`,
    claimedBy: Object.freeze(['test/refuse-rules.test.mjs']),
    why: 'a refusal check that can never fire is the same as no check at all',
  }),
  Object.freeze({
    id: 'MUT-PRIORITY-NOW',
    file: 'src/core/enums.js',
    find: `  High: 'high',\n});`,
    replace: `  High: 'high',\n  Now: 'now',\n});`,
    claimedBy: Object.freeze(['test/enums.test.mjs']),
    why: "an external system must not be able to preempt the user's turn",
  }),
  Object.freeze({
    id: 'MUT-VERB-REGEX',
    file: 'bin/ast',
    find: `  if (!VERB_NAME.test(verbName)) return null;`,
    replace: `  if (VERB_NAME.test(verbName)) return null;`,
    claimedBy: Object.freeze(['test/cli.test.mjs']),
    why: 'flipping the verb-name guard\'s negation lets a name like ".." or "/" through while rejecting real verbs -- the appended ".js" suffix keeps this repo\'s two traversal probes ("..", "../version") from resolving to any file either way, so the observable kill comes from legitimate verbs (e.g. "version") now being rejected, not from a successful traversal',
  }),
  Object.freeze({
    id: 'MUT-SCAN-CASE',
    file: 'harness/secret-scan.mjs',
    find: `export function normalizeToken(token) {\n  return String(token).toLowerCase().replace(EDGE_PUNCTUATION, '');\n}`,
    replace: `export function normalizeToken(token) {\n  return String(token).replace(EDGE_PUNCTUATION, '');\n}`,
    claimedBy: Object.freeze(['test/secret-scan-normalizer.test.mjs']),
    why: 'a case-sensitive scanner misses a secret pasted with different capitalization',
  }),
]);
