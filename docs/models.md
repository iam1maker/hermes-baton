# Models

Baton transcribes locally with **SenseVoice** (via `sherpa-onnx-node`) and cuts
utterances with **Silero VAD**. Neither is in this repository: they are ~230 MB
of weights, downloaded once and then loaded by the daemon on first use.

## What is needed

| File | Bytes | Size | sha256 |
|---|---:|---|---|
| `sensevoice-onnx/model.int8.onnx` | 239 233 841 | 228 MiB | `c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51` |
| `sensevoice-onnx/tokens.txt` | 315 894 | 308 KiB | `f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc` |
| `silero-vad/silero_vad.onnx` | 643 854 | 629 KiB | `9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6` |
| `sensevoice-onnx/model.onnx` *(optional, fp32)* | 937 617 178 | 894 MiB | printed by `fetch-models --fp32`, not pinned |

The sha256 values are of the exact bytes this plugin was tested with. VAD builds
in the wild differ (an older 1.7 MiB `silero_vad.onnx` also loads and produces
the same text), which is why `--from` copies whatever you already have.

## Fetch

```bash
# run from the checkout: install.sh copies the plugin, not scripts/
node scripts/fetch-models.mjs                 # int8 + tokens + VAD into <state>/models
node scripts/fetch-models.mjs --fp32          # add the 894 MiB weight
node scripts/fetch-models.mjs --with-sherpa   # models plus the native engine
node scripts/fetch-models.mjs --sherpa-only   # native engine only
node scripts/fetch-models.mjs --dir /path/to/models
node scripts/fetch-models.mjs --from ~/.dsh/speech-to-text/sensevoice/models/sensevoice-onnx
node scripts/fetch-models.mjs --url model.int8.onnx=https://mirror.example/model.int8.onnx
```

Lines from the model phase are prefixed `[models]` and lines from the engine
phase `[sherpa]`, so a wrapper can tell a download percentage from an install
step.

`<state>` is `~/.hermes/baton` (`BATON_STATE_DIR` overrides). The
script:

- resumes an interrupted download from `<file>.part` with a `Range` request and
  restarts cleanly if the server ignores the range;
- goes through `HTTPS_PROXY` / `https_proxy` with a `CONNECT` tunnel, honouring
  `NO_PROXY`;
- prints progress in 10% steps, then byte size and sha256;
- skips a file whose size and sha256 already match;
- fails loudly (exit 1) on a size or hash mismatch, with the `--force` escape
  hatch.

Upstream URLs, verified reachable on 2026-11-26 (`curl -I` → 200):

- `https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx`
- `https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt`
- `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx`

HuggingFace hands out short-lived signed CDN URLs, so a bare `curl` of the first
two redirects; the script follows up to 8 redirects per file. If an upstream
moves, `--url <name>=<url>` or `--from` keeps you working.

## Native engine (sherpa-onnx-node)

`sherpa-onnx-node` is the native binding that actually runs SenseVoice (it owns
the ONNX Runtime session and ships a prebuilt binary per OS/architecture). It is
**not vendored** here and is not a dependency of the plugin: `--with-sherpa`
installs the pinned version into the state directory, next to the models.

```bash
node scripts/fetch-models.mjs --with-sherpa            # models + engine
node scripts/fetch-models.mjs --sherpa-only            # engine only
node scripts/fetch-models.mjs --sherpa-only --force    # reinstall the pinned version
node scripts/fetch-models.mjs --sherpa-only --sherpa-dir /path/to/sherpa
```

The default install root is `<state>/sherpa` (`~/.hermes/baton/sherpa`;
`BATON_STATE_DIR` / `REMOTE_MIC_STATE_DIR` move it), and the packages land in
`<state>/sherpa/node_modules/sherpa-onnx-node` plus its platform sibling
`sherpa-onnx-<os>-<arch>` (on this machine `sherpa-onnx-darwin-arm64`).

The version is pinned in the script (`SHERPA_VERSION = '1.13.8'`) because the
addon is a native ABI: 1.13.8 is what was measured on macOS arm64, and a newer
release can change the addon ABI or the platform-package split without notice.
The script runs

```text
npm install --prefix <tmp> --no-save --no-audit --no-fund sherpa-onnx-node@1.13.8
```

