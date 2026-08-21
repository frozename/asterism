# AGENTS.md

Canonical, vendor-neutral instructions for any tool or person working in this
repo. Vendor-specific pointer files at the repo root defer to this one; they
must not disagree with it.

## `.gitignore` and `LICENSE` are append-only

Never regenerate, rewrite, or reformat either file. An ordinary "scaffold a
`.gitignore`" or "rewrite my `LICENSE`" command drops every existing rule
silently, and the next `git add -A` stages what those rules were excluding --
into a public, MIT-licensed history that cannot be retracted. Edit by
appending only.

Corollary: stage explicit paths. Use `git add path/one path/two`. Never
`git add -A`, never `git add .`.

## Ignore rules are pinned by a test

`test/ignore-rules.test.mjs` asserts load-bearing ignore rules by effect: it
runs `git check-ignore --no-index` against protected paths instead of checking
that rule text appears in `.gitignore`, because a present rule can be shadowed
by a later negation and still do nothing. It also asserts matching controls are
not ignored; a check that can only answer one way proves nothing, and a
malformed invocation can answer "ignored" for every input.

The test separately asserts that the set `git add -A` would stage contains no
protected path. It fails closed: a missing `.gitignore`, or a `check-ignore`
exit code other than 0 or 1, is a failure and never a skip. If you add a
load-bearing rule to `.gitignore`, add it to that test too, or it is not
actually guarded.

## Zero runtime dependencies

`package.json` has no `dependencies` and no `devDependencies` key. Do not
`npm install` or `bun install`, do not add a lockfile, do not create
`node_modules/`. Enforced by `test/no-deps.test.mjs`.

## `npm test` is bare `node --test`

Node's default discovery scans the tree for `*.test.mjs`. Passing a directory
-- `node --test test/` -- makes Node resolve that argument as a module specifier
and run only `test/index.js`; every other test file is silently skipped.
Pinned by `test/test-discovery.test.mjs`.

## Both runners must be green

`node --test` and `bun test` both exit 0. A divergence between them is a
portability signal about the code under test -- investigate it, don't paper
over it.

## Test naming

Tests live in `test/` and are named `*.test.mjs` -- the default pattern both
runners use.

## Banned shell APIs

No `child_process.exec`, no `execSync`, no `{ shell: true }`. Use `execFile`
or `spawn` with an argv array. Any path that hands a shell a string it built
from a value it did not mint executes whatever that value contains.

Match the style already in `harness/secret-scan.mjs`: named `export function`,
`node:`-prefixed builtins, `execFile` promisified through `node:util`.

## Secret and PII scan

`test/repo-hygiene.test.mjs` runs `harness/secret-scan.mjs` over both the
files `git add -A` would stage (the union of `git ls-files --cached` and
`git ls-files --others --exclude-standard`) and the messages of every
unpushed commit reachable from `HEAD`. With no upstream configured -- this
repository's current state -- the commit-message scan falls back to every
commit reachable by `git log --all`; that coverage narrows silently once an
upstream is set. It tokenises the input, slides a 1-to-4-token window,
sha256-hashes each window, and checks each hash against a fixture of digests --
so the plaintext values are never stored in the repo. A finding reports a
location and a hash, never the matched text.

The one thing it cannot see: it fires only on values whose digest is already
in the fixture. Fresh prose someone writes into a commit-message body or an
ignore-file comment isn't a pre-digested value and won't match; that content
needs a human read.

## Before you commit

```
node --test
bun test
git status --short
git diff --stat HEAD
```

`git status --short` covers untracked files and `git diff --stat HEAD` covers
tracked ones, so the two together are the whole change. Neither names a branch,
a remote, or an ancestor count -- `test/agents-doc.test.mjs` pins that, because
a command that needs a ref the reader's clone lacks does not fail loudly. Wrap
`git merge-base main HEAD` in a command substitution and it exits 128 into a
discarded stderr, leaving `git diff --stat ..HEAD` to print nothing and exit 0.
The reader is told their change is empty.

Stage explicit paths (`git add <exact paths>`), then commit once with a
neutral imperative subject.

## Commit conventions

Commit messages must satisfy the repository validator in
`harness/commitlint.mjs`. Use a required type and scope, an imperative
lowercase subject, and the documented header/body limits. The current source
directory scopes are derived from `src/` when the validator starts.

`test/commit-format.test.mjs` pins the accepted and rejected vectors, the CLI,
the hook behavior, and synthetic multi-message parsing. See `CONTRIBUTING.md`
for the format, scope vocabulary, hook setup, and verification commands.
