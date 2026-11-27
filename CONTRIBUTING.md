# Commit conventions

The same shape as [iam1maker/hermes-bark](https://github.com/iam1maker/hermes-bark)
-- what you see in this repository's commit list. These are rules, not style
preferences.

## Shape

```text
type(scope): imperative lowercase sentence

why (what the problem was, which measurement pinned the root cause)
how it was changed, and where
- use a list when there is more than one place

Tests: bash tests/run.sh -> 73 assertions, 5/5 suites passed (only when behaviour was verifiable)
```

- **type** is one of `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`,
  `ci`, `chore`, `revert`. Do not invent compound types: `state:`,
  `docs+install:` and `rename:` are not valid.
- **scope** is optional, singular, lowercase, and names the layer that actually
  changed: `baton`, `sidecar`, `desktop`, `dashboard`, `install`, `docs`, `ts`.
  Use `fix(gateway)` only when gateway code changed; a wrong `name` in the
  plugin's own manifest is `fix(dashboard)`.
- **subject line**: imperative, all lowercase, no emoji, no trailing period, at
  most 72 columns. Say what changed. Two things joined by a comma are two
  commits.
- **body**: after one blank line, wrapped at 78 columns. Why first (including
  the evidence that proved it), then what changed where.
- **one change per commit**: code and docs do not share a commit, and the whole
  commit should be explainable in one sentence.

## What a good commit looks like

- `feat(baton): BLE voice remote as a Hermes input surface`
- `fix(install): keep the desktop copy marker-less so the pane shows on boot`
- `refactor(ts): rewrite the plugin's JavaScript surface in TypeScript`
- `fix(docs): drop the curl pipes the installer scanner flags as supply chain`

## What it should not look like

- `rename to baton, BATON_* env vars with REMOTE_MIC_* fallback, docs for one-line install`
  -- three concerns on one line, no type
- `state: keys.map shows only the current model's keys` -- `state` is not a
  valid type

## Products ship with their sources

`src/` is the source; `sidecar/**/*.mjs`, `desktop/plugin.js`, `scripts/*.mjs`
and `tests/*.mjs` are build products (see
[docs/TYPESCRIPT.md](docs/TYPESCRIPT.md)). After editing a source, run
`node dev/build.mjs`, and **commit the products in the same commit** -- otherwise
the profile keeps running the old code. Check before you commit:

```bash
node dev/typecheck.mjs && node dev/build.mjs && bash tests/run.sh
git status --porcelain          # no "product changed but not staged"
```

## Scope of a change

Keep documentation and metadata in sync with behaviour in the same commit:
`plugin.yaml`'s `label`, `dashboard/manifest.json`'s `name`/`label`, and the
README's claims are all part of the change that alters them.
