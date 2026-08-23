# asterism

A command-line tool for working across coding-agent CLI sessions in tmux panes.

## What it is for

asterism records the association between a tmux pane and the coding-agent CLI session
running inside it. It discovers sessions, lists them with sessions needing attention
first, moves a tmux client to a selected session, and tracks session names and lifecycle
state.

## Approach

asterism reads structured session state published by registered adapters. It does not
scrape rendered terminal output. Where an adapter exposes no structured channel for a
fact, asterism does not approximate that fact from screen contents.

asterism does not answer permission prompts.

Runtime dependencies: zero. This is enforced by `test/no-deps.test.mjs`, which fails the
suite if `package.json` grows a `dependencies` or `devDependencies` key or a `node_modules`
directory appears at the root.

`bin/ast` dispatches command modules from `src/cli/verbs/`. With no verb, it runs `ast ls`.
The implementation also contains adapter contracts, session reconciliation, binding and
lifecycle models, state and configuration I/O, schemas, diagnostics, and repository
guards. [ARCHITECTURE.md](ARCHITECTURE.md) describes these boundaries and cites their
implementations and tests.

The suite covers the zero-dependency policy in `test/no-deps.test.mjs`; runner discovery in
`test/test-discovery.test.mjs`, which pins the test script against the directory-argument
form that silently reduces the run; and repository hygiene in `test/repo-hygiene.test.mjs`.
The hygiene tests include a digest-based secret scan over tracked files, untracked files
visible through Git's exclude-standard file list, and unpushed commit messages; it compares
hashes of normalized token windows, so the values themselves are never stored. Ignore-rule
coverage lives in `test/ignore-rules.test.mjs`, which asserts load-bearing rules by effect
via `git check-ignore` and pairs them with a control set of paths asserted not ignored.

## Verbs

`bin/ast <verb>` dispatches to one of the following modules under `src/cli/verbs/`.

| Verb | What it does | Mutating |
| --- | --- | --- |
| `ast archive` | moves a live or parked session into the archive | yes |
| `ast bind` | binds an agent session to a tmux pane | yes |
| `ast doctor` | runs every registered health check and reports its aggregate result | no |
| `ast fixture` | captures a scrubbed fixture cell or lists known cells | yes |
| `ast go` | moves a tmux client to an agent session | yes |
| `ast init` | installs state, hooks, keybindings, and completion | yes |
| `ast ls` | lists discovered agent sessions with blocked sessions first | no |
| `ast name` | sets a display name for an agent session | yes |
| `ast new` | launches an agent in a new tmux window with an authoritative binding | yes |
| `ast park` | parks a live agent session | yes |
| `ast probe` | probes an installed agent CLI for known symbols | no |
| `ast snapshot` | captures restorable agent session metadata | yes |
| `ast uninstall` | removes installed hooks, keybindings, and completion | yes |
| `ast unpark` | returns a parked agent session to live | yes |
| `ast version` | prints the installed asterism version | no |

## Requirements

- Node >= 24. The version is declared in `package.json` under `engines`.
- Bun is optional. Every test in the suite is written to pass under both runners.

## Running the tests

```
npm test
bun test
```

Both must exit zero.

## License

MIT. See [LICENSE](LICENSE).
