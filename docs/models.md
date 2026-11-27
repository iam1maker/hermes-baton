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
node scripts/fetch-models.mjs            # int8 + tokens + VAD into <state>/models
node scripts/fetch-models.mjs --fp32     # add the 894 MiB weight
node scripts/fetch-models.mjs --dir /path/to/models
node scripts/fetch-models.mjs --from ~/.dsh/speech-to-text/sensevoice/models/sensevoice-onnx
node scripts/fetch-models.mjs --url model.int8.onnx=https://mirror.example/model.int8.onnx
```

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