copies `sherpa-onnx-node` and every `sherpa-onnx-*` platform directory out of the
temp prefix into the target `node_modules`, deletes the temp prefix, and then
loads the installed `sherpa-onnx.js` in a child `node -e` that exits non-zero
unless `OfflineRecognizer` is a function (the child's stderr is part of the error
if it fails). A matching version is skipped -- printing `already installed` --
only when that load succeeds; `--force` always reinstalls.

Disk cost: ~33 MiB total, of which 32.5 MiB is the platform binary
(`sherpa-onnx-darwin-arm64`) and under 1 MiB is the JS package.

Discovery order at runtime, first working hit wins (as `sidecar/stt/sensevoice.mts`
resolves it today):

1. `BATON_SHERPA` (legacy `REMOTE_MIC_SHERPA`) -- a directory holding
   `sherpa-onnx.js`, for an existing copy elsewhere;
2. the plugin-local `sidecar/node_modules/sherpa-onnx-node` (and one directory
   above it), for a bundled install;
3. `<state>/sherpa/node_modules/sherpa-onnx-node` -- where `--with-sherpa` puts it.

`/state.transcriber` reports which one was loaded.

Upgrades are deliberate. Edit `SHERPA_VERSION` in `src/scripts/fetch-models.mts`,
run `node dev/build.mjs` (the `.mjs` is generated; never hand-edit it), then
`node scripts/fetch-models.mjs --sherpa-only --force` and repeat the smoke test
(`node -e` require of the installed `sherpa-onnx.js`). Do not `npm i` into the
state directory by hand: an unpinned version is exactly what the pin prevents.

Nothing loads the engine when `sttBaseUrl` is set -- that path POSTs each
utterance to an OpenAI-compatible `/audio/transcriptions` endpoint -- so both the
models and the native engine may be absent.

## Point the daemon at them

The daemon's defaults are the DSH install
(`~/.dsh/speech-to-text/sensevoice/models/sensevoice-onnx` and
`…/models/silero/silero_vad.onnx`) so an existing setup keeps working. After
fetching into the state dir, set both paths once:

```bash
TOKEN=$(cat ~/.hermes/baton/token)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"patch":{"modelDir":"'"$HOME"'/.hermes/baton/models/sensevoice-onnx","vadModel":"'"$HOME"'/.hermes/baton/models/silero-vad/silero_vad.onnx"}}' \
  http://127.0.0.1:8791/config
```

Environment overrides (`REMOTE_MIC_MODEL_DIR`, `REMOTE_MIC_VAD_MODEL`,
`REMOTE_MIC_MODEL_FILE`, `REMOTE_MIC_SHERPA`) exist for non-default layouts.
`/state.transcriber` reports the resolved paths, the precision in use and any
fallback note.

## Measured cost (author's Mac, Apple Silicon)

Read these as "what this machine did", not as a benchmark:

| Metric | int8 | fp32 |
|---|---|---|
| model load (cold, includes VAD) | 346–463 ms | 656 ms |
| one 6.685 s sample (`sidecar/assets/sample-zh.wav`) | 0.112–0.116 s | 0.095–0.101 s |
| transcript | plain sentence, no punctuation | the same sentence, with punctuation |
| RSS after a clean start | ~937 MiB | ~1250 MiB |

Switching precision calls `dispose()` and rebuilds the session, but ONNX
Runtime's arena does not return memory at once; repeated switches push RSS past
2.4 GiB until the daemon restarts.

## If you would rather not run a model

Set `sttBaseUrl` to an OpenAI-compatible endpoint (it needs
`/audio/transcriptions`), plus `sttModel` and `sttApiKey`. The daemon then POSTs
each utterance's WAV there and never loads `sherpa-onnx-node`. This is the only
configuration in which audio leaves the machine.

## Licences

- **SenseVoice** weights: published as `license: other` (a custom model licence)
  on the upstream model card (`FunAudioLLM/SenseVoiceSmall`). Read it before
  redistributing the weights; this repo does not ship them.
- **Silero VAD**: MIT (`snakers4/silero-vad`).
- **sherpa-onnx / sherpa-onnx-node**: Apache-2.0 (`k2-fsa/sherpa-onnx`).
