# Commit conventions

The same shape as [iam1maker/hermes-bark](https://github.com/iam1maker/hermes-bark)
-- what you see in this repository's commit list. These are rules, not style
preferences.

## Branch and pull request flow

`main` is protected for everyone, the owner included:

- no direct pushes (`Changes must be made through a pull request`);
- the `build-and-test` check from `.github/workflows/ci.yml` must be green -- and a
  pull request does not run CI until the owner adds the `run-ci` label, so it sits at
  `Expected` until then (deliberate: a stranger's pull request must not spend a
  runner before anyone has read the diff). Only the `labeled` event is wired, so a
  push after the label leaves the check at `Expected` until the label is dropped
  and re-added. Outside contributors additionally need approval for each run
  (`all_external_contributors`), because a `pull_request` trigger written into a
  head branch still starts a run;
- the branch must be up to date with `main` before it merges (`strict`), so the
  check you saw green is the tree you merge;
- linear history, squash or rebase merge (merge commits are disabled);
- no force-push and no branch deletion;
- the head branch is deleted automatically on merge.

```bash
git switch -c fix/device-switch-timeout    # feat/..., fix/..., docs/..., chore/...
# ...edit, then rebuild and test, then commit...
git push -u origin fix/device-switch-timeout
gh pr create --fill      # the template asks for the evidence
gh pr edit --add-label run-ci          # starts CI
# after a later push, re-run it by dropping and re-adding the label:
gh pr edit --remove-label run-ci && gh pr edit --add-label run-ci
gh pr checks --watch     # waits for build-and-test
gh pr merge --squash --delete-branch
```

One branch per change, one squashed commit on `main`, and the PR body carries
the same evidence the commit body would.

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

## What a pull request is checked against

1. **Rebuild before you commit.** `node dev/typecheck.mjs && node dev/build.mjs &&
   bash tests/run.sh`; the generated `.mjs` files and `desktop/plugin.js` ship in
   the same commit as their sources. CI runs the build and fails when the working
   tree changes, so a forgotten rebuild is caught there instead of in review.
2. **No credential examples.** Guides call `scripts/api-call.py` (it reads the
   daemon token itself) instead of a `curl` line that expands a token variable.
   The plugin scanner treats that pattern as HIGH exfiltration, which flips the
   install verdict to CAUTION and blocks `hermes plugins install` for everyone
   who does not pass `--force`.
3. **ASCII outside the i18n payload.** User-facing text lives in
   `src/desktop/i18n/` (`types.ts` is the contract; `zh.ts` and `en.ts` hold the
   same key shape). `python3 scripts/cjk-scan.py .` must report only `zh.ts`.
4. **Record the version.** A user-visible change adds a `CHANGELOG.md` entry, and
   `plugin.yaml` keeps the same version as `dashboard/manifest.json`.

## Scope of a change

Keep documentation and metadata in sync with behaviour in the same commit:
`plugin.yaml`'s `label`, `dashboard/manifest.json`'s `name`/`label`, and the
README's claims are all part of the change that alters them.
