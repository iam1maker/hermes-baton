# Baton (hermes-baton)

A Bluetooth voice remote as an **input and control surface** for
[Hermes Agent](https://hermes-agent.nousresearch.com): hold the voice key and
talk — the audio is transcribed on your Mac and the text lands in the current
composer; the other keys become submit / stop / new-session / canned phrases.

No audio is uploaded by default. No cloud account, no wake word, no system
microphone: the audio arrives as a BLE (ATVV) stream from the remote itself.

Plugin id `baton` · kind `standalone` · requires Hermes `>=0.22.5` · macOS only

> The plugin is named **baton** (Chinese surfaces: **指挥**). The agent tool is `baton`,
> state lives in `~/.hermes/baton/`, the loopback daemon listens on `127.0.0.1:8791`,
> and the desktop page sits in the sidebar as 「指挥」.

## Surfaces

| Surface | What it does |
|---|---|
| Desktop page (sidebar 「语音遥控」, palette `baton.open`) | link status and battery, remote picker, key map, canned phrases, audio parameters (gap / max / trim / cutoff / language), precision (int8 / fp32), history, daemon log |
| Status-bar chip 🎙 | link state + battery at a glance |
| Agent tool `baton` | `status · history · consume · start · stop · restart · selftest · config · key` |
| Loopback HTTP API `127.0.0.1:8791` | `/state` `/events` `/devices` `/capture` `/selftest` `/config` `/history` `/logs` — Bearer token in `~/.hermes/baton/token` |
| Device registry `sidecar/devices/*.json` | one JSON per remote model; add a file to support a new remote — see [`docs/ADD-A-DEVICE.md`](docs/ADD-A-DEVICE.md) |

## Install

```bash
# from a checkout — copies the plugin (+ sidecar, prebuilt bridge, docs) into a profile
bash scripts/install.sh forge                  # or: bash scripts/install.sh default
bash scripts/install.sh forge --with-desktop   # also copy the renderer to ~/.hermes/desktop-plugins/baton
                                               # (only if the checkout ships desktop/plugin.js)

HERMES_HOME=~/.hermes/profiles/forge hermes plugins enable baton
hermes gateway restart                          # routes mount only when the gateway starts
```

Then get the speech models (below), and enable the desktop half once under
**Settings → Capabilities → Plugins** — the renderer runs with the app's
authority, so Hermes asks explicitly. The renderer is one plain `plugin.js` at
`~/.hermes/desktop-plugins/<id>/plugin.js`; there is no build step.

`scripts/` is a developer convenience: `install.sh` copies the runtime half
(`__init__.py`, `runtime.py`, `plugin.yaml`, `dashboard/`, `sidecar/`, `docs/`,
`README.md`, `LICENSE`) and not `scripts/`, so run `scripts/fetch-models.mjs`
**from the checkout**, or point the page at a model directory you already have.
The daemon never calls into `scripts/`.

## Dependencies

Nothing here is vendored. All four items come from the machine.

| Dependency | Why | How |
|---|---|---|
| **macOS 13+** | the BLE bridge is a Swift binary (`-target …-apple-macosx13.0`, universal `arm64` + `x86_64`) | prebuilt at `sidecar/bin/atvv-link`; rebuild with `bash sidecar/native/build.sh` (Xcode CLT only) |
| **Node 22** | the sidecar daemon and the tests; not bundled, the host's `node` is used | resolution: `REMOTE_MIC_NODE` → `node` on `PATH` → `~/.local/bin` → `/opt/homebrew/bin` → `/usr/local/bin` → `/usr/bin` |
| **`sherpa-onnx-node`** | ONNX runtime + SenseVoice/VAD bindings (native `.node`, darwin arm64/x64) | `npm i sherpa-onnx-node` in `sidecar/`, or point `REMOTE_MIC_SHERPA` at an existing install; resolution: `REMOTE_MIC_SHERPA` → `sidecar/node_modules` → common DSH bundle paths |
| **Speech models** | SenseVoice ASR + Silero VAD; **not in this repo** | `node scripts/fetch-models.mjs` (download + verify), `--from <dir>` (import a local copy), `POST /config` with `modelDir`/`vadModel`, or an external OpenAI-compatible STT service |

Out of the box: **Xiaomi Bluetooth Voice Remote 2 / 2 Pro** (`0x2717:0x32b8`)
and **Chromecast with Google TV Remote** (`0x18d1:0x9450`).

### Models

| File | Size | Notes |
|---|---|---|
| `sensevoice-onnx/model.int8.onnx` | 228 MiB | default weight |
| `sensevoice-onnx/model.onnx` | 894 MiB | fp32; adds punctuation |
| `sensevoice-onnx/tokens.txt` | 308 KiB | required with either weight |
| `silero-vad/silero_vad.onnx` | 629 KiB | what `fetch-models` downloads; an existing 1.7 MiB build also loads |

```bash
node scripts/fetch-models.mjs                       # → <state>/models/, resumable, sha256-checked
node scripts/fetch-models.mjs --from ~/.dsh/speech-to-text/sensevoice/models/sensevoice-onnx
node scripts/fetch-models.mjs --fp32                # also the 894 MiB model
node scripts/fetch-models.mjs --help
```

The daemon's built-in default still points at the DSH install
(`~/.dsh/speech-to-text/sensevoice/models/…`), because that is where most
existing setups keep it. After fetching elsewhere, set the paths once through
`POST /config` — this build has no model-path field on the page:

```bash
TOKEN=$(cat ~/.hermes/baton/token)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"patch":{"modelDir":"'"$HOME"'/.hermes/baton/models/sensevoice-onnx","vadModel":"'"$HOME"'/.hermes/baton/models/silero-vad/silero_vad.onnx"}}' \
  http://127.0.0.1:8791/config
```

Measured on the author's Mac (Apple Silicon, `sherpa-onnx-node` 1.13.8): model
load **346–463 ms** for int8 (656 ms for the 894 MiB fp32), one 6.685 s
utterance **0.11–0.16 s**. Local numbers, not a benchmark of your machine — see
[`docs/models.md`](docs/models.md).

Prefer no local model? Set `sttBaseUrl` (plus `sttModel`, `sttApiKey`) to any
OpenAI-compatible `/audio/transcriptions` endpoint. There is no UI field for it
in this build — `POST /config` or `settings.json` only.

## Behaviour

**Voice.** Hold the remote's voice key, speak, release. The bridge streams ADPCM
over ATVV; the daemon decodes, segments on a 350 ms gap (VAD-assisted, with
onset padding so the first syllable survives), transcribes at 16 kHz and inserts
the text into the composer — or sends it when the draft is empty and auto-send
is on. The remote streams only while its own key is held; nothing starts it
remotely.

**Keys.** Every binding is one of `submit`, `stop`, `new-session`, `phrase`
(named canned text), `swallow`, `ignore`, `native`, and each key can bind
single / double / long press. Defaults are per model — Xiaomi has `Back` (stop)
and volume; Chromecast adds `Enter`, arrows, `Home`, `InputSource` (new session)
and the media keys. The page renders only the keys the current model can
produce.

**One link, several remotes.** One bridge holds one remote at a time. Switching
is hot: the bridge child restarts, the daemon and Hermes do not (measured
0.45–0.77 s). Both remotes are usually connected at the HID level, so
`keyFilter` decides whose keys act — `active` (default: current remote only) or
`any`.

**Precision.** `precision: int8 | fp32` swaps the weight file and reloads the
model (`dispose()` first — ONNX Runtime's arena does not shrink immediately, so
many switches raise RSS until the daemon restarts).

## Permissions

| Permission | Needed for | Not needed |
|---|---|---|
| **Bluetooth** (TCC) | connecting the remote and receiving its ATVV stream | — |
| **Input Monitoring** (`IOHIDManager`) | reading the remote's key reports; without it the bridge logs `HID key reader needs Input Monitoring` and keys die while voice still works | Accessibility, Screen Recording, Full Disk Access |
| ~~Microphone~~ | — | the system microphone is never opened: audio comes from the BLE stream |

The daemon listens on `127.0.0.1` only and requires the Bearer token for every
route except `/health`.

## Known limitations

- **Volume ± / mute are not ours.** macOS consumes them in
  `AppleUserHIDEventService`; the plugin can only observe. `Power`, `Netflix`,
  `YouTube` are recognised (they show up in `/events`) but bound to no action —
  the OS acts first (lock screen, media player).
- **One bridge at a time.** A second ATVV client (another voice-remote app)
  steals the link; `/state.competitors` lists the processes it can see.
- **Per-model key maps, one global action map.** The model decides which keys
  exist; one `keyMap` decides what an action means.
- **A new gateway route needs one restart.** Routes mounted after the gateway
  started stay 404 until `hermes gateway restart`; the page falls back to cached
  `/state` fields meanwhile.
- **Bridge HID page allow-list.** Pages `0x07`, `0x0C`, `0xFF00` by default; a
  model that reports elsewhere needs its page listed in the profile's `pages`
  (they are passed to the bridge as `--hid-pages`).

## Disclosure

- **Audio.** By default no audio leaves the machine: the WAV is transcribed
  in-process by `sherpa-onnx-node` on the CPU. If you set `sttBaseUrl`, each
  utterance's WAV **is** POSTed to that endpoint (with `sttApiKey` as a Bearer
  header) — that is what the option is for, and it is off by default.
