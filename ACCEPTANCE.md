# Voice Remote -- acceptance checklist (3 minutes)

> Code lives in TypeScript under `src/`; `sidecar/*.mjs`, `desktop/plugin.js` and
> `tests/*.mjs` are products of `node dev/build.mjs` (each carries a
> `// GENERATED` banner). Conventions: `docs/TYPESCRIPT.md`.

> Everything that can be checked automatically has been checked (see the
> measured-results table below). One thing still needs a human: **press the
> remote's voice key**. The device only streams while the physical key is held;
> software cannot start it remotely.

## 0. (Optional) restart the Hermes app once

Two gateway routes, `/capture` and `/open/settings`, are not mounted
hot -- they appear only after the gateway process restarts. The page no longer
depends on them (the window self-check moved to the renderer, and Bluetooth
authorisation has a `file://` fallback), so everything below can be verified
without a restart. A restart only makes the "Bluetooth permission" step jump
straight to the Bluetooth pane.

## 0.5 Turn off the other wireless mic

That other copy of `atvv-link` competes for the same remote link. Check:

```bash
pgrep -fl atvv-link
```

If a second `atvv-link` from another app or checkout (for example
`~/Desktop/other/dsh-remote-mic/bin/atvv-link`) is listed, quit that app or
process. Only one `.../plugins/baton/sidecar/bin/atvv-link` is a clean state.
(A yellow warning bar on the page is about exactly this.)

## 1. Read the state (no key press)

Hermes sidebar -> **Voice Remote**:

- The link card should read **ready** and show the battery level (57% at the
  time of writing).
- Click "Self-test (sample)" -> it should return a non-empty transcript of the
  bundled clip (the clip is Chinese speech, so the text is Chinese; the point is
  that it is non-empty and matches the clip). It uses the bundled 6.7 s sample
  and does not overwrite your real recording.

Passing this step proves: Bluetooth bridge, ADPCM decode, segmentation,
SenseVoice, event stream and REST all work.

## 2. Window self-check (the first real key press)

Click "Window self-check 15 s" on the page; the button becomes "window open...",
and a hint appears under the card:
`Press the remote's voice key, say a sentence, release to recognise (Ns left)`.
Then **press the remote's voice key immediately** and say anything.

- Inside the window the states go: `capturing...` -> `transcribing...` -> a
  green bar `recognised in window: "<your words>" (0.12 s inference / 2.3 s
  audio) - not written to the composer`.
- No key within 15 seconds: a yellow bar `no key press within 15 s: ...`; check
  `[hid]` / `[atvv]` lines in the log.
- Speech too short (<1 s): a yellow bar showing `did not catch that (745 ms of
  audio)`; the window stays open, so say it again.

This window **needs no backend route**: the daemon pushes
`capturing -> transcribing -> transcript` on `/events`, and the renderer reads
it itself, so it can never 404 because the gateway was not restarted.

Passing this step proves the physical path (key -> stream -> decode) too.

## 3. Use it for real

Press the voice key inside Hermes and speak -> the text lands in the current
composer (insert mode by default, no auto-send).

## 4. Spot-check the key map

| Action | Expected |
|---|---|
| single `Enter` | while generating -> stop generation |
| double `Enter` | start a new session |
| double `Back` | insert the canned acknowledgement phrase |
| long `Enter` | swallow (no action, prevents accidental sends) |

## 5. If a step is wrong

```bash
# daemon state / competing bridges / battery
curl -s -H "Authorization: Bearer $(cat ~/.hermes/baton/token)" \
  http://127.0.0.1:8791/state -o /tmp/baton-state.json
python3 -m json.tool /tmp/baton-state.json

# recent log
tail -40 ~/.hermes/baton/daemon.log

# only one bridge running?
pgrep -fl atvv-link
```

The page's "daemon log" panel at the bottom shows the same content.

## The three known limitations

