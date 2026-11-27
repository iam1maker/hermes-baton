# Design: Baton

One baton conducts the whole orchestra. The plugin turns a physical remote into
an input and control surface for Hermes: voice goes into the composer, keys
trigger actions. The name deliberately avoids "voice" or "remote", because what
it describes is a **class of input device** -- a knob, a foot pedal or a MIDI
controller could be added later without renaming anything.

---

## 1. Five layers; a change lands in the outermost one

```text
+-- renderer   desktop-plugins/baton/plugin.js   page, key engine, composer insertion
|              (product of src/desktop/plugin.tsx)
+-- gateway    dashboard/plugin_api.py            /api/plugins/baton/*  <- renderer talks only to this
+-- process    runtime.py + __init__.py           spawns/supervises the sidecar, registers the agent tool
+-- service    sidecar/server.mjs                 event stream, key engine, STT, config, HTTP 8791
|              (product of src/sidecar/server.mts)
+-- adapter    sidecar/devices/*.json             the model lives here, not in code
+-- transport  sidecar/native/main.swift (atvv-link)  BLE ATVV voice stream + IOHIDManager key sniffing
```

> Code lives under `src/` (TypeScript); `sidecar/*.mjs` and `desktop/plugin.js`
> are build products. Edit `src/`, then run `node dev/build.mjs`. Conventions:
> [TYPESCRIPT.md](TYPESCRIPT.md).

**Where a change belongs:**

| Change | Layer |
|---|---|
| a different remote | adapter (`sidecar/devices/*.json`) |
| a different recognition model | service (`sidecar/stt/`) |
| a different UI | renderer |
| a new kind of action (for example "open an app") | service + the renderer's action dropdown |
| a protocol change | transport (only then) |

---

## 2. Adapter layer: the model is data, not code

One remote is one file, `sidecar/devices/<id>.json`. Nothing in the code says
`if (model === 'Xiaomi')`.

| Field | Purpose | Read by |
|---|---|---|
| `id` | stable identifier used in config and events | everything |
| `label` / `vendor` | shown on the page | renderer |
| `match.vendorIds` / `productIds` | HID device match (decimal VID/PID) | bridge (indirectly), matching logic |
| `match.nameHints` | name the bridge reports -> model (contains match in both directions, tolerates nicknames) | `profileForDeviceName()` |
| `hidPairs` | sniffing allow-list, passed verbatim to the bridge as `--hid-device` | `bridgeArgs` |
| `pages` | usage pages this model reports | bridge `--hid-pages` |
| `keys` | `page/usage` -> `KeyboardEvent.code`, **only this model's specific keys** | `codeFor()` |
| `hidKeys` | allow-list of codes permitted into the event stream (miss one and the key does nothing at all) | service |
| `defaultKeyMap` | this model's default actions; a user `keyMap` in `settings.json` always wins | service |
| `voiceHint` / `notes` | page hint and known limitations | renderer |

`_base.json` holds the standard HID Usage Tables keys (keyboard page `0x07`,
Consumer page `0x0C` volume and Back) shared by every model. Merge order:
`_base` -> built-in models -> user models (`<state dir>/devices/*.json`, same
`id` replaces the built-in one).

### The cost of adding a remote

1. `hidutil list` for VID/PID; `atvv-link --hid --list 4` to confirm it
   connects.
2. Copy a JSON file and fill in `keys` (unnamed keys come from
   `daemon.log` lines shaped `[hid] unmapped page=... usage=...`, named with the
   vendor keylayout or the HID Usage Tables).
3. `POST /devices/reload` -- the registry is re-read, bridge arguments are
   recomputed, and the link restarts. **No daemon restart, no Hermes restart.**

That is the hot-plug property: the model is runtime-loadable data. The bridge's
page allow-list and device allow-list also come from the registry
(`--hid-pages` / `--hid-device`), so a new remote needs no Swift rebuild.

---

## 3. Page coupling: box 1 decides box 2

The device selected in the "Remote" card sets `/state.profileId`, and the "Key
mapping" card renders **only that model's keys** (`profiles[i].keys`), unioned
with keys the user added manually (keys the model cannot produce are labelled
"unknown", not hidden). Switching remotes changes both at once.

The same `keyMap` is global: action semantics stay consistent (`Back` -> stop
generation), while the model decides which keys exist. The benefit is that
switching back to the Xiaomi needs no reconfiguration; the cost is that a key
present on both remotes (`Back`) is changed for both at once. That is
deliberate: the user's mental model is "Back stops generation", not "the
Xiaomi's Back".

---

## 4. Dependencies: models and runtimes are not in the repository

| Dependency | Strategy |
|---|---|
| speech models (SenseVoice int8 ~250 MB / fp32 ~900 MB, Silero VAD) | never in git. Three routes: (1) `scripts/fetch-models.mjs` (Range resume, sha256, `--from` for offline import); (2) a local path set through the page/API; (3) an external OpenAI-compatible STT service (`sttBaseUrl`/`sttModel`/`sttApiKey`), no local model at all |
| `sherpa-onnx-node` (native `.node`) | an npm dependency of the sidecar, installed per platform; resolution `BATON_SHERPA` -> `sidecar/node_modules` -> host paths |
| Node runtime | the host's node (`~/.hermes/tools/node-*`), not bundled |
| Bluetooth bridge binary | a compiled universal binary in the repo, sources in the same repo (`build.sh` rebuilds it) |

Criterion: the page's "Recognition" card shows model status (path, size, whether
it is loaded) and, when something is missing, a download command instead of a
silent failure.

---

## 5. Permissions and boundaries

- **Bluetooth (TCC)**: needed both to connect the remote (ATVV streaming) and to
  sniff HID. macOS prompts on first use; `IOHIDManager` is read-only and does
  not intercept.
- **Keyboard**: neither voice nor keys write into the system input method; text
  only goes to the Hermes composer. "Capture keyboard keys" is off by default;
  only when enabled does the plugin take over Enter/Home from the physical
  keyboard.
- **Volume keys cannot be intercepted**: the remote is a system-level HID
  device, and volume up/down/mute are consumed by `AppleUserHIDEventService` at
  the system layer; the plugin only observes. Power / Netflix / YouTube behave
  the same way (lock screen, launch player), so those three are recognised but
  bound to no action by default.
- **Key ownership**: by default only the currently active remote produces
  actions (the voice key only ever goes to the connected one); keys from the
  other remote are logged once and dropped. This can be switched to "accept
  both".
- **Audio does not leave the machine**: recognition is fully local; the log
  contains no audio content and no Bluetooth address.

---

## 6. Known trade-offs

- `keyMap` is not split per model, for the reason in section 3. If it ever needs
  to be, one more layer (`keyMapByProfile`) does it without breaking existing
  configuration.
- The bridge's HID sniffing is **process-level**: while the daemon is alive, HID
  events from both remotes arrive, and filtering happens in the service layer
  (because only the bridge knows the device name).
- New gateway routes are not hot-rescanned: routes added later (`/devices`,
  `/devices/reload`, `/capture`) need one gateway restart (an app restart is not
  a gateway restart). The service layer also offers a direct 8791 connection
  and cached fields in `/state` as a fallback, so the page never goes blank.
