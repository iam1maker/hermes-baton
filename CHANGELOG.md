# Changelog

Notable changes to Baton. Versions follow semver, and `plugin.yaml` plus
`dashboard/manifest.json` must carry the same number as the newest entry here.

## [1.0.0] - 2026-11-27

First public release.

### Added

- **Voice input over Bluetooth LE (ATVV).** Hold the remote's voice key, release,
  and the transcription lands in the focused Hermes composer. Works with the
  Xiaomi Bluetooth Voice Remote 2 / 2 Pro and the Chromecast with Google TV
  Remote out of the box; both were measured on real hardware
  (see `ACCEPTANCE.md`).
- **On-device recognition.** SenseVoice (int8 by default, fp32 optional) plus
  Silero VAD through `sherpa-onnx-node`. No audio leaves the machine unless an
  external `/audio/transcriptions` endpoint is configured, and that is the only
  mode that touches the network.
- **Self-installing speech stack.** `GET /stt` reports what is missing;
  `POST /stt/install` runs `scripts/fetch-models.mjs` as a job and streams
  `[models]` / `[sherpa]` progress to the page's voice-service card. The same
  work is available headless: `node scripts/fetch-models.mjs --with-sherpa`.
- **Key engine.** Single, double and long press per key, with a 300 ms double
  window and a 550 ms long-press threshold. Defaults: submit, stop generation,
  new session, canned acknowledgement, swallow.
- **Device profiles as data.** Each model is one JSON file
  (`sidecar/devices/*.json`) describing HID pairs, usage pages and the keys it
  actually has; the page and the bridge arguments are both derived from it, and a
  user copy under `~/.hermes/baton/devices/` overrides a built-in one.
- **Hot device switch and discovery.** `GET /devices` enumerates connected ATVV
  remotes, `POST /config` switches between them without restarting Hermes
  (measured 0.45-0.77 s), and keys from the remote that is not active are
  ignored by default.
- **Page.** Link status and battery, device picker, voice-service card with
  install progress, write target (inline / new paragraph), canned phrases, key
  mapping per model, capture parameters, voice history, self-test, daemon log,
  and an icon-only status-bar chip.
- **Tool surface.** One `baton` tool (`status`, `history`, `consume`, `start`,
  `stop`, `restart`, `selftest`, `config`, `key`) so an agent can drive the
  plugin without reading logs.
- **Bilingual UI.** All user-facing strings live in `src/desktop/i18n/`; the rest
  of the repository is ASCII-only, enforced by `scripts/cjk-scan.py`.

### Verified

- 75 assertions across five hardware-free suites (`bash tests/run.sh`), all
  measured on the reference machine: 6.685 s of audio recognised in 0.103 s with
  the bundled sample.
- Installability: `hermes plugins install iam1maker/hermes-baton` reaches the
  install step with a clean scan verdict; the guides use `scripts/api-call.py`
  instead of shell examples that interpolate the daemon token.

### Known limitations

- One ATVV link at a time; another voice-remote app steals it.
- Recognised text is inserted into the composer draft, not sent, unless
  `autoSend` is on and the draft is empty.
- Power, Netflix and YouTube keys are recognised and logged but cannot be bound:
  the remote is a system-level HID device and macOS consumes those.
- A newly added gateway route needs one gateway start before it is reachable.
