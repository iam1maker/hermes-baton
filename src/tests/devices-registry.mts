// Device model registry tests: pure Node, no hardware, no network — only the loadDeviceProfiles family.
// Coverage: _base + model merge, codeFor lookups (model keys and base keys), hidPairsOf dedup,
// profileForDeviceName on the two real device names, describeRegistry's current flag, user dir overriding an id.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadDeviceProfiles,
  codeFor,
  profileById,
  profileForDeviceName,
  keysOfProfile,
  hidPairsOf,
  pagesOf,
  describeRegistry
} from '../sidecar/devices/index.mjs'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail: string | number | undefined = '') => {
  if (ok) {
    pass += 1
    console.log(name, 'PASS', detail)
  } else {
    fail += 1
    console.log(name, 'FAIL', detail)
  }
}

// Built-in registry (no user directory)
const registry = loadDeviceProfiles({})

// 1) _base merges with the model JSONs: both models present, _base only enters the table, not profiles
check('built-in registry has two models', registry.profiles.length === 2, registry.profiles.map(p => p.id).join(','))
check('_base is not counted as a model', registry.base.id === '_base' && Object.keys(registry.base.keys).length > 0, Object.keys(registry.base.keys).length)
check(
  'table merges _base + models',
  registry.table.get('7/40') === 'Enter' && registry.table.get('12/65') === 'Enter' && registry.table.get('7/241') === 'Back',
  [...registry.table.entries()].length
)

// 2) codeFor: model key 0x0c/0x41→Enter (Chromecast), 0x07/0xf1→Back (Xiaomi), 0x07/0x28→Enter (from base)
check('codeFor 0x0c/0x41 → Enter', codeFor(registry, 0x0c, 0x41) === 'Enter', String(codeFor(registry, 0x0c, 0x41)))
check('codeFor 0x07/0xf1 → Back', codeFor(registry, 0x07, 0xf1) === 'Back', String(codeFor(registry, 0x07, 0xf1)))
check('codeFor 0x07/0x28 → Enter (base)', codeFor(registry, 0x07, 0x28) === 'Enter', String(codeFor(registry, 0x07, 0x28)))
check('codeFor unmapped usage → null', codeFor(registry, 0x07, 0x99) === null, String(codeFor(registry, 0x07, 0x99)))

// 3) hidPairsOf dedups and preserves order: the built-ins are two distinct pairs
{
  const pairs = hidPairsOf(registry)
  check('hidPairsOf returns the two built-in pairs', pairs.length === 2 && pairs.includes('0x18d1:0x9450') && pairs.includes('0x2717:0x32b8'), pairs.join(' '))
  check('pagesOf returns the union', pagesOf(registry).length === 3, pagesOf(registry).join(','))
}

// 4) profileForDeviceName: both real device names match, anything else → null
check(
  'real device name (Xiaomi voice remote) maps to xiaomi',
  profileForDeviceName(registry, '\u5c0f\u7c73\u84dd\u7259\u8bed\u97f3\u9065\u63a7\u5668')?.id === 'xiaomi-bt-remote-2',
  profileForDeviceName(registry, '\u5c0f\u7c73\u84dd\u7259\u8bed\u97f3\u9065\u63a7\u5668')?.id
)
check(
  'real device name "Chromecast Remote" maps to chromecast',
  profileForDeviceName(registry, 'Chromecast Remote')?.id === 'chromecast-google-tv',
  profileForDeviceName(registry, 'Chromecast Remote')?.id
)
check('unregistered model → null (no guessing)', profileForDeviceName(registry, 'Some Keyboard') === null, String(profileForDeviceName(registry, 'Some Keyboard')))

// 5) describeRegistry's current flag
{
  const rows = describeRegistry(registry, 'chromecast-google-tv')
  const cast = rows.find(row => row.id === 'chromecast-google-tv')
  const mi = rows.find(row => row.id === 'xiaomi-bt-remote-2')
  check('describeRegistry marks current', rows.length === 2 && cast?.current === true && mi?.current === false, rows.map(r => `${r.id}:${r.current}`).join(','))
  check('describeRegistry carries the key table', cast !== undefined && Array.isArray(cast.keys) && cast.keys.includes('Enter') && Array.isArray(cast.hidKeys) && Boolean(cast.defaultKeyMap.Enter), cast?.keys?.join(','))
}

// 6) user directory: same id overrides the built-in + own keys beat base/built-in keys + duplicate pairs dedup
const userDir = mkdtempSync(join(tmpdir(), 'rm-devices-'))
mkdirSync(userDir, { recursive: true })
writeFileSync(
  join(userDir, 'xiaomi-bt-remote-2.json'),
  JSON.stringify({
    id: 'xiaomi-bt-remote-2',
    label: 'My Xiaomi (edited)',
    hidPairs: ['0x2717:0x32b8'],
    keys: { '0x07/0xf1': 'Escape' },
    hidKeys: ['Back'],
    defaultKeyMap: { Back: { single: 'stop' } }
  })
)
writeFileSync(
  join(userDir, 'extra-remote.json'),
  JSON.stringify({
    id: 'extra-remote',
    label: 'Third-party remote',
    hidPairs: ['0x18d1:0x9450', '0x1234:0x5678'],
    keys: { '0x07/0x28': 'Enter' },
    hidKeys: ['Enter']
  })
)
{
  const merged = loadDeviceProfiles({ userDir })
  check('user dir overrides a built-in id', profileById(merged, 'xiaomi-bt-remote-2')?.label === 'My Xiaomi (edited)', profileById(merged, 'xiaomi-bt-remote-2')?.label)
  check('user model keys override built-in keys', codeFor(merged, 0x07, 0xf1) === 'Escape', String(codeFor(merged, 0x07, 0xf1)))
  check('user models join profiles', merged.profiles.length === 3 && profileById(merged, 'extra-remote') !== null, merged.profiles.map(p => p.id).join(','))
  const pairs = hidPairsOf(merged)
  check('hidPairsOf dedups', pairs.length === 3 && pairs.filter(p => p === '0x18d1:0x9450').length === 1, pairs.join(' '))
  check('keysOfProfile dedups, order preserved', JSON.stringify(keysOfProfile(profileById(merged, 'xiaomi-bt-remote-2'))) === JSON.stringify(['Escape', 'Back']), JSON.stringify(keysOfProfile(profileById(merged, 'xiaomi-bt-remote-2'))))
}
rmSync(userDir, { recursive: true, force: true })

console.log(`DEVICES SUMMARY ${pass} pass / ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
