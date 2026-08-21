# Contributing

## Commit messages

Use this header format:

```text
<type>(<scope>): <subject>
```

Add `!` before the colon for a breaking change, for example
`feat(cli)!: replace the command grammar`.

The scope is required. The subject must use imperative mood, begin with a
lowercase letter, contain 1-72 characters, and have no trailing period. The
complete header must be no longer than 72 characters. Put a blank line before
any body, and keep each body line to 100 characters or fewer.

| Type | Use for |
| --- | --- |
| `feat` | New behavior |
| `fix` | A defect correction |
| `refactor` | Internal restructuring without a behavior change |
| `test` | Test-only changes |
| `docs` | Documentation-only changes |
| `chore` | Repository maintenance |
| `perf` | Performance improvements |
| `build` | Build or packaging changes |
| `ci` | Continuous-integration changes |

The fixed repository scopes are `bin`, `harness`, `test`, `ci`, and `docs`.
Every directory directly under `src/` is also a scope. The validator reads
those directories when it starts, so a new source area becomes available
without updating a hardcoded list.

Example:

```text
feat(cli): add ast new
```

To enable the repository hook in your checkout, run:

```sh
git config core.hooksPath .githooks
```

The hook calls `harness/commitlint.mjs`. You can also validate a message file
or stdin directly:

```sh
node harness/commitlint.mjs .git/COMMIT_EDITMSG
printf 'feat(cli): add ast new\n' | node harness/commitlint.mjs
```

The hook and direct command validate only the candidate message supplied to
them. `test/commit-format.test.mjs` covers the validator, CLI, hook, and
synthetic multi-message parsing; the test suite does not audit commit messages
from the repository's existing history.

Git cleanup comments follow `core.commentChar`. The default, an unset value,
an empty value, and `auto` all use `#`. Single-character and multi-character
strings such as `;` and `//` are supported as exact line prefixes. Values that
are not strings, or that contain a newline, are refused because they cannot
delimit one commit-message line unambiguously.

## Verification

Run all three gates before committing:

```sh
node --test
bun test
node harness/mutants/run.mjs
```

Both test runners must exit successfully, and every curated mutant must be
killed.

## Branches and staging

Keep changes on the assigned branch and worktree. Stage only the exact paths
that belong to the change:

```sh
git add path/one path/two
```

Never use `git add -A` or `git add .`. Review `git status --short` and the
branch diff before committing.
