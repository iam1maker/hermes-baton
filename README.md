# Baton

Baton turns a Bluetooth voice remote into a first-class input and control
surface for [Hermes Agent](https://hermes-agent.nousresearch.com). Hold the
remote's voice key, speak, release: the audio arrives over BLE as an ATVV
stream, is decoded and segmented on your Mac, transcribed locally by
SenseVoice, and the text lands in the composer you are already typing into. The
ordinary keys become gestures -- submit, stop generation, start a new session,
insert a canned phrase. There is no cloud account, no wake word, and no system
microphone: the plugin opens exactly two macOS permissions (Bluetooth and Input
Monitoring) and uploads nothing by default. Remotes are described by JSON
profiles, so supporting a new model is a data change, not a code change.

Plugin id `baton` · kind `standalone` · requires Hermes `>=0.22.5` · macOS only

> The display name is **Baton** in every language: the sidebar entry, the page
> title and the palette command all read `Baton`, so there is no zh/en pair to
> keep in sync. It is also the agent tool name, the state directory
> `~/.hermes/baton/`, the palette id `baton.open` and the loopback port
> `127.0.0.1:8791`'s service.

## Features

- **Hold-to-talk dictation, fully local.** The remote streams only while its own
  voice key is held; nothing can start it remotely. Audio is transcribed on the
  CPU by `sherpa-onnx-node`; the WAV never leaves the machine unless you
  explicitly configure an external STT endpoint.
- **Keys become gestures.** Every binding is one of `submit`, `stop`,
  `new-session`, `phrase`, `swallow`, `ignore`, `native`, and each key can carry
  single, double and long press actions.
- **Two remotes, hot-switchable.** One bridge holds one remote at a time;
  switching restarts only the bridge child process (measured 0.45-0.77 s), not
  the daemon, not Hermes.
- **Models are data.** `sidecar/devices/*.json` describes the VID/PID match,
  HID usage pages, key names and default actions. A new remote needs no Swift
  rebuild and no daemon restart.
- **Precision is a setting.** `int8` (default) or `fp32` weights, switchable at
  runtime; fp32 costs load time and RAM but adds punctuation on the bundled
  sample.
- **Three surfaces, one daemon.** A desktop page (link state, battery, remote
  picker, key map, phrases, audio parameters, history, log), a status-bar chip,
  and an agent tool `baton` (`status`, `history`, `consume`, `start`, `stop`,
  `restart`, `selftest`, `config`, `key`).
- **Diagnostics that tell the truth.** `POST /selftest` transcribes a bundled
  sample, so the model, the decoder and the event stream can be checked without
  touching the remote; `/state` reports the resolved model paths and any
  fallback.

## Supported remotes

| Model | VID:PID | HID usage pages | Keys the profile adds | Status |
|---|---|---|---|---|
| Xiaomi BT Remote 2 / 2 Pro | `0x2717:0x32b8` | `0x07` (keyboard), `0xFF00` (vendor, filtered) | `Back`, volume up/down | verified on hardware |
| Chromecast with Google TV Remote | `0x18d1:0x9450` | `0x0C` (Consumer Control) | `Enter`, arrows, `Home`, `InputSource`, `Power`, `Netflix`, `YouTube` | verified on hardware |

Notes from the two shipped profiles:

- The Xiaomi's centre key **is** the voice key. It produces no HID code of its
  own (the firmware reports it on a pseudo usage that the bridge drops), so
  there is no independent `Enter` to bind; `Enter` stays available to a physical
  keyboard through key capture.
- The Chromecast reports its main collection on the Consumer page, and its
  volume keys are also consumed by macOS before any app sees them.
- Both remotes are usually connected at the HID level at the same time. The
  `keyFilter` setting decides whose keys act: `active` (default, current remote
  only) or `any`.

## Quick start

Prerequisites: macOS 13 or newer, Node.js 22 or newer on `PATH`, and Hermes with
**Bluetooth** plus, for keys, **Input Monitoring** granted (see
[Permissions](#permissions)).

```bash
# 1. install the plugin half into the active profile
hermes plugins install iam1maker/hermes-baton
hermes plugins enable baton
```

```bash
# 2a. local speech models + the native engine (int8 + tokens + Silero VAD, ~229 MiB;
#     sherpa-onnx-node 1.13.8 + its platform binary, ~33 MiB)
node ~/.hermes/plugins/baton/scripts/fetch-models.mjs --with-sherpa
# named profile: node ~/.hermes/profiles/<profile>/plugins/baton/scripts/fetch-models.mjs --with-sherpa
```

`--with-sherpa` installs the pinned `sherpa-onnx-node` into
`~/.hermes/baton/sherpa/node_modules` and prints a one-line `node -e` check that
the addon loads. If you already have the models, `--sherpa-only` does just the
engine; `--force` reinstalls it.

Or skip local models and point the daemon at any OpenAI-compatible
`/audio/transcriptions` service (this is the only mode in which audio leaves the
machine, and it needs **no** native engine -- nothing loads
`sherpa-onnx-node`):

```bash
# from the plugin directory; scripts/api-call.py reads the daemon token itself
python3 scripts/api-call.py POST /config \
  '{"patch":{"sttBaseUrl":"https://api.openai.com/v1","sttModel":"whisper-1","sttApiKey":"..."}}'
```

```bash
# 3. routes mount when the gateway starts -- an app restart is not a gateway restart
hermes gateway restart
```

Then open **Settings -> Capabilities -> Plugins** and enable the desktop half
once. The renderer runs with the app's authority, so Hermes asks explicitly;
the packaged renderer is one plain `plugin.js`, with no build step at install
time.

If the models were fetched somewhere other than the daemon's default (the
legacy DSH path), set the two paths through `POST /config` as well:

```bash
python3 scripts/api-call.py POST /config \
  '{"patch":{"modelDir":"/Users/you/.hermes/baton/models/sensevoice-onnx","vadModel":"/Users/you/.hermes/baton/models/silero-vad/silero_vad.onnx"}}'
```

This build has no model-path fields on the page; `POST /config` and
`~/.hermes/baton/settings.json` are the two ways in.

### From a checkout

```bash
bash scripts/install.sh forge                  # copy the plugin into a profile
bash scripts/install.sh forge --with-desktop   # also copy the renderer to ~/.hermes/desktop-plugins/baton
HERMES_HOME=~/.hermes/profiles/forge hermes plugins enable baton
```

`install.sh` copies `__init__.py`, `runtime.py`, `plugin.yaml`, `dashboard/`,
`sidecar/` (bridge, assets, device profiles), `scripts/`, `docs/`, `README.md`,
`LICENSE`, and `desktop/plugin.js` when present. It never writes `config.yaml`
or `.env`, and never stores a key.

### Profiles: the renderer is global, the routes are not

`~/.hermes/desktop-plugins/` belongs to the **app** and is shared by every
profile, while `/api/plugins/baton/*` is served **per profile**. Installing the
plugin in one profile and switching the app to another gives you the sidebar
entry and a page that answers `404 {"detail":"Plugin not found"}`. To use it
from several profiles, link one checkout into each; the daemon listens on one
port and the second profile reuses the running process:

```bash
ln -sfn ~/.hermes/profiles/forge/plugins/baton ~/.hermes/plugins/baton
HERMES_HOME=~/.hermes hermes plugins enable baton
```

`dashboard/manifest.json`'s `name` is what the gateway mounts the router under;
keep it equal to `plugin.yaml`'s `name`. A rename that misses this file leaves
every `/api/plugins/<new-name>/*` call at 404 while the old prefix still
answers, which looks exactly like "the plugin is not installed".

## Architecture

Three runtime layers, each with one job. Changes land in the outermost layer
that owns the behaviour.

```text
renderer      desktop/plugin.js           page, key engine, composer insertion
   |          (built from src/desktop/plugin.tsx)
   v  HTTP, /api/plugins/baton/*
gateway       dashboard/plugin_api.py     routes, request validation
              runtime.py + __init__.py    supervision, agent tool
   |          loopback HTTP 127.0.0.1:8791, bearer token
   v
daemon        sidecar/server.mjs          event stream, key engine, STT, config
   |          (built from src/sidecar/)
   v  stdio JSON
bridge        sidecar/bin/atvv-link       CoreBluetooth ATVV + IOHIDManager
              (built from sidecar/native/main.swift by build.sh)
```

| Layer | Files | Owns | Does not own |
|---|---|---|---|
| Renderer (Electron) | `desktop/plugin.js`, source `src/desktop/plugin.tsx` | the page, the key engine, gesture timing, `host.composer.insertText`, the status-bar chip, the `baton.open` palette command | Bluetooth, audio, models |
| Gateway (Python) | `__init__.py`, `runtime.py`, `dashboard/plugin_api.py` | the agent tool, lazy daemon start, self-healing a stale token, `/api/plugins/baton/*` routes | audio, BLE, model loading |
| Daemon (Node) | `sidecar/server.mjs`, source `src/sidecar/` | HTTP API on `127.0.0.1:8791`, event ring, key actions, utterance segmentation, transcription, settings | UI, composer |
| Bridge (Swift) | `sidecar/bin/atvv-link`, source `sidecar/native/main.swift` | CoreBluetooth ATVV session, ADPCM frames, `IOHIDManager` key reports | policy, key names |

Why the split:

- **Actions run in the renderer** because they must hit the focused composer
  in-process (`host.composer.insertText`). A remote action is a UI event, not a
  tool call.
- **The daemon owns Bluetooth and ASR** because both are long-lived and
  stateful: one BLE link, one ONNX session, one event ring.
- **Python is only supervision and transport.** `runtime.py` starts the daemon
  on demand rather than at import time -- the gateway imports every enabled
  plugin on every launch, and spawning a BLE scanner for a user who never
  touches the remote would be worse than paying roughly 120 ms on the first
  request.

The API is loopback-only and token-protected. `GET /health` is the single
unauthenticated route (it returns `ok`, pid, uptime and `auth: "required"` so a
supervisor can detect a live daemon before dialing with the token). Everything
else needs `Authorization: Bearer <token>` from `~/.hermes/baton/token`.

Routes exposed by the daemon: `/state`, `/events`, `/devices`,
`/devices/reload`, `/capture`, `/selftest`, `/config`, `/history`, `/logs`,
`/key`, `/start`, `/stop`, `/restart`, `/consume`, `/mock/transcript`,
`/open/settings`, `/audio/last`. The gateway mirrors the subset the page and the
agent tool need under `/api/plugins/baton/*`.

## Key mapping and gestures

Gesture windows are 300 ms for a double press and 550 ms for a long press
(reported through `/state.keys`; fixed constants in this build).

Action vocabulary:

| Action | What it does |
|---|---|
| `submit` | send the current draft |
| `stop` | stop the running generation |
| `new-session` | start a fresh session |
| `phrase` | insert a named canned phrase from the page's phrase list |
| `swallow` | consume the key and do nothing (a guard against accidental sends) |
| `ignore` | let the event pass without acting |
| `native` | leave the key to macOS |

### Xiaomi BT Remote 2 / 2 Pro

| Code | HID pair | Single | Double | Long |
|---|---|---|---|---|
| `Back` | `0x07/0xf1` | `stop` | `phrase` (profile default) | -- |
| `AudioVolumeUp` | `0x07/0x80` | `native` (macOS) | `native` | `native` |
| `AudioVolumeDown` | `0x07/0x81` | `native` (macOS) | `native` | `native` |
| voice key | ATVV, no HID code | hold to talk | -- | -- |

### Chromecast with Google TV Remote

| Code | HID pair | Single | Double | Long |
|---|---|---|---|---|
| `Enter` | `0x0c/0x41` | `submit` | `new-session` | `swallow` |
| `Back` | `0x0c/0x224` (base table) | `stop` | `phrase` (profile default) | -- |
| `InputSource` | `0x0c/0x89` | `new-session` | -- | -- |
| `Home` | `0x0c/0x223` | -- | -- | -- |
| `ArrowUp` / `ArrowDown` / `ArrowLeft` / `ArrowRight` | `0x0c/0x42`-`0x45` | -- | -- | -- |
| `Power` | `0x0c/0x19e` | -- (macOS locks the screen first) | -- | -- |
| `Netflix` / `YouTube` | `0x0c/0x77` / `0x78` | -- (macOS opens the player first) | -- | -- |
| volume | `0x0c/0xe9`, `0x0c/0xea`, `0x0c/0xe2` (base table) | `native` (macOS) | `native` | `native` |

A `--` means the code is recognised and delivered to the page but bound to no
action. A phrase action names an entry in the page's phrase list; a binding that
names a phrase which does not exist is rejected when the patch is validated
rather than failing silently at press time.

The map is deliberately global rather than per-model: the model decides *which
keys exist*, one `keyMap` decides *what an action means*. Switching back to the
Xiaomi therefore does not require reconfiguring `Back`, and rebinding `Back`
means the same thing on both remotes.

## Device profiles as data

One remote model is one JSON file in `sidecar/devices/`. No code contains a
model check; the registry merges files and the daemon derives both the bridge
arguments and the page's key table from the result.

Merge order: `_base.json` (standard HID Usage Tables keys, shared) -> built-in
profiles -> user profiles in `<state>/devices/*.json`, where a user file with
the same `id` replaces the built-in one.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | stable identifier used in `/state`, logs and settings; must be unique |
| `disabled` | boolean, optional | `true` skips the profile without deleting the file |
| `label`, `vendor` | string | shown in the remote picker |
| `match.vendorIds`, `match.productIds` | number[] | HID IDs in **decimal** |
| `match.nameHints` | string[] | substrings matched both ways against the name the bridge reports; profile order, first hit wins |
| `hidPairs` | string[] | `"0xVID:0xPID"`, passed verbatim to the bridge as `--hid-device`; a device not listed produces no key events |
| `pages` | number[] | usage pages this model reports, **decimal**; the union becomes `--hid-pages`, and a page not listed is dropped before the daemon sees it |
| `keys` | object | `"<page>/<usage>"` -> `KeyboardEvent.code`; only this model's specific keys |
| `hidKeys` | string[] | allow-list of codes permitted into `/events`; a missing code is dropped without a log line |
| `defaultKeyMap` | object | `single` / `double` / `long` -> action; a flat string means single press only |
| `voiceHint`, `notes` | string | page hint and footnotes |

Minimal profile:

```json
{
  "id": "my-remote",
  "label": "My Remote",
  "vendor": "Example",
  "match": { "vendorIds": [10007], "productIds": [12984], "nameHints": ["My Remote"] },
  "hidPairs": ["0x2717:0x32b8"],
  "pages": [7, 12, 65280],
  "keys": {},
  "hidKeys": ["Back", "Enter", "AudioVolumeUp", "AudioVolumeDown", "AudioVolumeMute"],
  "defaultKeyMap": { "Back": { "single": "stop" } },
  "voiceHint": "Hold the voice key and speak",
  "notes": ""
}
```

To add a remote:

1. `hidutil list` for VID/PID; `sidecar/bin/atvv-link --hid --list 4` to confirm
   the device exposes the ATVV service.
2. Copy `sidecar/devices/chromecast-google-tv.json` (the better template: ten
   keys, one page) and fill the fields.
3. `POST /devices/reload` -- the registry is re-read, bridge arguments are
   recomputed, and only the link restarts. No daemon restart, no Hermes restart,
   no Swift rebuild.

Unnamed keys are logged once each as
`[hid] unmapped page=0x7 usage=0x29 value=1 device=...`, which is how a new
profile gets its key names. Full walkthrough, number bases, and failure table:
[`docs/ADD-A-DEVICE.md`](docs/ADD-A-DEVICE.md).

## Voice pipeline and models

```text
remote holds key -> ATVV stream (codec 0x02 = 16 kHz ADPCM) -> bridge (Swift)
  -> daemon: ADPCM decode -> utterance buffer (350 ms silence gap, 30 s cap)
  -> trim 200 ms + 100 Hz high-pass -> 16 kHz mono WAV
  -> SenseVoice (sherpa-onnx, Silero VAD) -> text -> /events -> renderer
```

The utterance buffer closes on a 350 ms gap and is VAD-assisted: silence before
the first speech segment is trimmed, but the first syllable is padded so it
survives. `maxMs` caps one utterance at 30 s. Start trim adapts to length
(`min(trimMs, max(40, 12% of duration))`), and a 100 Hz high-pass removes the
DC/rumble that ADPCM leaves behind.

| Model file | Size | Notes |
|---|---|---|
| `sensevoice-onnx/model.int8.onnx` | 228 MiB (239,233,841 B) | default weight |
| `sensevoice-onnx/model.onnx` | 894 MiB (937,617,178 B) | fp32; adds punctuation |
| `sensevoice-onnx/tokens.txt` | 308 KiB (315,894 B) | required with either weight |
| `silero-vad/silero_vad.onnx` | 629 KiB (643,854 B) | what `fetch-models` downloads; an older 1.7 MiB build also loads |

Measured on the author's Mac (Apple Silicon, `sherpa-onnx-node` 1.13.8). These
are local observations, not a benchmark of your machine:

| Metric | int8 | fp32 |
|---|---|---|
| model load, cold, including VAD | 346-463 ms | 656 ms |
| one 6.685 s sample (`sidecar/assets/sample-zh.wav`) | 0.112-0.116 s | 0.095-0.101 s |
| transcript | plain sentence | same sentence, with punctuation |
| RSS after a clean start | ~937 MiB | ~1250 MiB |

Precision is switchable at runtime. Each switch calls `dispose()` and rebuilds
the session, but ONNX Runtime's arena does not return memory immediately;
repeated switches push RSS past 2.4 GiB until the daemon restarts.

```bash
node scripts/fetch-models.mjs                       # -> <state>/models/, resumable, sha256-checked
node scripts/fetch-models.mjs --from ~/.dsh/speech-to-text/sensevoice/models/sensevoice-onnx
node scripts/fetch-models.mjs --fp32                # also the 894 MiB weight
node scripts/fetch-models.mjs --help
```

The daemon's built-in defaults point at the legacy DSH install
(`~/.dsh/speech-to-text/sensevoice/models/...`) because that is where existing
setups keep the files. After fetching elsewhere, set `modelDir` and `vadModel`
once through `POST /config` (see Quick start).

Environment overrides exist for non-default layouts: `BATON_MODEL_DIR`,
`BATON_VAD_MODEL`, `BATON_MODEL_FILE`, `BATON_SHERPA` (legacy `REMOTE_MIC_*`
names still work). `/state.transcriber` reports the resolved paths, the
precision in use, and any fallback note.

**External STT.** Set `sttBaseUrl` (plus `sttModel`, `sttApiKey`) to any endpoint
that speaks OpenAI's `/audio/transcriptions`; the daemon then POSTs each
utterance's WAV there and never loads `sherpa-onnx-node`. Details, hashes and
licences: [`docs/models.md`](docs/models.md).

## Permissions

| Permission | Needed for | Not needed |
|---|---|---|
| **Bluetooth** (TCC) | connecting the remote and receiving its ATVV stream | -- |
| **Input Monitoring** (`IOHIDManager`) | reading the remote's key reports; without it the bridge logs `HID key reader needs Input Monitoring` and keys die while voice still works | Accessibility, Screen Recording, Full Disk Access |
| microphone | -- | never opened: audio comes from the BLE stream |

Volume up/down/mute are consumed by macOS in `AppleUserHIDEventService` before
the plugin sees them; the plugin can only observe. `Power`, `Netflix` and
`YouTube` are recognised and delivered (`/events`) but bound to no action by
default, because the OS acts first (lock screen, media player).

## Privacy and what is stored

- **Audio never leaves the machine by default.** The WAV is transcribed
  in-process on the CPU. If you set `sttBaseUrl`, each utterance's WAV **is**
  POSTed to that endpoint with `sttApiKey` as a Bearer header -- that is what
  the option is for, and it is off by default.
- **Nothing else is uploaded.** No telemetry, no updater, no other outbound
  calls. Apart from an explicitly configured STT endpoint, the process talks to
  nothing but the local bridge over stdio and `127.0.0.1`.
- **What lives in `~/.hermes/baton/`:**

| File | Contents |
|---|---|
| `token` | bearer token for the loopback API; generated as 48 hex chars (24 random bytes), an existing 32+ hex token is reused, file mode 0600 |
| `settings.json` | your overrides only; values equal to defaults are omitted. With external STT it also holds `sttApiKey` in clear text (the API returns it masked) |
| `device.json` | CoreBluetooth UUID and name of the last remote |
| `last.wav` | the most recent utterance, served by `/audio/last` |
| `history.jsonl` | voice-input history, only when history is enabled (default **off**) |
| `daemon.log` | the daemon log |

- **The daemon log is not content-free.** `daemon.log` keeps the first 120
  characters of each transcript plus state and battery lines -- locally, for
  debugging. It holds no audio, no MAC address and no key material.
- **The system microphone is never opened.** Audio arrives as a BLE stream from
  the remote; the bridge only listens to HID key reports in addition.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Page answers `404 {"detail":"Plugin not found"}` | app is on a profile where the plugin is not installed | install or link it into that profile; check `dashboard/manifest.json`'s `name` equals `plugin.yaml`'s |
| `/api/plugins/baton/devices` 404s while `127.0.0.1:8791/devices` works | mounted routers do not rescan | `hermes gateway restart` once |
| Keys do nothing, voice still works | Input Monitoring not granted | System Settings -> Privacy & Security -> Input Monitoring; the bridge logs `HID key reader needs Input Monitoring` |
| Voice key does nothing at all | another ATVV client holds the link | quit other voice-remote apps; check `/state.competitors` |
| `[hid] unmapped page=... usage=...` | key not named in the profile | add it to `keys` and reload -- see `docs/ADD-A-DEVICE.md` |
| Key named but no action | missing from `hidKeys`, or another remote owns it | add the code to `hidKeys`; check `keyFilter` and `/state.profileId` |
| Model never loads | paths point at the old DSH install | set `modelDir` / `vadModel` through `POST /config` |
| Recognition empty | utterance too short or too quiet | check `/state` for audio seconds; the page reports short captures |
| Volume keys "work" but the plugin never sees them | macOS consumes them at the system level | not fixable; volume stays a system action |
| RSS keeps growing after precision switches | ONNX Runtime arena does not shrink at once | restart the daemon (`POST /restart`) |

More: [`docs/ADD-A-DEVICE.md`](docs/ADD-A-DEVICE.md#7-common-failures) and
[`docs/models.md`](docs/models.md). `bash tests/run.sh` catches daemon-side
regressions; `python3 scripts/probe-routes.py` lists what the running gateway
actually mounted.

## Development

Source is TypeScript under `src/`. The `sidecar/*.mjs`, `scripts/*.mjs`,
`tests/*.mjs` and `desktop/plugin.js` shipped in this repo are **build
products** and carry a `// GENERATED` banner. Edit `src/`, never the products.
Layout, extension rules and toolchain gotchas:
[`docs/TYPESCRIPT.md`](docs/TYPESCRIPT.md).

```bash
cd dev && npm install --no-audit --no-fund   # once: typescript + esbuild + @types
node dev/typecheck.mjs                       # whole project (tsc --noEmit equivalent)
node dev/build.mjs                           # src/** -> the runtime artifacts

bash tests/run.sh                            # builds, then all 75 assertions
#   harness.mjs           13  renderer: event stream, key engine, composer
#   model-precision.mjs    5  int8/fp32 selection and fallbacks
#   hid-filter.mjs        12  key ownership: active vs any
#   devices-registry.mjs  19  JSON profiles -> key table, bridge args
#   profile-render.mjs    26  per-device key rows, unknown-key handling, stt summary

node --check sidecar/server.mjs
bash sidecar/native/build.sh      # rebuild the universal bridge (Xcode CLT only)
python3 scripts/api-call.py GET /state  # authenticated call to 127.0.0.1:8791, prints JSON
python3 scripts/probe-routes.py   # which routes the running gateway actually has
python3 scripts/switch-device.py  # hot-switch the two remotes and time it
python3 scripts/verify-gateway.py # end-to-end check against the gateway
python3 scripts/watch-keys.py     # tail key events out of the daemon
```

`tests/` needs nothing but `node`; it stubs the SDK, React and the transport,
and needs no Electron, gateway or hardware. `probe-routes.py` and
`verify-gateway.py` attach to the running gateway and need the Hermes venv
Python (the system 3.9 has no `hermes` package); `switch-device.py` and
`watch-keys.py` talk to `127.0.0.1:8791` directly and are plain stdlib.

Generated products must be committed together with their sources -- see
[`CONTRIBUTING.md`](CONTRIBUTING.md). Every user-facing string lives in
`src/desktop/i18n/` (`types.ts` is the contract, `zh.ts` and `en.ts` must keep
the same key shape); nothing else in this repository contains non-English
prose. [`ACCEPTANCE.md`](ACCEPTANCE.md) records how each feature was verified
on real hardware, with the measured evidence.

CI runs the same gates on every push and pull request
(`.github/workflows/ci.yml`, macOS runner, no hardware): typecheck, build, a
dirty-tree check so a stale generated product cannot be committed, the five test
suites, `node --check` on the shipped products, and `scripts/cjk-scan.py`.

Two repository rules exist because they were learned the hard way:

- **Generated products ship with their sources.** The runtime `.mjs` files and
  `desktop/plugin.js` are build output; run `node dev/build.mjs` before
  committing or CI fails the dirty-tree check.
- **The guides never interpolate the daemon token.** `hermes plugins install`
  scans the repository, and a `curl` line that expands a credential variable
  raises a HIGH `exfiltration` finding, which turns the scan verdict into CAUTION
  and blocks installation for everyone who does not pass `--force`. Use
  `scripts/api-call.py`, which loads `~/.hermes/baton/token` itself.

## Contributing

`main` is protected: every change lands through a branch and a pull request with
a green `build-and-test` check, squash-merged, and direct pushes are refused even
for the owner. The branch naming, the pull-request template and the commit shape
are in [`CONTRIBUTING.md`](CONTRIBUTING.md). For a new remote,
[`docs/ADD-A-DEVICE.md`](docs/ADD-A-DEVICE.md) is the whole procedure; no Swift
build is involved.

## Known limitations

- **One bridge at a time.** A second ATVV client (another voice-remote app)
  steals the link; `/state.competitors` lists the processes it can see.
- **Per-model key maps, one global action map.** The model decides which keys
  exist; one `keyMap` decides what an action means.
- **A new gateway route needs one restart.** Routes mounted after the gateway
  started stay 404 until `hermes gateway restart`; the page falls back to cached
  `/state` fields meanwhile.
- **Bridge HID page allow-list.** Pages `0x07`, `0x0C`, `0xFF00` by default; a
  model that reports elsewhere needs its page listed in the profile's `pages`.

## License

MIT -- see [`LICENSE`](LICENSE). Model weights are separate works under their
own licences; see [`docs/models.md`](docs/models.md).

## Credits

- **SayAll / [HD838A/remote-mic-app](https://github.com/HD838A/remote-mic-app)**
  (GPL-3.0): the Android app that documented the ATVV behaviour this project
  needed. Only protocol, ADPCM and vendor quirks were studied; the
  implementation here is independent and this repository is MIT throughout.
- **[nijez/open-voice-bridge](https://github.com/nijez/open-voice-bridge)**
  (MIT): the original fork this work grew out of.
- **BlackHole**: the vendored audio modules under `sidecar/vendor/audio/` follow
  the captured-stream approach established by the BlackHole virtual-audio
  lineage.
- **FunAudioLLM/SenseVoice**: the local model option is SenseVoiceSmall,
  downloaded separately from FunAudioLLM/SenseVoice under its own model
  licence; the weights are not distributed here.
- **Silero VAD** (MIT) and **sherpa-onnx / sherpa-onnx-node** (Apache-2.0)
  provide the VAD and the ONNX runtime bindings.
