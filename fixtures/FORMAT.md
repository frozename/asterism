# Fixture format

`fixtures/` is the PARSE corpus: byte-exact captures of real program output,
sha256-pinned, never hand-edited. Nothing in this directory is synthesized;
every `raw` is what a real target actually wrote.

## Cell layout

One cell = one directory `fixtures/<cell-id>/` holding exactly two entries:

- `raw` -- the captured bytes after scrubbing, byte-exact. Never edited by
  hand; a hand edit changes the sha256 and the suite fails it as corrupted.
- `meta.json` -- the capture record:

```json
{
  "cell": "claude/help",
  "sha256": "<hex sha256 of raw>",
  "bytes": 1234,
  "capturedAt": "2026-08-19T00:00:00Z",
  "provokedBy": "what state was provoked and how",
  "command": ["claude", "--help"],
  "cliVersion": "1.2.3",
  "tmuxVersion": null,
  "profileHash": "<sha256 of the effective config file at capture time, or \"absent\">",
  "redactions": [{ "kind": "home-path", "offset": 12, "length": 9 }],
  "kills": ["mutant-id"]
}
```

`command` is the argv array that produced `raw`, or a free-text description
for a file read. `tmuxVersion` is required non-null for any tmux capture that
carries escape sequences. `kills` lists the mutant ids this fixture is
responsible for killing -- it is how a fixture claims a mutant.

## Rules

- A hand-edited `raw` fails the suite: its sha256 no longer matches
  `meta.sha256`.
- Redactions are length-preserving. A redaction never changes `raw`'s byte
  length, so offsets recorded elsewhere and column-alignment assertions
  against escape-sequence captures stay valid.
- `kills` is the only way a fixture claims a mutant; an empty array is a
  fixture that exists for coverage, not for mutation-killing.

## Cell-id grammar

```
^[a-z][a-z0-9-]*(/[a-z0-9][a-z0-9-]*)*$
```

For any capturable cell (`kind = "required"` or `kind = "manual"` in
`fixtures/MANIFEST.toml`), the first path segment is either an adapter id
registered in `src/adapters/index.js` or `tmux`.

## Where cells are enumerated

`fixtures/MANIFEST.toml` is the tri-state manifest: every cell this repo
knows about, whether it's required, manual, or not applicable yet, and why.
`test/manifest.test.mjs` reads it and reports capture progress on every run.