- The gateway routes `/capture` and `/open/settings` are **not hot-rescanned**
  (an already mounted router is not re-scanned, not even by
  `hermes plugins reload`); they appear only after a gateway process restart.
  Neither capability relies on a route now:
  - "Window self-check" became a client-side window fed by `/events`, always
    available;
  - "Bluetooth permission" first tries `/open/settings` (one step to the
    Bluetooth pane on 200), and falls back to opening System Settings through
    `file://` with a two-click hint on 404.
- The recognition self-test now uses the **bundled sample** by default
  (`sidecar/assets/sample-zh.wav`) instead of `last.wav` -- the previous
  utterance may be a 700 ms noise fragment, which produces the false conclusion
  "recognised successfully but empty output". To check your own last utterance:
  `POST /selftest {"file":"last"}`; an empty transcript falls back to the sample
  and sets `fellBack` to true.
- Battery is read at connection time and is not refreshed live; it updates after
  replugging the remote or restarting the daemon.
- The recognition self-test does **not** write `~/.hermes/baton/daemon.log` (it
  uses a separate path); the absence of a new `[stt]` line does not mean the
  button missed. To see whether it fired, look for the green
  `self-test result: ...` bar in the card. "Mock a transcript", by contrast,
  writes `[mock] ...`, which makes it a reliable side-effect probe.

## Measured results, night of 2026-11-14 (all passed)

| Item | Result | Evidence |
|---|---|---|
| voice key -> recognition -> insertion | yes, 3 times | `[stt]` line (4.435 s audio / 0.112 s inference), then a second one (3.61 s / 0.032 s) |
| double `Back` -> canned phrase | yes, 4 groups | 21:10:54-21:11:20, four down->down intervals of 178/225/180/195 ms, all inside `doubleMs=300`; the phrase text landed |
| single `Back` -> stop generation | yes | 21:13:37 `key Back true/false`, pressed while output was streaming, generation interrupted |
| volume + / - | yes | 21:33:06-08 `AudioVolumeUp` x2, `AudioVolumeDown` x2, `source=native`, no `[hid] unmapped` |
| new status-bar badge | yes | rounded lock frame + green dot + battery (inner bar 8 px ~ 57%), text in the tooltip |
| gateway `/open/settings` | yes | after a gateway restart an invalid pane name returns `400 unknown pane` (previously always 404) |

**Two real bugs fixed in that round:**

1. `sidecar/vendor/plugin/service.js`'s `hidUsageToCode()` was missing three
   mappings: `0xf1 -> Back` and `0x80/0x81 -> volume`. The vendored copy came
   from an older build; the DSH source (`src/plugin/service.ts:102`) had them.
   Symptom: pressing `Back` produced only
   `[hid] unmapped page=0x7 usage=0xf1 value=1`, so the double-press mapping
   never fired. After the fix the node process must be killed so the runtime
   respawns it; `POST /restart` only restarts the BLE service and does not swap
   code.
2. The DOM path let modifier keys through but missed `shiftKey`, so Shift+Enter
   could not insert a newline once "capture keyboard" was on. Fixed, with two
   assertions added.

**`Enter` closed (measured 2026-11-14 21:36):** the user pressed the remote's
OK key three times; each press started a voice capture. `/events` showed only
three `capturing -> ready(remote) -> transcribing -> transcript` groups (each
transcript a short confirmation that the key had been pressed), and
`daemon.log` had **no** new `[hid] usage` line: in the firmware the middle key
shares its HID signal with the voice key
(`page=0x7 usage=0xffffffff value=40`) and emits no independent key code.
Conclusion: **this remote has no independent Enter key**. The `Enter` mapping
can only affect a physical keyboard, through "capture keyboard keys"
(`Enter{single:submit,double:new-session,long:swallow}` stays, harmless for the
remote). No Enter mapping is done on the remote side; this item is closed.
An earlier line at 13:34:35, `page=0x7 usage=0x66 value=1`, is the HID
specification's **Power** key, unrelated to OK; binding it would mean adding
`0x66 -> 'Power'` to `hidUsageToCode()`, which is not recommended (an accidental
press changes state).

