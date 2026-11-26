// 遥控器型号注册表 —— 插件里唯一需要「懂某台遥控器」的地方。
//
// 一个型号 = 一个 JSON（sidecar/devices/*.json）。新增遥控器只要丢一个文件进去：
//   match      VID/PID/名字提示（桥用它决定旁听哪些 HID 设备）
//   hidPairs   "--hid-device vid:pid" 的原样参数
//   pages      这台设备会上报的 HID usage page
//   keys       page/usage → KeyboardEvent.code（只写这台特有的键；标准键在 _base.json）
//   hidKeys    允许进入事件流的 code 白名单
//   defaultKeyMap  该型号的默认动作（用户 settings 里的 keyMap 永远压过它）
// 用户也可以把自己的型号放在 <hermes home>/baton/devices/ 下，同名 id 覆盖内置。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BUILTIN_DEVICES_DIR = dirname(fileURLToPath(import.meta.url))

/** 一个动作：内置动词（submit / new-session / stop / swallow / phrase …）或带参数的对象。 */
export type KeyAction = string | { action: string; name?: string; text?: string }

/** 同一个键上的三种手势。缺省表示该手势不绑定。 */
export interface KeyBinding {
  single?: KeyAction
  double?: KeyAction
  long?: KeyAction
}

/** KeyboardEvent.code → 手势表。settings 里的 keyMap 与型号的 defaultKeyMap 同形。 */
export type KeyMap = Record<string, KeyBinding>

export interface DeviceMatch {
  vendorIds: number[]
  productIds: number[]
  nameHints: string[]
}

export interface DeviceProfile {
  id: string
  label: string
  vendor: string
  /** 这份型号 JSON 的绝对路径（故障排查用，不出现在 UI 主路径上）。 */
  file: string
  match: DeviceMatch
  hidPairs: string[]
  pages: number[]
  /** `page/usage` → KeyboardEvent.code（只含该型号特有的键）。 */
  keys: Record<string, string>
  hidKeys: string[]
  defaultKeyMap: KeyMap
  voiceHint: string
  notes: string
}

export interface DeviceRegistry {
  base: { id: '_base'; keys: Record<string, string> }
  profiles: DeviceProfile[]
  /** 合并后的 `page/usage` → code 查表（_base 在前，型号逐层覆盖）。 */
  table: Map<string, string>
}

/** /state 与页面用的型号摘要；`keys` 是按键映射要渲染的行来源。 */
export interface DeviceSummary {
  id: string
  label: string
  vendor: string
  current: boolean
  keys: string[]
  hidKeys: string[]
  defaultKeyMap: KeyMap
  pages: number[]
  hidPairs: string[]
  voiceHint: string
  notes: string
}

/** 型号 JSON 的原始形态：一律 unknown 收窄，坏文件只跳过不抛。 */
interface RawProfile {
  id?: unknown
  label?: unknown
  vendor?: unknown
  disabled?: unknown
  match?: { vendorIds?: unknown; productIds?: unknown; nameHints?: unknown }
  hidPairs?: unknown
  pages?: unknown
  keys?: unknown
  hidKeys?: unknown
  defaultKeyMap?: unknown
  voiceHint?: unknown
  notes?: unknown
}

// radix 0 = auto-detect the 0x prefix the device JSONs use for pages/usages.
const num = (value: unknown): number =>
  typeof value === 'string' ? Number.parseInt(value, 0) : Number(value)

const slot = (page: number, usage: number): string => `${page}/${usage}`

const parseSpec = (spec: string): string => {
  const [page, usage] = String(spec).split('/')
  return slot(num(page), num(usage))
}

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String).filter(Boolean) : []

const asNumberArray = (value: unknown): number[] =>
  Array.isArray(value) ? value.map(num).filter(Number.isFinite) : []

const asStringRecord = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

const asKeyMap = (value: unknown): KeyMap => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: KeyMap = {}
  for (const [code, binding] of Object.entries(value as Record<string, unknown>)) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) continue
    const source = binding as Record<string, unknown>
    const next: KeyBinding = {}
    for (const gesture of ['single', 'double', 'long'] as const) {
      const action = source[gesture]
      if (typeof action === 'string') next[gesture] = action
      else if (action && typeof action === 'object' && typeof (action as { action?: unknown }).action === 'string') {
        const obj = action as { action: string; name?: unknown; text?: unknown }
        next[gesture] = {
          action: obj.action,
          ...(typeof obj.name === 'string' ? { name: obj.name } : {}),
          ...(typeof obj.text === 'string' ? { text: obj.text } : {}),
        }
      }
    }
    if (Object.keys(next).length > 0) out[code] = next
  }
  return out
}

