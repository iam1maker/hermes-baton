# Development

What a contributor needs beyond [`README.md`](../README.md) and
[`CONTRIBUTING.md`](../CONTRIBUTING.md): the toolchain, what the suites cover, the
scripts that talk to a running install, the voice pipeline's parameters, and how to
install from a checkout.

## Source layout and build

Source is TypeScript under `src/`. The `sidecar/*.mjs`, `scripts/*.mjs`,
`tests/*.mjs` and `desktop/plugin.js` shipped in this repository are **build
products** and carry a `// GENERATED` banner: edit `src/`, never the products.
Extension rules and the four toolchain pitfalls are in
[`TYPESCRIPT.md`](TYPESCRIPT.md); why the runtime is split into five layers is in
[`DESIGN.md`](DESIGN.md).

```bash
cd dev && npm install --no-audit --no-fund   # once: typescript + esbuild + @types
node dev/typecheck.mjs                       # whole project (tsc --noEmit equivalent)
node dev/build.mjs                           # src/** -> the runtime artifacts

bash tests/run.sh                            # builds first, then 75 assertions
bash sidecar/native/build.sh                 # rebuild the universal bridge (Xcode CLT only)
```

## The test suites

| Suite | Assertions | Covers |
| --- | --- | --- |
| `tests/harness.mjs` | 13 | renderer: event stream, key engine, composer |
| `tests/model-precision.mjs` | 5 | int8/fp32 selection and fallbacks |
| `tests/hid-filter.mjs` | 12 | key ownership: active vs any |
| `tests/devices-registry.mjs` | 19 | JSON profiles -> key table, bridge args |
| `tests/profile-render.mjs` | 26 | per-device key rows, unknown-key handling, stt summary |

`tests/` needs nothing but `node`: it stubs the SDK, React and the transport, so
there is no Electron, gateway or hardware in the loop. The stubs live in
`tests/support/` and `run.sh` copies them into `tests/node_modules/` before
building, because a stub committed inside `node_modules` would be ignored by
`.gitignore` and a fresh clone would fail to import it.

## Scripts that talk to a running install

| Script | What it does |
| --- | --- |
| `scripts/api-call.py` | authenticated request to the local daemon; prints JSON |
| `scripts/switch-device.py` | hot-switch remotes and time it |
| `scripts/watch-keys.py` | tail key events out of the daemon |
| `scripts/fetch-models.mjs` | download the models and the native engine |
| `scripts/cjk-scan.py` | the ASCII gate CI runs |

All of them speak to the daemon over loopback with the token from the state
directory and need only the standard library, so they run under any `python3`.

Install paths are discovered rather than hardcoded: `BATON_STATE_DIR` and
`BATON_PORT` for an unusual layout, and `HERMES_HOME` for the profile copy.

### Why no gateway-probing script ships here

Checking which `/api/plugins/baton/*` routes the running gateway mounted means
attaching to the gateway session, which only exists as a private core seam
(`hermes_cli.gateway_client._session_ticket`). A plugin that imports it earns a
catalog rule 9 warning, and it can break on any Hermes release. The two scripts
that did this (`probe-routes.py`, `verify-gateway.py`) were therefore removed
from the published tree; the behaviour they check is covered by opening the
plugin page after a gateway reload, which is what they were standing in for.

## Voice pipeline

```text
remote holds key -> ATVV stream (codec 0x02 = 16 kHz ADPCM) -> bridge (Swift)
  -> daemon: ADPCM decode -> utterance buffer (350 ms silence gap, 30 s cap)
  -> trim 200 ms + 100 Hz high-pass -> 16 kHz mono WAV
  -> SenseVoice (sherpa-onnx, Silero VAD) -> text -> /events -> renderer
```

The utterance buffer closes on a 350 ms gap and is VAD-assisted: silence before
the first speech segment is trimmed, but the first syllable is padded so it
survives. `maxMs` caps one utterance at 30 s. Start trim adapts to length
(`min(trimMs, max(40, 12% of duration))`), and the 100 Hz high-pass removes the
DC/rumble that ADPCM leaves behind.

Precision is switchable at runtime. Each switch disposes the session and rebuilds
it, but ONNX Runtime's arena does not return memory immediately, so repeated
switches push RSS past 2.4 GiB until the daemon restarts. Model files, hashes,
mirrors and measured cost: [`models.md`](models.md).

Non-default layouts are served by `BATON_MODEL_DIR`, `BATON_VAD_MODEL`,
`BATON_MODEL_FILE` and `BATON_SHERPA`; `/state.transcriber` reports the resolved
paths, the precision in use and any fallback note.

## Installing from a checkout

```bash
bash scripts/install.sh <profile>                  # copy the plugin into a profile
bash scripts/install.sh <profile> --with-desktop   # also the renderer, app-wide
HERMES_HOME=~/.hermes/profiles/<profile> hermes plugins enable baton
```

`install.sh` copies `__init__.py`, `runtime.py`, `plugin.yaml`, `dashboard/`,
`sidecar/` (bridge, assets, device profiles), `scripts/`, `docs/`, `README.md`,
`LICENSE` and `desktop/plugin.js` when present. It never writes `config.yaml` or
`.env`, and never stores a key.

## Profiles: the renderer is global, the routes are not

`~/.hermes/desktop-plugins/` belongs to the **app** and is shared by every profile,
while `/api/plugins/baton/*` is served **per profile**. Installing into one profile
and switching the app to another gives you the sidebar entry and a page that
answers `404 {"detail":"Plugin not found"}`. To use it from several profiles, link
one checkout into each; the daemon listens on one port and the second profile
reuses the running process.

```bash
ln -sfn ~/.hermes/profiles/<profile>/plugins/baton ~/.hermes/plugins/baton
HERMES_HOME=~/.hermes hermes plugins enable baton
```

`dashboard/manifest.json`'s `name` is what the gateway mounts the router under;
keep it equal to `plugin.yaml`'s `name`. A rename that misses this file leaves every
`/api/plugins/<new-name>/*` call at 404 while the old prefix still answers, which
looks exactly like "the plugin is not installed".

## Repository rules

Three rules exist because each one was learned the hard way:

- **Generated products ship with their sources.** The runtime `.mjs` files and
  `desktop/plugin.js` are build output; run `node dev/build.mjs` before committing
  or CI fails the dirty-tree check.
- **The guides never interpolate the daemon token.** `hermes plugins install`
  scans the repository, and a `curl` line that expands a credential variable raises
  a HIGH `exfiltration` finding, which turns the verdict into CAUTION and blocks
  installation for everyone who does not pass `--force`. Use `scripts/api-call.py`,
  which loads the token itself.
- **ASCII outside the i18n payload.** Every user-facing string lives in
  `src/desktop/i18n/` (`types.ts` is the contract; `zh.ts` and `en.ts` must keep the
  same key shape). `scripts/cjk-scan.py` enforces it and allows exactly `zh.ts`.

## CI

CI runs on every push to `main`, and on a pull request only after the owner adds
the `run-ci` label. The gate and the two mechanisms behind it are described in
[`CONTRIBUTING.md`](../CONTRIBUTING.md); the job itself is typecheck, build, the
dirty-tree check, the five suites, `node --check` on the shipped products and the
ASCII gate, all hardware-free on an ubuntu runner.