- **Local files.** `~/.hermes/baton/` holds `token`, `settings.json`,
  `device.json` (CoreBluetooth UUID + name of the last remote), `last.wav` (most
  recent utterance, for `/audio/last`), `history.jsonl` only when history is
  enabled (default **off**), and `daemon.out`.
- **The daemon log is not content-free.** `daemon.out` keeps the first 120
  characters of each transcript plus state / battery lines — locally, for
  debugging. It holds no audio, no MAC address and no key material.
- **No telemetry, no updater, no other outbound calls.** Apart from an
  explicitly configured `sttBaseUrl`, the process talks to nothing but the local
  bridge over stdio and `127.0.0.1`.
- **Provenance.** The ATVV protocol implementation was written for this project
  after studying **HD838A/remote-mic-app** (GPL-3.0) and
  **nijez/open-voice-bridge**; it is an independent implementation, not a copy,
  and this repository is MIT throughout. The pure-ESM modules under
  `sidecar/vendor/` (ATVV framing, ADPCM, WAV, filter, service/transport) are
  carried over from the author's MIT-licensed `dsh-remote-mic` build. SenseVoice
  and Silero weights are downloaded separately under their own licences and are
  not distributed here.

## Development

```bash
bash tests/run.sh                 # 49 assertions, no Electron / gateway / hardware
                                  #   harness.mjs           13  renderer: event stream, key engine, composer
                                  #   model-precision.mjs    5  int8/fp32 selection and fallbacks
                                  #   hid-filter.mjs        12  key ownership: active vs any
                                  #   devices-registry.mjs  19  JSON profiles → key table, bridge args
node --check sidecar/server.mjs
node -e "import('./sidecar/devices/index.mjs').then(m=>console.log(m.loadDeviceProfiles().profiles.map(p=>p.id)))"
node scripts/fetch-models.mjs --help
python3 scripts/probe-routes.py   # which routes the running gateway actually has
python3 scripts/switch-device.py  # hot-switch the two remotes and time it
python3 scripts/verify-gateway.py # end-to-end check against the gateway
python3 scripts/watch-keys.py     # tail key events out of the daemon
bash sidecar/native/build.sh      # rebuild the universal bridge
```

