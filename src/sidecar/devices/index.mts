// Remote model registry — the only place in the plugin that needs to "know" a particular remote.
//
// One model = one JSON (sidecar/devices/*.json). Adding a remote just means dropping in a file:
//   match      VID/PID/name hints (the bridge uses them to decide which HID devices to listen to)
//   hidPairs   raw "--hid-device vid:pid" arguments
//   pages      HID usage pages this device reports
//   keys       page/usage → KeyboardEvent.code (only this model's own keys; standard keys live in _base.json)
//   hidKeys    whitelist of codes allowed into the event stream
//   defaultKeyMap  this model's default actions (a user keyMap in settings always wins)
// Users can also put their own models under <hermes home>/baton/devices/; same id overrides the built-in.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BUILTIN_DEVICES_DIR = dirname(fileURLToPath(import.meta.url))

/** An action: a built-in verb (submit / new-session / stop / swallow / phrase …) or an object carrying arguments. */
export type KeyAction = string | { action: string; name?: string; text?: string }

/** The three gestures on one key. Absent means that gesture is unbound. */
export interface KeyBinding {
  single?: KeyAction
  double?: KeyAction
  long?: KeyAction
}

/** KeyboardEvent.code → gesture table. keyMap in settings and a model's defaultKeyMap share this shape. */
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
  /** Absolute path of this model JSON (for troubleshooting; never on the UI's main path). */
  file: string
  match: DeviceMatch
  hidPairs: string[]
  pages: number[]
  /** `page/usage` → KeyboardEvent.code (only this model's own keys). */
  keys: Record<string, string>
  hidKeys: string[]
  defaultKeyMap: KeyMap
  voiceHint: string
  notes: string
}

export interface DeviceRegistry {
  base: { id: '_base'; keys: Record<string, string> }
  profiles: DeviceProfile[]
  /** Merged `page/usage` → code table (_base first, each model layered on top). */
  table: Map<string, string>
}

/** Model summary for /state and the page; `keys` is the row source the key map is rendered from. */
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

/** Raw shape of a model JSON: everything is narrowed from unknown; a bad file is skipped, never thrown. */
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
 * Read built-in models + user models. A later id overrides an earlier one; `_base.json` only contributes the shared key table.
 * Returns { base, profiles, table }, where table is the merged `page/usage` → code lookup.
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

/** HID usage lookup: model registry first. */
export function codeFor(registry: DeviceRegistry, page: number, usage: number): string | null {
  return registry.table.get(slot(page, usage)) || null
}

export function profileById(registry: DeviceRegistry, id: string): DeviceProfile | null {
  return registry.profiles.find((profile) => profile.id === id) || null
}

/** Device name reported by the bridge → model (the name may be a nickname; each hint is matched as a substring in both directions). */
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

/** Key-name list for a model (deduplicated, stable order: default keys first). */
export function keysOfProfile(profile: DeviceProfile | null | undefined): string[] {
  if (!profile) return []
  const out: string[] = []
  for (const code of Object.values(profile.keys)) if (!out.includes(code)) out.push(code)
  for (const code of profile.hidKeys) if (!out.includes(code)) out.push(code)
  return out
}

/** Device whitelist for the bridge arguments: deduplicated, order preserved. */
export function hidPairsOf(registry: DeviceRegistry): string[] {
  const out: string[] = []
  for (const profile of registry.profiles) {
    for (const pair of profile.hidPairs) if (!out.includes(pair)) out.push(pair)
  }
  return out
}

/** Pages every model reports (the bridge uses them to decide which pages to let through). */
export function pagesOf(registry: DeviceRegistry): number[] {
  const out: number[] = []
  for (const profile of registry.profiles) {
    for (const page of profile.pages) if (!out.includes(page)) out.push(page)
  }
  return out
}

/**
 * Model summary for /state and the page. `current` is the id of the active model.
 * keys is that model's key table, which the page's "key map" renders — switching remote should change this table.
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
