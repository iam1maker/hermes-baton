# Adding a remote

A remote model is **data**, not code: one JSON file in `sidecar/devices/`. The
bridge learns which HID devices to listen to and which usage pages to pass
through from that file; the daemon learns the key names and their default
actions from it.

Two ready examples ship with the plugin:

- `sidecar/devices/xiaomi-bt-remote-2.json` — Xiaomi Bluetooth Voice Remote 2 / 2 Pro
- `sidecar/devices/chromecast-google-tv.json` — Chromecast with Google TV Remote (the better template: ten keys, one page)

---

## 0. Before you start

- The remote is paired and connected in **System Settings → Bluetooth** (the
  bridge connects to already-paired peripherals; it does not pair).
- Hermes has **Bluetooth** and, for keys, **Input Monitoring** — see
  [Permissions](../README.md#permissions). If the bridge logged
  `HID key reader needs Input Monitoring`, fix that first: without it you will
  see no key events at all and blame the JSON.
- Only one ATVV client at a time. Quit other voice-remote apps, check
  `/state.competitors`.

---

## 1. Get VID / PID from the system

```bash
hidutil list | grep -iE 'remote|Chromecast|Xiaomi'
```

Real output from a machine with both remotes connected (columns: `VendorID
ProductID LocationID UsagePage Usage RegistryID Transport Class Product …`):

```
0x2717  0x32b8  0x2bd1a498  1   6   0x10000517b  Bluetooth Low Energy  AppleUserHIDEventService  Xiaomi BT Remote 2
0x18d1  0x9450  0x1a3bc31e  12  1   0x1000122ba  Bluetooth Low Energy  AppleUserHIDEventService  Chromecast Remote
0x18d1  0x9450  0x1a3bc31e  12  1   0x1000122b7  Bluetooth Low Energy  IOHIDUserDevice           Chromecast Remote
```

Each remote appears at least twice — once as `AppleUserHIDEventService`, once as
`IOHIDUserDevice` — and the two rows carry the same VID/PID. Product names are
whatever macOS reports in the current system language; the rows above use the
English display names the shipped profiles use. The `UsagePage`
column tells you the device's main collection: `1` is Generic Desktop (keyboard
collection), `12` is Consumer Control. That is a hint about which `pages` the
profile needs, not a substitute for testing.

Take **VendorID**, **ProductID** and the exact **Product** string; ignore
`LocationID` (it changes per session).

Watch the two number bases:

| Where | Base | Example |
|---|---|---|
| `hidutil` output | hex, `0x`-prefixed | `0x2717` |
| `match.vendorIds` / `match.productIds` in JSON | **decimal** | `10007`, `12984` |
| `hidPairs` in JSON | hex string, `0x`-prefixed | `"0x2717:0x32b8"` |

`0x2717` = 10007, `0x32b8` = 12984. A decimal/hex mix-up is the most common
reason a profile silently matches nothing.

## 2. Confirm the remote speaks ATVV

The bridge has a list mode: it scans, reports candidates as JSON lines, and
exits — no long connection, nothing to break.

```bash
sidecar/bin/atvv-link --hid --list 4
```

Verified output (names and UUIDs vary):

```json
{"event":"state","value":"poweredOn"}
{"event":"candidate","name":"Chromecast Remote","connected":true,"id":"1EC33B1A-…"}
{"event":"candidate","name":"Xiaomi BT Remote 2","connected":true,"id":"98A4D12B-…"}
{"event":"log","message":"scanning for 4.0s"}
{"event":"bye","reason":"list complete"}
```

- Candidates are peripherals **already connected to the system** that expose the
  ATVV service (`retrieveConnectedPeripherals(withServices:)`). A remote that is
  asleep or unpaired will not appear — press a key or re-pair first. If it never
  appears, it is not an ATVV voice remote and the voice stream cannot work,
  whatever the key map says.
- The bridge reads commands from stdin and exits on EOF. Piping from
  `/dev/null` makes it print `{"event":"bye","reason":"stdin closed"}`
  immediately; run it in a terminal, or `sleep 6 | sidecar/bin/atvv-link --hid --list 4`.
- `--hid` also starts the key reader; it is harmless in list mode.
- Permission problems show up here first: `Bluetooth permission denied for this
  process`, or a `state` that never leaves `unknown`.

## 3. Copy the template

```bash
cp sidecar/devices/chromecast-google-tv.json sidecar/devices/my-remote.json
```