function normalize(raw: RawProfile, file: string): DeviceProfile {
  const match = raw.match ?? {}
  return {
    id: String(raw.id),
    label: String(raw.label || raw.id),
    vendor: String(raw.vendor || ''),
    file,
    match: {
      vendorIds: asNumberArray(match.vendorIds),
      productIds: asNumberArray(match.productIds),
      nameHints: asStringArray(match.nameHints),
    },
    hidPairs: asStringArray(raw.hidPairs),
    pages: asNumberArray(raw.pages),
    keys: asStringRecord(raw.keys),
    hidKeys: asStringArray(raw.hidKeys),
    defaultKeyMap: asKeyMap(raw.defaultKeyMap),
    voiceHint: String(raw.voiceHint || ''),
    notes: String(raw.notes || ''),
  }
}

export interface LoadOptions {
  builtinDir?: string
  userDir?: string | null
}

/**
 * 读内置型号 + 用户型号。同名 id 后者覆盖前者；`_base.json` 只贡献公共键表。
 * 返回 { base, profiles, table }，table 是 `page/usage` → code 的合并查表。
 */
export function loadDeviceProfiles({
  builtinDir = BUILTIN_DEVICES_DIR,
  userDir = null,
}: LoadOptions = {}): DeviceRegistry {
  const baseKeys: Record<string, string> = {}
  const profiles = new Map<string, DeviceProfile>()
  for (const dir of [builtinDir, userDir]) {
    if (!dir || !existsSync(dir)) continue
    for (const file of readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()) {
      let raw: RawProfile | null
      try {
        raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as RawProfile
      } catch {
        continue
      }
      if (raw && raw.id === '_base') {
        Object.assign(baseKeys, asStringRecord(raw.keys))
        continue
      }
      if (!raw || !raw.id || raw.disabled) continue
      profiles.set(String(raw.id), normalize(raw, join(dir, file)))
    }
  }

  const table = new Map<string, string>()
  for (const [spec, code] of Object.entries(baseKeys)) table.set(parseSpec(spec), code)
  for (const profile of profiles.values()) {
    for (const [spec, code] of Object.entries(profile.keys)) table.set(parseSpec(spec), code)
  }

  return { base: { id: '_base', keys: baseKeys }, profiles: [...profiles.values()], table }
}

/** HID usage 查表：型号注册表优先。 */
export function codeFor(registry: DeviceRegistry, page: number, usage: number): string | null {
  return registry.table.get(slot(page, usage)) || null
}

export function profileById(registry: DeviceRegistry, id: string): DeviceProfile | null {
  return registry.profiles.find((profile) => profile.id === id) || null
}

/** 桥上报的设备名 → 型号（名字可能是昵称，逐个 hint 双向包含匹配）。 */
export function profileForDeviceName(registry: DeviceRegistry, name: string | null | undefined): DeviceProfile | null {
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
export function keysOfProfile(profile: DeviceProfile | null | undefined): string[] {
  if (!profile) return []
  const out: string[] = []
  for (const code of Object.values(profile.keys)) if (!out.includes(code)) out.push(code)
  for (const code of profile.hidKeys) if (!out.includes(code)) out.push(code)
  return out
}

/** 桥参数里的设备白名单，去重保序。 */
export function hidPairsOf(registry: DeviceRegistry): string[] {
  const out: string[] = []
  for (const profile of registry.profiles) {
    for (const pair of profile.hidPairs) if (!out.includes(pair)) out.push(pair)
  }
  return out
}

/** 所有型号会上报的 page（桥据此决定放行哪些页）。 */
export function pagesOf(registry: DeviceRegistry): number[] {
  const out: number[] = []
  for (const profile of registry.profiles) {
    for (const page of profile.pages) if (!out.includes(page)) out.push(page)
  }
  return out
}

/**
 * 给 /state 与页面的型号摘要。`current` 是当前生效型号的 id。
 * keys 是该型号的按键表，页面「按键映射」按它渲染 —— 换遥控器这张表就该变。
 */
export function describeRegistry(
  registry: DeviceRegistry,
  currentId: string | null = null
): DeviceSummary[] {
  return registry.profiles.map((profile) => ({
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
    notes: profile.notes,
  }))
}