## 2026-11-14 21:5x: recognition succeeded but nothing was inserted (fixed)

Symptom: pressing the voice key moved the status bar through
`capturing -> transcribing`, `daemon.log` had an `[stt] <text>` line, but the
composer stayed empty with no hint bar.

Evidence (all measured):

- `/events` contained complete `transcript` events (text matching what was
  said); the daemon side had not failed;
- a temporary renderer counter showed `TX1 OK1 F0`:
  `host.composer.insertText()` returned **true** (ack succeeded), failures 0;
- at the same time `getDraft(null)` read 12 -> 15 characters, **accumulating**,
  while the visible composer still showed its placeholder;
- only after one `setDraft` call did the accumulated text appear all at once.

Root cause:

1. `insertText(null, ...)` goes through the app's "active composer" bus. That
   pointer can reference an invisible mounted instance when **the plugin
   replaces the main area wholesale** or when a **keep-alive tab leaves a
   residue** -- the ack is still true and the text lands in a draft the user
   cannot see.
2. More generally: `getDraft` only proves "it is in the state"; it **does not
   prove the editor re-rendered**. State present, UI empty, is the real shape of
   this bug.

Fix (`insertIntoComposer` in the renderer):

- address `host.state.focusedStoredSessionId` (the main composer), falling back
  to `'new'` when there is no session, and only then to `null`;
- after every ack, take **DOM evidence**: is there a visible instance among
  `document.querySelectorAll('[role="textbox"][contenteditable="true"]')`, and
  does its `textContent` contain the text (retry once after 120 ms if it does
  not fit yet);
- if the UI did not change, fall back to `setDraft(addr, same-or-appended value)`
  to force one re-render; if it still does not land, return false so the caller
  can say "recognised but not written to the composer" -- never fake success;
- in a DOM-less environment (the node test harness) treat it as "no evidence
  available" and trust the ack, otherwise unit tests would fail the success
  path.

## 2026-11-15 02:0x: page visual redesign (whole page)

The user asked, with a screenshot, to make the whole page look better. The
renderer (`desktop/plugin.js`, now about 1930 lines; backups `plugin.js.bak-*`
were kept) was rebuilt.

**Structure** (outer `maxWidth: 1180`, padding `22px 26px 56px`):

1. header: 38 px rounded icon + 19 px title + status pill + device/SenseVoice
   subtitle + "reconnect / stop listening";
2. link hero card: five metric tiles (state / battery with icon / recognition
   engine / session count / daemon), four ghost buttons at top right;
3. two columns: voice landing | canned phrases (equal height,
   `alignItems:'stretch'` + card body `flex:1`);
4. full-width key mapping: header key/single/double/long + keycaps + three
   selects filling the columns; "capture keyboard keys" in a recessed footer;
5. two columns: capture parameters | voice history (bordered recessed list,
   centred empty state);
6. full-width daemon log (`<pre class="rm-log">`, maxHeight 260).

**Design primitives**: `FS` type scale (10.5/11/11.5/12.5/13.5/16/19), `Btn`,
`Segmented`, `Card`, `Field`, `Tile`, `Panel`, `Keycap`, `Empty`, `MicGlyph`,
`BatteryIcon`. All colours go through `var(--ui-*)`; note there is **no
`--ui-amber`** (the old `C.amber || C.green` painted warnings green).

**Detail fixes in that round**

- stronger selected state on the segmented control: background
  `TINT(accent,36)`, border `TINT(accent,88)` (measured selected background
  luminance 66 -> 77, unselected 38, card background 26-30);