Use a user profile instead if you do not want to touch the install — the daemon
reads `<state>/devices/*.json` too (`<state>` = `~/.hermes/baton`,
`BATON_STATE_DIR` overrides), and a user file with the same `id` wins over
the built-in one. User profiles are the right place for a one-off remote.

## 4. Fill the fields

Every field, in the order `sidecar/devices/index.mjs` reads them:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Stable identifier used in `/state`, logs and the settings file. Must be unique; the same `id` in `<state>/devices/` overrides the built-in profile. |
| `disabled` | boolean *(optional)* | `true` skips the profile without deleting the file — handy while experimenting. |
| `label` | string | Name shown in the remote picker. |
| `vendor` | string | Shown under the label. |
| `match.vendorIds` | number[] | HID vendor IDs, **decimal**. Used to recognise the device. |
| `match.productIds` | number[] | HID product IDs, **decimal**. |
| `match.nameHints` | string[] | Substrings compared **both ways** (case-insensitive `contains`) against the name the bridge reports — a short hint can match several devices, so prefer the OS product name. Tried in profile order; the first hit wins. |
| `hidPairs` | string[] | `"0xVID:0xPID"`, passed verbatim to the bridge as `--hid-device`. This is the HID listen allow-list: a device not listed here produces no key events. |
| `pages` | number[] | Usage pages this model reports, **decimal** (`12` = `0x0C`, `7` = `0x07`, `65280` = `0xFF00`). The union across profiles becomes the bridge's `--hid-pages`; a page not listed is dropped by the bridge before it ever reaches the daemon, so nothing is logged. |
| `keys` | object | `"<page>/<usage>"` → `KeyboardEvent.code`, both numbers accepted in hex or decimal (`"0x0c/0x41": "Enter"`). Only this model's **specific** keys — standard HID keys already live in `_base.json` and are merged underneath. |
| `hidKeys` | string[] | Allow-list of codes permitted into `/events`. A key whose code is missing here is recognised and then dropped with **no log line**. |
| `defaultKeyMap` | object | Per code: `"single"`, `"double"`, `"long"` → action. Actions: `submit`, `stop`, `new-session`, `swallow`, `ignore`, `native`, or `{ "action": "phrase", "name": "<canned phrase>" }`. A flat string (`"Enter": "submit"`) means single-press only. The user's own `keyMap` in settings always wins. |
| `voiceHint` | string | One line shown on the page above the remote. |
| `notes` | string | Free text shown as the model's footnote; put the quirks here. |

`_base.json` is special: `"id": "_base"` only contributes `keys` to every
profile and is never listed as a remote. Do not edit it to add a model.

Minimal working file:

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

## 5. Name the keys

Start with an empty `keys` map (or only what you are sure of), reload, and press
every button once. Unknown usages are logged once each:

```
[hid] unmapped page=0x7 usage=0x29 value=1 device=My Remote
```

Read it from the daemon log:

```bash
tail -f ~/.hermes/baton/daemon.log
```

The format is exactly
`[hid] unmapped page=0x<hex> usage=0x<hex> value=<int>[ device=<name>]`, emitted
by `sidecar/vendor/plugin/service.js` once per `page/usage` pair.

To turn a pair into a name:

1. **Prefer the vendor keylayout** if the device is an Android/Google TV remote.
   Google publishes `Vendor_<vid>_Product_<pid>.kl` files in AOSP; a line like
   `key 0x0C0077 BUTTON_3` tells you usage `0x77` on page `0x0C` is YouTube.
   Chromecast's `0x77` / `0x78` were named exactly this way.
2. **Otherwise use the HID Usage Tables** (USB-IF, "HID Usage Tables for USB"):
   page `0x0C` is Consumer, `0x07` is Keyboard/Keypad. `0x41` = Menu/Select,
   `0x223` = AC Home, `0x19e` = Power, `0xe9/0xea/0xe2` = volume up/down/mute.
3. Name it with a DOM `KeyboardEvent.code`-shaped string (`Enter`, `ArrowUp`,
   `Home`, `Back`, `AudioVolumeUp`, `InputSource`, …). The renderer's key engine
   and `tests/hid-filter.mjs` speak that vocabulary; inventing `"OK"` or
   `"VolUp"` means the page cannot bind it.

Two traps visible in the existing profiles:

- Xiaomi's `Back` is on page `0x07` usage `0xf1`, and its volume on `0x80/0x81`
  — not the Consumer page. Per-model `keys` is exactly for this.
- The firmware emits pseudo-elements (`page=0x07 usage=0xffffffff value=40`,
  `page=0x0c usage=0xffffffff value=3`). Leave them unmapped; the bridge's page
  filter already ignores most of them.

## 6. Reload