`tests/` needs nothing but `node`; it stubs the SDK, React and the transport.
`probe-routes.py` and `verify-gateway.py` attach to the running gateway and need
the Hermes venv Python (the system 3.9 has no `hermes` package);
`switch-device.py` and `watch-keys.py` talk to `127.0.0.1:8791` directly and are
plain stdlib.

## 中文说明（简）

Baton（原名 baton）把蓝牙语音遥控器变成 Hermes 的输入/控制面：按住语音键说话，
音频经 BLE（ATVV）进入本机，SenseVoice 在本地识别，文字落进当前输入框；其余按键可映射为
提交 / 停止 / 新建会话 / 常用语。默认不上传任何音频，也不打开系统麦克风。

- 机型数据驱动：`sidecar/devices/*.json`，接新遥控器不改代码，步骤见 `docs/ADD-A-DEVICE.md`。
- 模型不在仓库里：`node scripts/fetch-models.mjs` 下载（断点续传 + sha256 校验），
  或 `--from` 导入已有目录，或在页面里填外部 OpenAI 兼容 STT。
- 权限只要两项：蓝牙、输入监控（读遥控器按键）。音量键与 Power/Netflix/YouTube 由 macOS
  先消费，插件只识别不拦截。
- 已知取舍：一条桥同时只连一台遥控器（切换是热的，0.45–0.77 秒）；网关新增路由需重启一次。
- 协议实现参考 HD838A/remote-mic-app（GPL-3.0）与 nijez/open-voice-bridge 后独立编写，
  本仓库为 MIT。

## License

MIT — see [`LICENSE`](LICENSE). Model weights are separate works under their own
licences; see [`docs/models.md`](docs/models.md).