- the "after recognition" hint follows the toggle (insert only / send directly);
- the empty history state depends on the toggle (when off it says "not
  persisted", instead of contradicting "session 6 times");
- the language select is fixed at 96 px, the numeric unit column at 20 px, and
  control right edges align inside a card;
- phrase rows sit in a recessed list box (auto height, `maxHeight:220`), and the
  "add" row is pushed to the card bottom with `marginTop:'auto'`, so equal-height
  columns leave no half-card of blank space.

**Verification**: `cp plugin.js /tmp/x.mjs && node --check /tmp/x.mjs` ->
ESM_OK (**must** be checked this way; `node --check` inside the repo parses as
CJS and passes falsely); `bash tests/run.sh` 11/11 PASS; after in-app hot reload,
`screencapture -l6836` + PIL pixel sampling confirmed the new style (selected
pill luminance change).

**Caution**: the "same line / new paragraph" control was on "same line" (the
user's original setting). While debugging, sampling at x 940-978 landed on the
right-hand card (phrases) and was briefly misread as "new paragraph" being
selected -- confirm card ownership by its border (x ~ 894 / 909) before
sampling in a two-column layout.

## 2026-11-15 02:3x: switch to fp32 recognition (precision is switchable)

The user asked to switch to fp32 to feel it out for a while and to use fp32's
higher precision for other speech projects. fp32 was enabled, with int8 kept for
instant rollback.

**Weights**: `~/.dsh/speech-to-text/sensevoice/models/sensevoice-onnx/model.onnx`
(937,617,178 B, sha256 prefix `977016bd9c79f9eb343430b5`), downloaded from
`csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`, living beside
the int8 weight.

**A/B** (bundled 6.685 s sample, int8/fp32 interleaved three times each):

| Precision | Inference | Output | Characters |
|---|---|---|---|
| int8 | 0.112 / 0.114 / 0.116 s | plain sentence, no punctuation | 23 |
| fp32 | 0.095 / 0.095 / 0.101 s | same sentence, with punctuation | 25 |

Conclusion: fp32 was **faster** and **punctuated** (int8 drops punctuation
tokens), identical across three repetitions, so not a fluke. RSS after a clean
start: int8 937 MiB -> fp32 1250 MiB (+313 MiB); loadMs 403 -> 469-500 ms.

**Code changes**

- `sidecar/stt/sensevoice.mjs`: `resolveModelPaths({modelDir,vadModel,modelFile,precision})`
  gained precision selection and returns `precision/wanted/notes`; `dispose()`
  now really calls `recognizer.free()` / `detector.free()`. A `silero_vad.onnx`
  in the same directory must not be mistaken for ASR weights (`isAsr` filter) --
  a bug the unit test caught.
- `sidecar/server.mjs`: `precision` (whitelisted to int8/fp32) and `modelFile`
  entered DEFAULTS and `/config`; `local` became `let` + `buildLocal()`, and
  changing model configuration calls `dispose()` then rebuilds; `resetConfig`
  rebuilds too.
- renderer: the header subtitle and the "recognition engine" tile show
  `model.onnx . fp32`; the capture-parameters card gained a precision segmented
  control (int8 / fp32, reloading the model immediately).
- `tests/model-precision.mjs` + `run.sh`: five pure-logic assertions (default
  int8, explicit fp32, missing fp32 falls back and leaves a note, explicit file
  wins, missing file leaves a note). `bash tests/run.sh` then reported 16 PASS
  (11 harness + 5 precision).

**Known limitation**: switching precision repeatedly does not return the
onnxruntime arena immediately; RSS stacks past 2.4 GiB. To reset it, kill the
`server.mjs` pid and let the runtime respawn (it loads the precision from
settings; measured 1250 MiB after respawn).

## 2026-11-26 20:2x: hot-switching remotes (fixed and measured)

**Conclusion: switching devices restarts only the bridge child process and takes
0.45-0.77 s. No Hermes restart, no daemon restart.**

Two root causes, each with code-level evidence:

1. `discover()` in `sidecar/native/main.swift` was
   `connected.first(where: matches) ?? connected.first`: if the name did not
   match it fell back to the first candidate, so "switch to Xiaomi" reconnected
   the Chromecast. Now UUID first, name second, and no fallback when a device
   was named explicitly (`byID ?? first(where: matches) ?? (explicit ? nil : connected.first)`);
   rebuilt with `bash sidecar/native/build.sh` to overwrite the universal
   `sidecar/bin/atvv-link`.
2. `bridgeArgs` in `sidecar/server.mjs` was a module-level constant, and
   `SidecarTransport` held the **array by reference**, so after
   `service.restart()` the bridge still used the old arguments. Now
   `refreshBridgeArgs()` **mutates in place**, `applyPatch` refreshes arguments
   before restarting when `deviceId`/`deviceName` changed, and the log prints
   `bridge arguments updated: --hid --device ... --name ...`.

Measured (`scripts/switch-device.py`, on both new code paths):

```text
Xiaomi -> Chromecast   0.77s   device=Chromecast Remote  battery=100
Chromecast -> Xiaomi   0.45s   device=Xiaomi BT Remote 2  battery=55
daemon pid 26532 unchanged throughout; the bridge child is new each time
```

UI side: the daemon scans devices 6 seconds after start and every 5 minutes,
puts the result in `/state.devices`, so the "Remote" card lists candidates on
first paint (no "scan devices" click). The new `/devices` route is still 404 on
an old gateway (mounted routers are not re-scanned); the page falls back to the
cached list on 404, so **switching works without restarting the app**. A
screenshot confirmed the card renders `Chromecast Remote connected [switch]` /
`Xiaomi BT Remote 2 connected in use`.

Verification commands:

```bash
PY=~/.hermes/hermes-agent/venv/bin/python   # system python3 is 3.9 and cannot run the hermes package
python3 scripts/switch-device.py
node --check sidecar/server.mjs
bash tests/run.sh   # 16 PASS
```

## 2026-11-26 23:xx: only the active remote acts

**Symptom**: after switching to the Chromecast, pressing the Xiaomi's `Back`
still triggered "stop generation"; volume also still changed.

**Two separate things:**

1. **Volume +/-/mute are not the plugin's** -- in `hidutil list` both devices
   appear with `AppleUserHIDEventService`, and macOS translates the press into
   system volume regardless of which device the plugin is connected to, or
   whether the plugin runs at all. Nothing to change, nothing fixable.
2. **Ordinary keys are sniffed by the plugin** -- the bridge uses
   `IOHIDManagerSetDeviceMatchingMultiple` to match `0x2717/0x32b8` (Xiaomi)
   plus `0x18d1/0x9450` (Chromecast) at once, fully independent of `--device`,
   so keys from B reached the event stream while connected to A. This was
   tightened at the user's request.

**Changes**

- `sidecar/vendor/plugin/service.js`: `transport.on('device')` records
  `#activeDevice`; the top of `transport.on('hidkey')` filters by device --
  `expected = #activeDevice || targetDeviceName()`, and `device !== expected`
  returns immediately. Each ignored device name is logged once, with both the
  ignored and the active name in the message.
- `sidecar/server.mjs`: `new RemoteMicService({ ... targetDeviceName: () => (device && device.name) || config.deviceName || '' })`
  -- falls back to the configured target name while the bridge is not ready.
- **fail-open**: the device name may be nil, and an older bridge may omit the
  `device` field; when both sources are empty no filtering happens (better to
  over-collect than to lose everything).
- new `tests/hid-filter.mjs` (8 assertions), merged into `tests/run.sh`.

**Verification**

```text
bash tests/run.sh   -> 25 PASS / 0 FAIL (harness 12 + precision 5 + hid-filter 8)
node --check sidecar/server.mjs / service.js -> OK
hid-filter: non-active device ignored PASS / repeated presses do not re-log PASS /
            flipped after switch PASS / fail-open with no target PASS /
            missing device field does not kill the event PASS
```

**Needs one human check**: with the bridge connected to the **Chromecast**
(settings and `device.json` both `1EC33B1A-...`), press the **Xiaomi** `Back` --
expected: Hermes does nothing, generation is not stopped, and `daemon.log` gets
one line saying keys from a non-active device were ignored (naming the Xiaomi
remote as ignored and the Chromecast as active). Then press the Chromecast
`Back` -- expected: "stop generation" works normally.

## Key ownership switch (2026-11-26 evening)

- Default `keyFilter: "active"`: only the remote the bridge is connected to
  acts (the voice key goes to that remote, keys follow it); keys from the other
  remote are ignored and logged once with both names.
- Switch to `"any"`: both are accepted (the user explicitly asked for `active`
  as the default). Volume keys never pass through the plugin and always belong
  to macOS.
- Measured: `POST /config {"patch":{"keyFilter":"active"}}` -> `active`, then
  back to `any`; no daemon restart.
- Pitfall: renderer changes to `plugin.js` do **not** hot reload automatically
  (the cursor in `desktop.log` staying at an old value is the evidence); use
  Cmd-K -> `Reload desktop plugins` -> Enter.

## Fix for "no Voice Remote in the sidebar" (2026-11-27 01:00, three root causes)

| Root cause | What was actually true | Fix |
|---|---|---|
| gateway prefix | `dashboard/manifest.json`'s `name` was still `remote-mic` (a file missed by the rename), and the gateway mounts by it -> `/api/plugins/baton/*` all 404 while `/api/plugins/remote-mic/*` all 200 | set it to `baton`; `hermes plugins disable baton && enable baton` remounts routes (no app restart needed) |
| profile isolation | `~/.hermes/desktop-plugins/` is **app-global**, but `/api/plugins/<name>/*` is **per-profile**; the app was on `default` while the plugin was installed only in `forge` -> sidebar entry present, page 404 `Plugin not found` | `ln -sfn ~/.hermes/profiles/forge/plugins/baton ~/.hermes/plugins/baton` + `HERMES_HOME=~/.hermes hermes plugins enable baton`; the daemon reuses one port (pid unchanged) |
| desktop half opt-in | on every launch the app runs `reconcileUnifiedDesktopHalves`: if `desktop-plugins/<id>/plugin.js` and the packaged `desktop/plugin.js` are **byte-identical** it writes `.hermes-package.json` and adopts the directory, and `runtime-loader.ts:677` is `defaultEnabled: marker ? false : undefined` -> no contribution registered by default | leave a "[local copy]" comment at the end of the local copy so the files differ -> `sameFile` fails -> no marker -> loaded as a user-installed plugin, enabled by default (survives restart) |

**Do not trigger a rescan with `mv`**: `mv baton .baton-tmp` makes reconcile
immediately publish a `baton` with the marker; the second `mv` then nests the old
directory inside the new one, the watcher loads two plugins with the same id, the
second fails with `duplicate id "baton"`, and both contributions disappear.
Trigger a rescan by changing `plugin.js` content or Cmd-K reload instead.

### Morning acceptance (5 steps, each with a criterion)

1. **Restart the Hermes app** -> the sidebar should list "Voice Remote" after
   scheduled tasks. If not, the marker was written again:
   `ls -a ~/.hermes/desktop-plugins/baton/` (`.hermes-package.json` present means
   it recurred).
2. Click "Voice Remote" -> the top should be green **ready** + battery, no red
   bar. A red `Plugin not found` bar means the current profile does not have the
   plugin (`desktop.log`'s `gateway-route ... profile=<x>` says which profile the
   app is on).
3. **Press the remote's middle key and say a sentence** (for example "test voice
   remote one two three") -> the text lands in the composer;
   `tail ~/.hermes/baton/daemon.log` should have an `[stt]` line.
4. **Press `Back`** -> stop generation; **double `Back`** -> insert the canned
   acknowledgement phrase.
5. In the "Remote" card click "switch" on the Chromecast (0.5-0.8 s) -> the key
   table should change to the Chromecast's 11 rows
   (`Enter`, four arrows, `Home`, `YouTube`, `Netflix`, `InputSource`, `Power`,
   `Back`).
