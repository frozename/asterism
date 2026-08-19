# asterism

A command-line tool, in early development, for working across several coding-agent CLI
sessions at once when each session lives in its own tmux pane.

> asterism is not usable yet. No product code is in the tree; what is checked in
> today is the test harness and repository-hygiene guards that future code will
> have to pass.

## What it is for

asterism is designed to own the association between a tmux pane and the coding-agent CLI
session running inside it: which sessions exist, which pane each one is in, and how to
jump to a session by name. Its intended uses are working with many sessions at the same
time, carrying context from one session into another, and following a session through its
lifecycle.

## Approach

asterism will read the structured session state its targets already write to disk. It will
not scrape rendered terminal output. That is an architectural position rather than a
performance tradeoff: where a target publishes no structured channel for something, the
corresponding feature will be absent, not approximated from a screen read.

asterism will never answer a permission prompt. No code path will exist for it to enable.

Runtime dependencies: zero. This is enforced by `test/no-deps.test.mjs`, which fails the
suite if `package.json` grows a `dependencies` or `devDependencies` key or a `node_modules`
directory appears at the root.

asterism is not a tmux session manager, not an installer that edits another program's
configuration tree, and not a version manager.

## Status

The current tree is the harness described above; future product code will have to satisfy
it. For the current inventory, run `git ls-files`.

The suite covers the zero-dependency policy in `test/no-deps.test.mjs`; runner discovery in
`test/test-discovery.test.mjs`, which pins the test script against the directory-argument
form that silently reduces the run; and repository hygiene in `test/repo-hygiene.test.mjs`.
The hygiene tests include a digest-based secret scan over tracked files, untracked files
visible through Git's exclude-standard file list, and unpushed commit messages; it compares
hashes of normalized token windows, so the values themselves are never stored. Ignore-rule
coverage lives in `test/ignore-rules.test.mjs`, which asserts load-bearing rules by effect
via `git check-ignore` and pairs them with a control set of paths asserted not ignored.

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
