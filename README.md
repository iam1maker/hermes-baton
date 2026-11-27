# Baton

Baton turns a Bluetooth voice remote into an input and control surface for
[Hermes Agent](https://hermes-agent.nousresearch.com). Hold the remote's voice
key, speak, release: the audio arrives over BLE as an ATVV stream, is decoded and
segmented on your Mac, transcribed locally by SenseVoice, and the text lands in
the composer you are already typing into. The ordinary keys become gestures --
submit, stop generation, start a new session, insert a canned phrase.

No cloud account, no wake word, and no system microphone: the plugin asks for
Bluetooth and Input Monitoring, and uploads nothing by default.

Plugin id `baton` · Hermes `>=0.22.5` · macOS 13+ · Node 22+

## Features

- **Hold-to-talk, fully local.** The remote streams only while its own voice key
  is held; transcription runs on the CPU through `sherpa-onnx-node`, and the WAV
  never leaves the machine unless you point it at an external STT endpoint.
- **Keys become gestures.** `submit`, `stop`, `new-session`, `phrase`, `swallow`,
  `ignore`, `native` -- each bindable to single, double and long press.
- **Two remotes, hot-switchable.** Switching restarts only the bridge child
  process (measured 0.45-0.77 s), not the daemon and not Hermes.
- **Remotes are data.** A JSON profile carries VID/PID, usage pages, key names and
  default actions; a new model needs no Swift build and no daemon restart.
- **Precision is a setting.** `int8` (default) or `fp32` weights, switchable at
  runtime -- fp32 costs load time and memory and adds punctuation.
- **Honest diagnostics.** `POST /selftest` transcribes a bundled sample, so the
  model, the decoder and the event stream can be checked without the remote.

## Supported remotes

| Model | VID:PID | Usage pages | Keys |
| --- | --- | --- | --- |
| Xiaomi BT Remote 2 / 2 Pro | `0x2717:0x32b8` | `0x07` keyboard | `Back`, volume |
| Chromecast with Google TV Remote | `0x18d1:0x9450` | `0x0C` Consumer Control | `Enter`, arrows, `Home`, `InputSource`, `Power`, `Netflix`, `YouTube`, volume |

- The Xiaomi's centre key **is** the voice key: it produces no HID code of its
  own, so there is no separate `Enter` to bind.
- Volume keys are consumed by macOS before any app sees them, on both remotes.
- Both remotes are usually connected at the HID level at the same time; the
  `keyFilter` setting decides whose keys act -- `active` (current remote only, the
  default) or `any`.

## Install

Prerequisites: macOS 13+, Node.js 22+ on `PATH`, and Hermes with **Bluetooth**
plus, for keys, **Input Monitoring** granted (see [Permissions](#permissions)).

```bash
hermes plugins install iam1maker/hermes-baton
hermes plugins enable baton
```

Restart the app once, then enable the desktop half under **Settings ->
Capabilities -> Plugins** -- the renderer runs with the app's authority, so Hermes
asks explicitly. It ships as one plain `plugin.js`, with no build step at install
time.

The speech service is installed from the page, not the command line: open
**Baton** in the sidebar, find the **Speech service** card, and press **Install
engine** (33 MiB) then **Download models** (229 MiB). Both stream their progress
into the card. To avoid a local model entirely, put an OpenAI-compatible
`/audio/transcriptions` endpoint in the same card -- that is the only mode in
which audio leaves the machine, and it loads no native engine.

Model sizes, hashes, mirrors and the command-line equivalent are in
[`docs/models.md`](docs/models.md). Installing from a checkout, or using the
plugin from several profiles at once, is in
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Using it

Gesture windows are 300 ms for a double press and 550 ms for a long press.

| Action | Effect |
| --- | --- |
| `submit` | send the current draft |
| `stop` | stop the running generation |
| `new-session` | start a fresh session |
| `phrase` | insert a canned phrase from the page's list |
| `swallow` | consume the key and do nothing (a guard against accidental sends) |
| `ignore` | let the event pass without acting |
| `native` | leave the key to macOS |

Xiaomi BT Remote 2 / 2 Pro:

| Code | Single | Double | Long |
| --- | --- | --- | --- |
| `Back` | `stop` | `phrase` | -- |
| `AudioVolumeUp` / `AudioVolumeDown` | `native` | `native` | `native` |
| voice key (no HID code) | hold to talk | -- | -- |

Chromecast with Google TV Remote:

| Code | Single | Double | Long |
| --- | --- | --- | --- |
| `Enter` | `submit` | `new-session` | `swallow` |
| `Back` | `stop` | `phrase` | -- |
| `InputSource` | `new-session` | -- | -- |
| `Home`, arrows, `Power`, `Netflix`, `YouTube` | recognised, no default action | -- | -- |
| volume | `native` | `native` | `native` |

A `--` means the key is delivered to the page but bound to nothing. The action map
is global rather than per-model: the model decides *which keys exist*, one
`keyMap` decides *what an action means*, so rebinding `Back` means the same thing
on both remotes.

## Permissions

| Permission | Needed for | Not needed |
| --- | --- | --- |
| **Bluetooth** | connecting the remote and receiving its ATVV stream | -- |
| **Input Monitoring** | reading the remote's key reports; without it keys die while voice still works | Accessibility, Screen Recording, Full Disk Access |
| microphone | -- | never opened: audio comes from the BLE stream |

## Privacy

- **Audio never leaves the machine by default.** Transcription is in-process on
  the CPU. Setting an external STT endpoint POSTs each utterance's WAV there with
  your key as a bearer header -- that is what the option is for, and it is off by
  default.
- **Nothing else is uploaded.** No telemetry, no updater, no other outbound call.
  Apart from a configured STT endpoint, the process talks to nothing but the local
  bridge over stdio and to loopback.
- **Stored locally:** a bearer token for the loopback API (mode `0600`), your
  setting overrides, the last remote's CoreBluetooth UUID, the most recent
  utterance for `/audio/last`, a history file only when history is enabled (default
  **off**), and a daemon log that keeps the first 120 characters of each transcript
  for debugging. No audio, no MAC address, no key material.
- **The system microphone is never opened**, and the bridge listens to HID key
  reports in addition to the BLE stream.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Page answers `404 {"detail":"Plugin not found"}` | the app is on a profile where the plugin is not installed | install or link it into that profile |
| A new gateway route 404s while the daemon answers | mounted routers do not rescan | `hermes gateway restart` once |
| Keys do nothing, voice still works | Input Monitoring not granted | System Settings -> Privacy & Security -> Input Monitoring |
| Voice key does nothing at all | another ATVV client holds the link | quit other voice-remote apps; check `/state.competitors` |
| `[hid] unmapped page=... usage=...` | key not named in the profile | add it to `keys` and reload |
| Key named but no action | missing from `hidKeys`, or another remote owns it | add the code to `hidKeys`; check `keyFilter` |
| Recognition empty | utterance too short or too quiet | check `/state` for audio seconds |
| RSS grows after precision switches | ONNX Runtime's arena does not shrink at once | restart the daemon |

More failure modes, including the number bases used in profiles:
[`docs/ADD-A-DEVICE.md`](docs/ADD-A-DEVICE.md#7-common-failures).

## Known limitations

- **One bridge at a time.** A second ATVV client steals the link;
  `/state.competitors` lists the processes it can see.
- **Per-model key maps, one global action map.**
- **A new gateway route needs one restart.** Routes mounted after the gateway
  started stay 404 until `hermes gateway restart`.
- **Bridge HID page allow-list.** `0x07`, `0x0C` and `0xFF00` by default; a model
  that reports elsewhere must list its page in its profile.

## Documentation

| Document | What is in it |
| --- | --- |
| [`docs/models.md`](docs/models.md) | model files, hashes, mirrors, measured cost, licences |
| [`docs/ADD-A-DEVICE.md`](docs/ADD-A-DEVICE.md) | the whole procedure for a new remote |
| [`docs/DESIGN.md`](docs/DESIGN.md) | why the five layers are split as they are |
| [`docs/TYPESCRIPT.md`](docs/TYPESCRIPT.md) | source layout, build, extension rules |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | toolchain, test suites, scripts, voice pipeline, install from a checkout, profiles |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | branch flow, CI gate, what a pull request is checked against |
| [`ACCEPTANCE.md`](ACCEPTANCE.md) | how each feature was verified on real hardware |

## License

MIT -- see [`LICENSE`](LICENSE). Model weights are separate works under their own
licences; see [`docs/models.md`](docs/models.md).

## Credits

- **SayAll / [HD838A/remote-mic-app](https://github.com/HD838A/remote-mic-app)**
  (GPL-3.0): documented the ATVV behaviour this project needed. Only protocol,
  ADPCM and vendor quirks were studied; the implementation here is independent and
  this repository is MIT throughout.
- **[nijez/open-voice-bridge](https://github.com/nijez/open-voice-bridge)** (MIT):
  the original fork this work grew out of.
- **FunAudioLLM/SenseVoice**, **Silero VAD** (MIT) and **sherpa-onnx**
  (Apache-2.0): the model and the ONNX runtime bindings, each under its own
  licence.
