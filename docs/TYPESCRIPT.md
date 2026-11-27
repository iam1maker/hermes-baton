# TypeScript source and build

The plugin ships **artifacts Hermes can load directly** (`sidecar/**/*.mjs`,
`desktop/plugin.js`, `scripts/*.mjs`, `tests/*.mjs`). All of them are now
compiled from TypeScript under `src/`. The artifacts stay in the repository
because the Hermes installer only copies files; it never runs a build.

```text
src/
+-- sidecar/
|   +-- server.mts                  daemon (HTTP API + bridge + transcription scheduling) -> sidecar/server.mjs
|   +-- stt/sensevoice.mts          SenseVoice recogniser          -> sidecar/stt/sensevoice.mjs
|   +-- devices/index.mts           model registry                 -> sidecar/devices/index.mjs
|   +-- vendor/                     ATVV/audio/bridge wrappers derived from the DSH bundle (.ts -> .js)
+-- desktop/plugin.tsx              renderer (React + JSX)         -> desktop/plugin.js (single-file bundle)
+-- scripts/fetch-models.mts        model download                 -> scripts/fetch-models.mjs
+-- tests/*.mts                     five test suites               -> tests/*.mjs
dev/                                build and typecheck toolchain (not installed with the plugin)
types/hermes-plugin-sdk.d.ts        minimal local mirror of the SDK types
tsconfig.json                       strict + NodeNext + jsx: react-jsx
```

## Why the extension is `.mts`, and why vendor is `.ts`

Output filenames must match the runtime. A `.mjs` path such as
`sidecar/server.mjs` cannot become `.js`: `runtime.py` spawns it by name, and
the user-facing docs refer to it by name. Under `NodeNext`, TypeScript resolves
`import './x.mjs'` to the `x.mts` source, so:

- a source that must ship as `.mjs` is written as `.mts` (esbuild outputs `.mts`
  as `.mjs` when told to);
- the vendored ATVV/audio modules have always shipped as `.js`
  (`import './vendor/ble/sidecar.js'`), so their sources are `.ts` and their
  products are `.js`; no specifier had to change;
- the renderer is a bundle, so its extension does not matter; `.tsx` is what
  allows JSX.

What this rule buys: **not one runtime filename changed**. Paths in
`install.sh`, `runtime.py`, the user docs and the test scripts all stayed as
they were.

## Build and check

```bash
cd dev && npm install --no-audit --no-fund   # first time: typescript + esbuild + @types
node dev/typecheck.mjs                       # whole-project typecheck (equivalent to tsc --noEmit)
node dev/typecheck.mjs --files src/sidecar/server.mts   # one file only
node dev/build.mjs                           # regenerate every artifact
bash tests/run.sh                            # build, then run all five suites
```

Mapping in `dev/build.mjs`:

| Source | Product | Method |
|---|---|---|
| `src/sidecar/**` | `sidecar/**` | file-by-file compile, ESM, no bundling (vendored modules stay separate) |
| `src/scripts/**` | `scripts/**` | same |
| `src/tests/**` | `tests/**` | same |
| `src/desktop/plugin.tsx` | `desktop/plugin.js` | esbuild single-file bundle; `react`, `react/jsx-runtime` and `@hermes/plugin-sdk` stay external |

Hard constraints on the renderer (`apps/desktop/src/contrib/runtime-loader.ts`):
the entry must be `<id>/plugin.js`, a single file, at most 512 KiB, and may
import only those three packages. `dev/build.mjs` fails when the bundle exceeds
512 KiB and prints the sha256 prefix so it can be compared with the installed
copy.

## Four pitfalls (all of them hit in practice)

1. **No `package.json` at the repository root.** The installer reads it as a
   declaration of Node dependencies and prompts for `npm ci`. The toolchain's
   dependencies therefore live in `dev/` (`dev/package.json` +
   `dev/node_modules`), and `install.sh`'s allow-list never included `dev/`.
2. **`tsc` cannot run inside the gateway.** The gateway's lifetime guard
   refuses to scan a global `tsc` script (>1 MiB), so `dev/typecheck.mjs` uses
   the TypeScript compiler API in its own process: `createRequire` loads
   `dev/node_modules/typescript`, and diagnostics are formatted like `tsc`'s.
3. **esbuild does not output `.mts` as `.mjs` by default.** Without
   `outExtension`, `a.mts` becomes `a.js`, while every specifier says `.mjs`, so
   resolution silently lands on the pre-migration old file -- all tests green,
   but they test the old module (observed in practice). `dev/build.mjs`
   therefore builds twice: `.mts` with `outExtension: { '.js': '.mjs' }`, and
   vendor `.ts` left as `.js` (the imports literally say
   `./vendor/.../session.js`). It also removes stale same-named `.js` files and
   prints `removed stale ...`.
4. **`install.sh`'s `rm -rf` deletes the source.** When developing inside a
   profile, the source directory *is* the install directory
   (`~/.hermes/profiles/<p>/plugins/baton`), and the script would empty it
   before copying back. The script now compares `pwd -P` and skips the copy in
   that case; `--desktop-only` refreshes just the renderer.

## Changing code

1. edit `src/**` (never the artifacts);
2. `node dev/typecheck.mjs`;
3. `node dev/build.mjs` -- the `// GENERATED -- edit src/ ...` banner at the top
   of each product says it must not be hand-edited;
4. `bash tests/run.sh`;
5. for the desktop half, reinstall with
   `bash scripts/install.sh <profile> --with-desktop` (the script appends a
   `[local copy]` banner so Hermes treats it as a user-installed plugin rather
   than the "unified package desktop half").
