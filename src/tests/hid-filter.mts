// Key-ownership unit test: by default only the currently active remote counts
// ('active'); only 'any' accepts keys from both.
//
// Background: the bridge listens to the whole machine through IOHIDManager, so
// when two remotes are connected both of them deliver key events. The product
// rule is "apart from volume, a key only does anything when pressed on the active
// remote" — the voice key already rides the connected remote, and keys follow it,
// so the other remote (possibly squashed inside a bag) cannot misfire. Volume
// keys belong to macOS itself and never reach the plugin.
// This test touches no hardware: it feeds transport events straight into the
// service and asserts whether emit('key') fired.
import { TypedEmitter } from '../sidecar/vendor/util/emitter.js'
import { RemoteMicService } from '../sidecar/vendor/plugin/service.js'
import type { SidecarTransport } from '../sidecar/vendor/ble/sidecar.js'

interface HidKey {
  page: number
  usage: number
  value: number
  device?: string
}

/** The slice of bridge events this test drives. */
type TestEvents = { hidkey: [HidKey]; device: [{ id: string; name: string }] }

/**
 * Test double for `SidecarTransport`: the real class owns a child process, this
 * one only needs the emitter surface the service subscribes to plus `write`.
 */
class TestTransport extends TypedEmitter<TestEvents> {
  write(_hex: string): void {}

  /** Fan a bridge event out to the service's listeners (emit is protected). */
  fire<K extends keyof TestEvents & string>(event: K, payload: TestEvents[K][0]): void {
    this.emit(event, ...([payload] as TestEvents[K]))
  }
}

let fails = 0
const check = (label: string, ok: boolean, extra?: unknown) => {
  if (!ok) fails += 1
  console.log(label, ok ? 'PASS' : 'FAIL', extra === undefined ? '' : JSON.stringify(extra))
}

const make = ({ targetDeviceName, keyFilter }: { targetDeviceName?: () => string; keyFilter?: () => string } = {}) => {
  const transport = new TestTransport()
  transport.write = () => {}
  const keys: Array<{ code: string; down: boolean }> = []
  const logs: string[] = []
  const service = new RemoteMicService({
    transport: transport as unknown as SidecarTransport,
    transcribe: async () => ({ text: '', audioSeconds: 0, inferenceSeconds: 0 }),
    log: (line: string) => logs.push(String(line)),
    targetDeviceName,
    keyFilter
  })
  service.on('key', event => keys.push(event))
  return { transport, keys, logs, service }
}

// Fixture device names only need to be distinct strings; the service compares the
// bridge-reported name against the configured target.
const ACTIVE = 'Xiaomi Voice Remote'
const OTHER = 'Chromecast Remote'

const BACK: HidKey = { page: 0x07, usage: 0x00f1, value: 1 } // page 0x07 usage 0xF1 → Back
const hidkey = (transport: TestTransport, device: string, base: HidKey = BACK) => transport.fire('hidkey', { ...base, device })

// 1) Default (no keyFilter) → only the current device counts; this is out-of-the-box behaviour
{
  const { transport, keys } = make({ targetDeviceName: () => ACTIVE })
  hidkey(transport, OTHER)
  check('default: key from another device is ignored', keys.length === 0, keys)
  hidkey(transport, ACTIVE)
  check('default: key from the current device passes', keys.length === 1, keys)
}

// 2) Explicit 'any' → same as above, nothing filtered
{
  const { transport, keys } = make({ targetDeviceName: () => OTHER, keyFilter: () => 'any' })
  hidkey(transport, ACTIVE)
  check('keyFilter=any does not filter', keys.length === 1, keys)
}

// 3) 'active' + configured target name → the other remote's key is ignored, logged once
{
  const { transport, keys, logs } = make({
    targetDeviceName: () => ACTIVE,
    keyFilter: () => 'active'
  })
  // Match on the stable [hid] tag plus the device name, not the full sentence:
  // the log wording is prose and may change.
  const ignoredLogs = () => logs.filter(l => l.includes('[hid]') && l.includes(OTHER))
  hidkey(transport, OTHER)
  check('active: key from another device is ignored', keys.length === 0, keys)
  check('active: ignoring is logged exactly once', ignoredLogs().length === 1, logs)
  hidkey(transport, OTHER)
  check('active: repeated press does not re-log', ignoredLogs().length === 1, logs)
  hidkey(transport, ACTIVE)
  check('active: key from the current device passes', keys.length === 1 && keys[0].code === 'Back', keys)
}

// 4) 'active' and the bridge reported a device (after a switch) → the bridge wins over the stale configured name
{
  const { transport, keys } = make({
    targetDeviceName: () => ACTIVE,
    keyFilter: () => 'active'
  })
  transport.fire('device', { id: 'uuid-cast', name: OTHER })
  hidkey(transport, ACTIVE)
  check('active: after a switch the old device is ignored', keys.length === 0, keys)
  hidkey(transport, OTHER)
  check('active: after a switch the new device passes', keys.length === 1, keys)
}

// 5) 'active' but nobody reported a device name (CBPeripheral.name may be nil) → must not drop every key
{
  const { transport, keys } = make({ targetDeviceName: () => '', keyFilter: () => 'active' })
  hidkey(transport, OTHER)
  hidkey(transport, ACTIVE)
  check('active: fail-open when no target is known', keys.length === 2, keys)
}

// 6) 'active' but the bridge omitted the device field (old bridge / other transport) → also unfiltered
{
  const { transport, keys } = make({ targetDeviceName: () => ACTIVE, keyFilter: () => 'active' })
  transport.fire('hidkey', { ...BACK })
  check('active: missing device field is not killed off', keys.length === 1, keys)
}

// 7) Flipping the filter at runtime takes effect immediately (config is read through a function)
{
  let mode = 'active'
  const { transport, keys } = make({ targetDeviceName: () => OTHER, keyFilter: () => mode })
  hidkey(transport, ACTIVE)
  const blocked = keys.length === 0
  mode = 'any'
  hidkey(transport, ACTIVE)
  check('hot-editing keyFilter takes effect immediately', blocked && keys.length === 1, keys)
}

console.log(fails === 0 ? 'HID FILTER SUMMARY pass' : `HID FILTER SUMMARY ${fails} fail`)
process.exit(fails === 0 ? 0 : 1)
