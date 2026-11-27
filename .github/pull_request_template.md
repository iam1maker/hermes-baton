## What this changes

<!-- One paragraph. What is different after this lands? -->

## Why

<!-- The problem, the measurement or the user report that pinned it down. -->

## Checks

- [ ] `node dev/typecheck.mjs && node dev/build.mjs && bash tests/run.sh` (paste the `SUMMARY` line)
- [ ] generated artifacts (`sidecar/**/*.mjs`, `scripts/*.mjs`, `tests/*.mjs`, `desktop/plugin.js`) committed with their sources
- [ ] `python3 scripts/cjk-scan.py .` reports only `src/desktop/i18n/zh.ts`
- [ ] user-facing text added to `src/desktop/i18n/zh.ts` **and** `en.ts`, same key shape, contract in `types.ts`
- [ ] `CHANGELOG.md` entry for a user-visible change; `plugin.yaml` and `dashboard/manifest.json` still carry the same version
- [ ] a hardware claim was measured on a real remote, or the description says it is untested

## Tests:

<!-- From CONTRIBUTING.md, e.g. "Tests: bash tests/run.sh -> 5/5 suites, 75 assertions" -->