```bash
python3 scripts/api-call.py POST /devices/reload
```

`POST /devices/reload` re-reads both registry directories, recomputes the bridge
arguments (`--hid-device` per `hidPairs`, `--hid-pages` from the `pages` union)
and restarts the link only if the current profile or the arguments changed. The
daemon and Hermes keep running. The response tells you what happened:

```json
{
  "ok": true,
  "profileId": "my-remote",
  "profiles": [ { "id": "my-remote", "label": "My Remote", "current": true, … } ],
  "bridgeArgs": ["--hid", "--hid-device", "0x18d1:0x9450", "--hid-device", "0x2717:0x32b8", "--hid-pages", "0xc,0x7,0xff00", …],
  "restarted": true
}
```

- `bridgeArgs` is the ground truth for "did the registry reach the bridge" —
  your `hidPairs` and pages must appear there.
- `restarted: false` means nothing changed; if you expected a change, the file is
  not where the daemon reads it (`state.devicesDir` in `/state` says where).
- `profileId` stays `null` and the log gets
  `[profile] unregistered model device=… -- add it as …/devices/xxx.json` when no
  profile's `nameHints` match. (The message is worded by the daemon; what
  matters is that it names the device and the directory.) An unregistered remote still works — just with no
  model-specific keys.
- If the route 404s through the *gateway*
  (`/api/plugins/baton/devices/reload`) while working on `127.0.0.1:8791`, that
  is the known "mounted routers do not rescan" rule: `hermes gateway restart`
  once.

After a successful reload:

```bash
python3 scripts/api-call.py GET /state > /tmp/baton-state.json
```

`state.profileId` should be your `id`; pressing a key should produce a line in
`/events` (or a `[hid] unmapped` line if you have not named it yet). Note that a
registered profile's defaults only replace the *derived* `keyMap`/`hidKeys` — an
explicit value in `settings.json` still wins, so a stale `hidKeys` from an earlier
experiment can hide a newly named key. Clear it with:

```bash
python3 scripts/api-call.py POST /config '{"patch":{"keyMap":null,"hidKeys":null}}'
```

`null` means "forget my override and go back to the profile default" for both
keys (`keyMap` is normalised to `{}`, and only an array `hidKeys` overrides the
profile, so `null` falls through). The change is written to
`~/.hermes/baton/settings.json` immediately; no reload needed.

## 7. Common failures

| Symptom | Cause | Fix |
|---|---|---|
| Nothing at all when pressing keys, not even `[hid] unmapped` | the usage page is not in `pages`, so the bridge dropped the report | add the page (decimal) and reload |
| Key logged as unmapped, but `keys` has it | the profile that owns the key is not the active one, or the spec is in a different base than you think (`parseInt(x, 0)` accepts `12`, `0xc`, and even `0x0c/65`) | keep the `keys` spec identical to the logged `page/usage` pair, then reload |
| Key appears in `[hid] unmapped` repeatedly even after adding it | the profile is not the active one (`keyFilter: active`, another remote connected) | switch remotes, or set `keyFilter: any` while testing |
| Key resolved but the page never sees it | `hidKeys` allow-list is missing the code — dropped silently in `server.mjs` | add the code to `hidKeys`, reload |
| Profile never selected; `/state.profileId` stays null | `match.nameHints` does not occur in the name the bridge reports (it is the OS product name, e.g. `Chromecast Remote`) | copy the name from `hidutil list` / `--list` output into `nameHints` |
| Volume keys "work" but never reach the plugin | macOS consumes them in `AppleUserHIDEventService` | not fixable; volume stays a system action |
| `Power` / `Netflix` / `YouTube` log, do nothing | they are in `hidKeys` but bound to no action, by design | bind an action only if you accept the OS acting first |
| Two profiles fight over one remote | duplicate `id`, or two profiles whose `hidPairs` both match | keep one `id`; a user profile with the same `id` replaces the built-in one |
| Works on `127.0.0.1:8791`, 404 through the gateway | mounted router does not rescan | `hermes gateway restart` |

## 8. Keep it

- Run `bash tests/run.sh` — the HID-ownership tests (`tests/hid-filter.mjs`) and
  the precision tests do not touch your profile, but they catch a daemon-side
  regression that would make every profile look broken.
- Put the odd bits in `notes`; the page shows them next to the model name and
  the next person (likely you) will need them.
- If the remote needs a page the bridge does not allow by default (`0x07`,
  `0x0C`, `0xFF00`), adding it to `pages` is enough — `--hid-pages` takes the
  union at runtime, no Swift rebuild.
