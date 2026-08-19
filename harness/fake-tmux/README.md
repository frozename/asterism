# fake-tmux

A PATH shim named `tmux` that records the argv it was called with and
replays canned output, so a test can assert "did asterism call tmux
correctly" without a real tmux server.

## Using it in a test

Put this directory first on the spawned process's `PATH`:

```js
const env = {
  PATH: `${path.join(ROOT, 'harness', 'fake-tmux')}:${process.env.PATH}`,
  ASTERISM_FAKE_TMUX_LOG: logPath,
  ASTERISM_FAKE_TMUX_FIXTURES: fixturesDir,
};
```

## Environment variables

- `ASTERISM_FAKE_TMUX_LOG` (required): path to a JSONL file. Every
  invocation appends one line `{"argv":[...],"cwd":"...","at":"<ISO>"}`.
  Unset, the shim exits 70 without running anything else.
- `ASTERISM_FAKE_TMUX_FIXTURES` (required unless the call is `-V`): a
  directory of canned responses. `<key>.out` is written to stdout
  verbatim (binary-safe); `<key>.rc` holds the exit code (default 0). No
  fixture for the key: exit 127.
- `ASTERISM_FAKE_TMUX_VERSION` (optional): version string for `-V`,
  default `3.7c`.

## Fixture-key rule

The key is the subcommand: skip leading global options and their values
(`-u`, `-2`, `-C`, `-L <x>`, `-S <x>`, `-f <x>`, `-T <x>`), then take the
first remaining argument — e.g. `list-panes`, `send-keys`.

## Blind spot

Canned output cannot reveal a flag whose effect is invisible in the
output — the shim cannot tell you that a flag was honored, only that it
was passed. Any test relying on that distinction must say so.
