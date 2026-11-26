// 遥控器型号注册表 —— 插件里唯一需要「懂某台遥控器」的地方。
//
// 一个型号 = 一个 JSON（sidecar/devices/*.json）。新增遥控器只要丢一个文件进去：
//   match      VID/PID/名字提示（桥用它决定旁听哪些 HID 设备）
//   hidPairs   "--hid-device vid:pid" 的原样参数
//   pages      这台设备会上报的 HID usage page
//   keys       page/usage → KeyboardEvent.code（只写这台特有的键；标准键在 _base.json）
//   hidKeys    允许进入事件流的 code 白名单
//   defaultKeyMap  该型号的默认动作（用户 settings 里的 keyMap 永远压过它）
// 用户也可以把自己的型号放在 <hermes home>/remote-mic/devices/ 下，同名 id 覆盖内置。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BUILTIN_DEVICES_DIR = dirname(fileURLToPath(import.meta.url))

const num = value => (typeof value === 'string' ? Number.parseInt(value, 0) : Number(value))
const slot = (page, usage) => `${page}/${usage}`
const parseSpec = spec => {
  const [page, usage] = String(spec).split('/')
  return slot(num(page), num(usage))
}

function normalize(raw, file) {
  const match = raw.match || {}
  return {
    id: String(raw.id),
    label: String(raw.label || raw.id),
    vendor: String(raw.vendor || ''),
    file,
    match: {
      vendorIds: (match.vendorIds || []).map(num).filter(Number.isFinite),
      productIds: (match.productIds || []).map(num).filter(Number.isFinite),
      nameHints: (match.nameHints || []).map(String).filter(Boolean)
    },
    hidPairs: (raw.hidPairs || []).map(String).filter(Boolean),
    pages: (raw.pages || []).map(num).filter(Number.isFinite),
    keys: raw.keys && typeof raw.keys === 'object' ? { ...raw.keys } : {},
    hidKeys: (raw.hidKeys || []).map(String).filter(Boolean),
    defaultKeyMap: raw.defaultKeyMap && typeof raw.defaultKeyMap === 'object' ? { ...raw.defaultKeyMap } : {},
    voiceHint: String(raw.voiceHint || ''),
    notes: String(raw.notes || '')
  }
}

/**
 * 读内置型号 + 用户型号。同名 id 后者覆盖前者；`_base.json` 只贡献公共键表。
 * 返回 { base, profiles, table }，table 是 `page/usage` → code 的合并查表。
 */
export function loadDeviceProfiles({ builtinDir = BUILTIN_DEVICES_DIR, userDir = null } = {}) {
  const baseKeys = {}
  const profiles = new Map()
  for (const dir of [builtinDir, userDir]) {
    if (!dir || !existsSync(dir)) continue
    for (const file of readdirSync(dir).filter(name => name.endsWith('.json')).sort()) {
      let raw
      try {
        raw = JSON.parse(readFileSync(join(dir, file), 'utf8'))
      } catch {
        continue
      }
      if (raw && raw.id === '_base') {
        Object.assign(baseKeys, raw.keys || {})
        continue
      }
      if (!raw || !raw.id || raw.disabled) continue
      profiles.set(String(raw.id), normalize(raw, join(dir, file)))
    }
  }

  const table = new Map()
  for (const [spec, code] of Object.entries(baseKeys)) table.set(parseSpec(spec), code)
  for (const profile of profiles.values()) {
    for (const [spec, code] of Object.entries(profile.keys)) table.set(parseSpec(spec), code)
  }

  return { base: { id: '_base', keys: baseKeys }, profiles: [...profiles.values()], table }
}

/** HID usage 查表：型号注册表优先。 */
export function codeFor(registry, page, usage) {
  return registry.table.get(slot(page, usage)) || null
}

export function profileById(registry, id) {
  return registry.profiles.find(profile => profile.id === id) || null
}

/** 桥上报的设备名 → 型号（名字可能是昵称，逐个 hint 双向包含匹配）。 */
export function profileForDeviceName(registry, name) {
  const wanted = String(name || '').trim()
  if (!wanted) return null
  const lower = wanted.toLowerCase()
  for (const profile of registry.profiles) {
    for (const hint of profile.match.nameHints) {
      const h = hint.toLowerCase()
      if (lower.includes(h) || h.includes(lower)) return profile
    }
  }
  return null
}

/** 该型号的键名表（去重，稳定顺序：默认键在前）。 */
export function keysOfProfile(profile) {
  if (!profile) return []
  const out = []
  for (const code of Object.values(profile.keys)) if (!out.includes(code)) out.push(code)
  for (const code of profile.hidKeys) if (!out.includes(code)) out.push(code)
  return out
}

/** 桥参数里的设备白名单，去重保序。 */
export function hidPairsOf(registry) {
  const out = []
  for (const profile of registry.profiles) {
    for (const pair of profile.hidPairs) if (!out.includes(pair)) out.push(pair)
  }
  return out
}

/** 所有型号会上报的 page（桥据此决定放行哪些页）。 */
export function pagesOf(registry) {
  const out = []
  for (const profile of registry.profiles) {
    for (const page of profile.pages) if (!out.includes(page)) out.push(page)
  }
  return out
}

/**
 * 给 /state 与页面的型号摘要。`current` 是当前生效型号的 id。
 * keys 是该型号的按键表，页面「按键映射」按它渲染 —— 换遥控器这张表就该变。
 */
export function describeRegistry(registry, currentId = null) {
  return registry.profiles.map(profile => ({
    id: profile.id,
    label: profile.label,
    vendor: profile.vendor,
    current: profile.id === currentId,
    keys: keysOfProfile(profile),
    hidKeys: profile.hidKeys,
    defaultKeyMap: profile.defaultKeyMap,
    pages: profile.pages,
    hidPairs: profile.hidPairs,
    voiceHint: profile.voiceHint,
    notes: profile.notes
  }))
}
