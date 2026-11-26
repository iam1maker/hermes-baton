// 设备型号注册表测试：纯 Node，不碰硬件、不碰网络，只验证 loadDeviceProfiles 一族。
// 覆盖：_base + 型号合并、codeFor 查表（型号键与 base 键）、hidPairsOf 去重、
// profileForDeviceName 两个真机名、describeRegistry 的 current 标记、用户目录覆盖同名 id。
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
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1
    console.log(name, 'PASS', detail)
  } else {
    fail += 1
    console.log(name, 'FAIL', detail)
  }
}

// 内置注册表（不带用户目录）
const registry = loadDeviceProfiles({})

// 1) _base 与型号 JSON 合并：两个型号都在，_base 只进查表不进 profiles
check('内置型号有两个', registry.profiles.length === 2, registry.profiles.map(p => p.id).join(','))
check('_base 不算型号', registry.base.id === '_base' && Object.keys(registry.base.keys).length > 0, Object.keys(registry.base.keys).length)
check(
  '查表合并 _base + 型号',
  registry.table.get('7/40') === 'Enter' && registry.table.get('12/65') === 'Enter' && registry.table.get('7/241') === 'Back',
  [...registry.table.entries()].length
)

// 2) codeFor：型号键 0x0c/0x41→Enter（Chromecast）、0x07/0xf1→Back（小米）、0x07/0x28→Enter（来自 base）
check('codeFor 0x0c/0x41 → Enter', codeFor(registry, 0x0c, 0x41) === 'Enter', codeFor(registry, 0x0c, 0x41))
check('codeFor 0x07/0xf1 → Back', codeFor(registry, 0x07, 0xf1) === 'Back', codeFor(registry, 0x07, 0xf1))
check('codeFor 0x07/0x28 → Enter（base）', codeFor(registry, 0x07, 0x28) === 'Enter', codeFor(registry, 0x07, 0x28))
check('codeFor 未登记 usage → null', codeFor(registry, 0x07, 0x99) === null, String(codeFor(registry, 0x07, 0x99)))

// 3) hidPairsOf 去重保序：内置是两个不同 pair
{
  const pairs = hidPairsOf(registry)
  check('hidPairsOf 内置两个 pair', pairs.length === 2 && pairs.includes('0x18d1:0x9450') && pairs.includes('0x2717:0x32b8'), pairs.join(' '))
  check('pagesOf 并集', pagesOf(registry).length === 3, pagesOf(registry).join(','))
}

// 4) profileForDeviceName：两个真机名都能命中，别的名字 → null
check(
  '真机名「小米蓝牙语音遥控器」命中 xiaomi',
  profileForDeviceName(registry, '小米蓝牙语音遥控器')?.id === 'xiaomi-bt-remote-2',
  profileForDeviceName(registry, '小米蓝牙语音遥控器')?.id
)
check(
  '真机名「Chromecast Remote」命中 chromecast',
  profileForDeviceName(registry, 'Chromecast Remote')?.id === 'chromecast-google-tv',
  profileForDeviceName(registry, 'Chromecast Remote')?.id
)
check('未登记型号 → null（不猜）', profileForDeviceName(registry, 'Some Keyboard') === null, String(profileForDeviceName(registry, 'Some Keyboard')))

// 5) describeRegistry 的 current 标记
{
  const rows = describeRegistry(registry, 'chromecast-google-tv')
  const cast = rows.find(row => row.id === 'chromecast-google-tv')
  const mi = rows.find(row => row.id === 'xiaomi-bt-remote-2')
  check('describeRegistry current 标记', rows.length === 2 && cast?.current === true && mi?.current === false, rows.map(r => `${r.id}:${r.current}`).join(','))
  check('describeRegistry 带按键表', Array.isArray(cast?.keys) && cast.keys.includes('Enter') && Array.isArray(cast?.hidKeys) && cast.defaultKeyMap.Enter, cast?.keys?.join(','))
}

// 6) 用户目录：同名 id 覆盖内置 + 自带的键压过 base/内置键 + 重复 pair 去重
const userDir = mkdtempSync(join(tmpdir(), 'rm-devices-'))
mkdirSync(userDir, { recursive: true })
writeFileSync(
  join(userDir, 'xiaomi-bt-remote-2.json'),
  JSON.stringify({
    id: 'xiaomi-bt-remote-2',
    label: '我的小米（改过）',
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
    label: '杂牌遥控器',
    hidPairs: ['0x18d1:0x9450', '0x1234:0x5678'],
    keys: { '0x07/0x28': 'Enter' },
    hidKeys: ['Enter']
  })
)
{
  const merged = loadDeviceProfiles({ userDir })
  check('用户目录覆盖同名 id', profileById(merged, 'xiaomi-bt-remote-2')?.label === '我的小米（改过）', profileById(merged, 'xiaomi-bt-remote-2')?.label)
  check('用户型号键压过内置键', codeFor(merged, 0x07, 0xf1) === 'Escape', codeFor(merged, 0x07, 0xf1))
  check('用户型号并入 profiles', merged.profiles.length === 3 && profileById(merged, 'extra-remote') !== null, merged.profiles.map(p => p.id).join(','))
  const pairs = hidPairsOf(merged)
  check('hidPairsOf 去重', pairs.length === 3 && pairs.filter(p => p === '0x18d1:0x9450').length === 1, pairs.join(' '))
  check('keysOfProfile 去重保序', JSON.stringify(keysOfProfile(profileById(merged, 'xiaomi-bt-remote-2'))) === JSON.stringify(['Escape', 'Back']), JSON.stringify(keysOfProfile(profileById(merged, 'xiaomi-bt-remote-2'))))
}
rmSync(userDir, { recursive: true, force: true })

console.log(`DEVICES SUMMARY ${pass} pass / ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
