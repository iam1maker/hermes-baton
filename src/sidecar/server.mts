#!/usr/bin/env node
/**
 * baton daemon — the process half of the Hermes baton plugin.
 *
 * Owns: the CoreBluetooth bridge (`bin/atvv-link`), the ATVV/ADPCM front-end,
 * utterance segmentation, local SenseVoice transcription, and a loopback-only
 * HTTP API the Python plugin backend proxies to the desktop UI.
 *
 * Why a daemon instead of in-process code: the desktop renderer is a sandboxed
 * ESM plugin with no Node access, and the gateway's Python process must not
 * hold a native ONNX runtime. One long-lived Node process keeps the Bluetooth
 * link, the warm model, and the event history in one place.
 *
 *   node server.mjs [--port 8791] [--state-dir ~/.hermes/baton]
 *
 * Env: BATON_PORT, BATON_STATE_DIR, BATON_BRIDGE, BATON_PARENT_PID,
 *      BATON_MODEL_DIR / BATON_VAD_MODEL / BATON_SHERPA
 *      (legacy REMOTE_MIC_* names still work).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'

import { SidecarTransport } from './vendor/ble/sidecar.js'
import { RemoteMicService, hidUsageToCode, type RemoteMicState, type TranscriptEntry } from './vendor/plugin/service.js'
import { createSenseVoiceTranscriber, sherpaLookup } from './stt/sensevoice.mjs'
import {
  loadDeviceProfiles,
  codeFor,
  profileForDeviceName,
  hidPairsOf,
  pagesOf,
  keysOfProfile,
  describeRegistry
} from './devices/index.mjs'

const ROOT = dirname(new URL(import.meta.url).pathname)
const HOME = homedir()

/* ────────────────────────── config ────────────────────────── */

/** Shape of an action slot after normalisation: a built-in verb string, or a phrase reference (what normalizeSlot returns). */
type NormalizedSlot = string | { action: 'phrase'; name: string }

/** The three gestures on one key (after normalisation). Absent means that gesture is unbound. */
interface NormalizedBinding {
  single?: NormalizedSlot
  double?: NormalizedSlot
  long?: NormalizedSlot
}

/** KeyboardEvent.code → gesture table (after normalisation). */
type NormalizedKeyMap = Record<string, NormalizedBinding>

/** Daemon runtime config: the shape settings.json takes once mergeConfig normalises it. */
interface Config {
  gapMs: number
  maxMs: number
  trimMs: number
  cutoffHz: number
  language: string
  autoSend: boolean
  keysEnabled: boolean
  autoRestart: boolean
  autoStart: boolean
  hideActivated: boolean
  history: boolean
  historyLimit: number
  keyMap: NormalizedKeyMap
  phrases: Record<string, string>
  hidKeys: string[]
  sttBaseUrl: string
  sttModel: string
  sttApiKey: string
  deviceId: string
  deviceName: string
  keyFilter: 'active' | 'any'
  modelDir: string
  vadModel: string
  modelFile: string
  precision: 'int8' | 'fp32'
  /**
   * settings.json may carry arbitrary extra keys (DSH migration or hand edits); the original JS
   * passed them all through. The index signature keeps that same dynamism, while known keys still
   * resolve to the exact types declared above.
   */
  [key: string]: unknown
}

/** One signature for every recogniser: signal/options may be omitted on the self-test path (service passes only two arguments). */
type TranscriberResult = { text: string; audioSeconds?: number; inferenceSeconds?: number }
type ServerTranscriber = (
  wav: Uint8Array,
  signal?: AbortSignal,
  options?: { record?: boolean }
) => Promise<TranscriberResult>

/** A candidate transcript for /consume: real transcripts and self-test/mock events share this shape. */
interface PendingTranscript extends TranscriptEntry {
  mock?: boolean
  selftest?: boolean
  fellBack?: boolean
  source?: string
}

interface SelftestTranscript extends PendingTranscript {
  selftest: boolean
  source: string
}

/** A candidate remote found by listDevices in --list mode. */
interface ListedDevice {
  id: string
  name: string
  connected: boolean
}

/** Entry in the process table used to spot competing bridges. */
interface Competitor {
  pid: number
  command: string
}

/** Event-ring entry: payload goes into JSON as-is, with no type trimming. */
interface DaemonEvent {
  seq: number
  type: string
  at: number
  payload: unknown
}

/** CLI arguments (--port / --state-dir / --parent-pid). */
interface CliArgs {
  port?: number
  stateDir?: string
  parentPid?: number
}

// Fallback constants used when no model profile matches; with a profile the key defaults are
// derived per model from profile.defaultKeyMap / profile.hidKeys (see mergeConfig).
// Two-layer merge: model defaults ← user settings.json (user config always wins).
export const DEFAULT_KEY_MAP: NormalizedKeyMap = {
  Enter: { single: 'submit' },
  ContextMenu: { single: 'stop' },
  Home: { single: 'new-session' },
  Backquote: { single: 'swallow' },
  F5: { single: 'swallow' },
  Back: { single: 'stop' },
  // The Chromecast input-source key: the system does not know this HID usage, so macOS does
  // nothing when it is pressed — the only clean "second function key" on the whole remote.
  // Single press opens a new session.
  InputSource: { single: 'new-session' }
}

/** Keys the DOM never delivers — the only ones the native HID reader forwards. */
export const DEFAULT_HID_KEYS = [
  // Xiaomi BT Remote 2: Back and volume arrive on page 0x07
  'Back',
  'AudioVolumeUp',
  'AudioVolumeDown',
  'AudioVolumeMute',
  // Chromecast with Google TV remote: the primary collection is page 0x0C (Consumer Control),
  // with a separate OK key and d-pad (on the Xiaomi the middle key is the voice key, so these codes never appear).
  'Enter',
  'Home',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  // Dedicated keys: recognised but deliberately unbound — macOS consumes Power itself (pressing
  // it locks/sleeps the machine) and treats media keys as media keys, so binding Hermes actions to
  // them would turn "use the remote" into "lock my computer".
  'Power',
  'InputSource',
  'Netflix',
  'YouTube'
]

const DEFAULTS: Config = {
  gapMs: 350,
  maxMs: 30_000,
  trimMs: 200,
  cutoffHz: 100,
  language: 'zh',
  autoSend: false,
  keysEnabled: true,
  autoRestart: true,
  autoStart: true,
  hideActivated: false,
  history: false,
  historyLimit: 500,
  keyMap: DEFAULT_KEY_MAP,
  phrases: {},
  hidKeys: DEFAULT_HID_KEYS,
  sttBaseUrl: '',
  sttModel: 'whisper-1',
  sttApiKey: '',
  deviceId: '',
  deviceName: '',
  // Key ownership: 'active' = only the currently active remote counts (default); 'any' = both count.
  keyFilter: 'active',
  modelDir: '',
  vadModel: '',
  modelFile: '',
  precision: 'int8'
}

const SETTINGS_RANGES = {
  gapMs: [150, 3000],
  maxMs: [1000, 120_000],
  trimMs: [0, 2000],
  cutoffHz: [0, 8000],
  historyLimit: [10, 2000]
}

const KEY_ACTIONS = new Set(['submit', 'stop', 'new-session', 'swallow', 'ignore', 'native'])

function argsFrom(argv: string[]): CliArgs {
  const out: CliArgs = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--port') out.port = Number(argv[++i])
    else if (token === '--state-dir') out.stateDir = argv[++i]
    else if (token === '--parent-pid') out.parentPid = Number(argv[++i])
  }
  return out
}

const argv = argsFrom(process.argv.slice(2))
const envAny = (key: string): string | undefined => process.env[`BATON_${key}`] || process.env[`REMOTE_MIC_${key}`]
const PORT = Number(envAny('PORT') || argv.port || 8791)
const STATE_DIR = resolvePath(
  envAny('STATE_DIR')
  || argv.stateDir
  || join(HOME, '.hermes', 'baton')
)
const PARENT_PID = Number(envAny('PARENT_PID') || argv.parentPid || 0)
const BRIDGE_PATH = resolvePath(
  envAny('BRIDGE') || join(ROOT, 'bin', 'atvv-link')
)

mkdirSync(STATE_DIR, { recursive: true })

/** Read JSON; any failure or missing file falls back. The value is un-narrowed external input, so each call site narrows it. */
function readJson(file: string, fallback: unknown): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
}

/** 32-hex bearer token; the Python backend reads the same file. */
function ensureToken(): string {
  const file = join(STATE_DIR, 'token')
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim()
    if (/^[a-f0-9]{32,}$/.test(existing)) return existing
  }
  const token = randomBytes(24).toString('hex')
  writeFileSync(file, `${token}\n`, { mode: 0o600 })
  return token
}

const TOKEN = ensureToken()
const SETTINGS_FILE = join(STATE_DIR, 'settings.json')
const DEVICE_FILE = join(STATE_DIR, 'device.json')
const HISTORY_FILE = join(STATE_DIR, 'history.jsonl')
const LAST_WAV = join(STATE_DIR, 'last.wav')
const DAEMON_LOG = join(STATE_DIR, 'daemon.log')
const DSH_SETTINGS = join(HOME, '.dsh', 'remote-mic', 'settings.json')
const DSH_DEVICE = join(HOME, '.dsh', 'remote-mic', 'device.json')

const startedAt = Date.now()

/** First run: inherit the DSH settings/device the user already tuned. */
function seedFromDsh(): void {
  if (!existsSync(SETTINGS_FILE) && existsSync(DSH_SETTINGS)) {
    // JSON input: field access matches the original JS's bare access (only objects have a values field; on a scalar it is undefined).
    const seeded = readJson(DSH_SETTINGS, null) as Record<string, unknown> | null
    if (seeded && typeof seeded.values === 'object' && seeded.values !== null) {
      writeJsonAtomic(SETTINGS_FILE, { version: 1, values: seeded.values, seededFrom: DSH_SETTINGS })
      log(`migrated settings from DSH ${DSH_SETTINGS}`)
    }
  }
  if (!existsSync(DEVICE_FILE) && existsSync(DSH_DEVICE)) {
    const device = readJson(DSH_DEVICE, null) as Record<string, unknown> | null
    if (device && typeof device.id === 'string' && device.id) {
      writeJsonAtomic(DEVICE_FILE, device)
      log(`migrated last device from DSH ${device.name ?? device.id}`)
    }
  }
}

function savedValues(): Record<string, unknown> {
  const parsed = readJson(SETTINGS_FILE, {}) as Record<string, unknown> | null
  const values = parsed && typeof parsed.values === 'object' && parsed.values !== null ? parsed.values : {}
  return values as Record<string, unknown>
}

function mergeConfig(values: Record<string, unknown>): Config {
  // Key defaults are derived from the *current model*: profile.defaultKeyMap / profile.hidKeys.
  // Two-layer merge — model defaults ← user settings.json (explicit user config wins).
  // With no registry entry / no matching model, fall back to the DEFAULT_KEY_MAP / DEFAULT_HID_KEYS constants.
  const wantedName = (device && device.name) || (typeof values.deviceName === 'string' ? values.deviceName : '')
  const profile = wantedName ? profileForDeviceName(registry, wantedName) : null
  const baseKeyMap = profile ? profile.defaultKeyMap : DEFAULT_KEY_MAP
  const baseHidKeys = profile && profile.hidKeys.length > 0 ? [...profile.hidKeys] : [...DEFAULT_HID_KEYS]

  // values is raw settings.json (arbitrary keys/types): it is spread into config as in the original
  // JS, then narrowed by the normalisation loop below; the cast changes no runtime value.
  const config: Config = { ...DEFAULTS, ...(values as Config) }
  config.keyMap = { ...normalizeKeyMap(baseKeyMap), ...normalizeKeyMap(values.keyMap) }
  config.phrases = normalizePhrases(config.phrases)
  config.hidKeys = Array.isArray(values.hidKeys)
    ? (values.hidKeys as unknown[])
        .filter((code): code is string => typeof code === 'string' && Boolean(code.trim()))
        .map(code => code.trim())
    : baseHidKeys
  for (const [key, [min, max]] of Object.entries(SETTINGS_RANGES)) {
    const value = Number(config[key])
    config[key] = Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : DEFAULTS[key]
  }
  for (const key of ['language', 'sttModel', 'sttBaseUrl', 'sttApiKey', 'deviceId', 'deviceName', 'modelDir', 'vadModel', 'modelFile', 'precision']) {
    config[key] = typeof config[key] === 'string' ? config[key] : DEFAULTS[key]
  }
  config.precision = config.precision === 'fp32' ? 'fp32' : 'int8'
  config.keyFilter = config.keyFilter === 'any' ? 'any' : 'active'
  for (const key of ['autoSend', 'keysEnabled', 'autoRestart', 'autoStart', 'history', 'hideActivated']) {
    config[key] = Boolean(config[key])
  }
  return config
}

function normalizePhrases(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [name, text] of Object.entries(raw as Record<string, unknown>)) {
    const key = String(name).trim().slice(0, 40)
    const value = String(text ?? '').slice(0, 500)
    if (key && value) out[key] = value
    if (Object.keys(out).length >= 50) break
  }
  return out
}

function normalizeSlot(slot: unknown): NormalizedSlot | undefined {
  if (slot === undefined || slot === null) return undefined
  if (typeof slot === 'string') {
    if (KEY_ACTIONS.has(slot)) return slot
    if (slot.startsWith('phrase:')) return { action: 'phrase', name: slot.slice(7) }
    return undefined
  }
  if (typeof slot === 'object' && !Array.isArray(slot)) {
    // Field access on a JSON object: the cast is only for narrowing; at runtime it matches the original JS's bare access.
    const fields = slot as Record<string, unknown>
    if (fields.action === 'phrase' && typeof fields.name === 'string' && fields.name.trim()) {
      return { action: 'phrase', name: fields.name.trim() }
    }
    if (typeof fields.action === 'string' && KEY_ACTIONS.has(fields.action)) return fields.action
  }
  return undefined
}

function normalizeKeyMap(raw: unknown): NormalizedKeyMap {
  // Normalisation only, no defaulting — keyMap defaults are derived per model in mergeConfig.
  const out: NormalizedKeyMap = {}
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  for (const [code, binding] of Object.entries(source)) {
    if (typeof code !== 'string' || !code.trim()) continue
    if (typeof binding === 'string') {
      const single = normalizeSlot(binding)
      if (single) out[code] = { single }
      continue
    }
    if (!binding || typeof binding !== 'object') continue
    const fields = binding as Record<string, unknown>
    const entry: NormalizedBinding = {}
    for (const slot of ['single', 'double', 'long'] as const) {
      const value = normalizeSlot(fields[slot])
      if (value !== undefined) entry[slot] = value
    }
    if (Object.keys(entry).length > 0) out[code] = entry
  }
  return out
}

/** Reject a patch that names a phrase which does not exist (silent typos are worse). */
function validatePhraseRefs(keyMap: NormalizedKeyMap, phrases: Record<string, string>): void {
  for (const [code, binding] of Object.entries(keyMap)) {
    for (const slot of ['single', 'double', 'long'] as const) {
      const value = binding?.[slot]
      if (value && typeof value === 'object' && value.action === 'phrase' && !(value.name in phrases)) {
        throw new Error(`key ${code} ${slot} references unknown phrase "${value.name}"`)
      }
    }
  }
}

/* ────────────────────────── logging ────────────────────────── */

const logs: string[] = []
function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}`
  logs.push(line.length > 4000 ? `${line.slice(0, 4000)}…` : line)
  if (logs.length > 200) logs.splice(0, logs.length - 200)
  try {
    writeFileSync(DAEMON_LOG, `${logs.slice(-80).join('\n')}\n`)
  } catch {
    /* logging must never take the daemon down */
  }
}

/* ────────────────────────── event ring ────────────────────────── */

const events: DaemonEvent[] = []
let seq = 0
/** Backup copy of the last transcript, so `/consume` still answers after a UI reload. */
let fallbackPending: PendingTranscript | null = null
function pushEvent(type: string, payload: unknown): void {
  seq += 1
  events.push({ seq, type, at: Date.now(), payload })
  if (events.length > 400) events.splice(0, events.length - 400)
}

/* ────────────────────────── transcriber ────────────────────────── */

let lastDetail: string | null = null

function openAiTranscriber(config: Config): ServerTranscriber {
  const baseUrl = config.sttBaseUrl.replace(/\/+$/, '')
  const url = baseUrl.includes('/audio/transcriptions') ? baseUrl : `${baseUrl}/audio/transcriptions`
  return async (wav, signal) => {
    const form = new FormData()
    // TS 5.7+ Uint8Array<ArrayBufferLike> does not satisfy BlobPart's ArrayBuffer constraint;
    // this narrows the same value (the cast has no runtime effect), so the bytes match the original JS exactly.
    form.append('file', new Blob([wav as BlobPart], { type: 'audio/wav' }), 'utterance.wav')
    form.append('model', config.sttModel || 'whisper-1')
    if (config.language) form.append('language', config.language)
    const response = await fetch(url, {
      method: 'POST',
      headers: config.sttApiKey ? { authorization: `Bearer ${config.sttApiKey}` } : undefined,
      body: form,
      signal
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300)
      throw new Error(`recognition service ${response.status}: ${detail || response.statusText}`)
    }
    // fetch().json() returns un-narrowed external input; these checks match the original JS exactly.
    const payload = (await response.json()) as { text?: unknown } | null | undefined
    if (typeof payload?.text !== 'string') throw new Error('recognition service returned no text')
    return { text: payload.text }
  }
}

/** Which recogniser `/state` reports and the service actually uses. */
function transcriberKind(config: Config): 'openai' | 'sensevoice' | 'missing' {
  if (config.sttBaseUrl) return 'openai'
  return local.paths.ok ? 'sensevoice' : 'missing'
}

function transcriberFor(config: Config): ServerTranscriber {
  if (config.sttBaseUrl) return openAiTranscriber(config)
  if (!local.paths.ok) {
    return async () => {
      throw new Error(
        `no speech recognition configured: local SenseVoice model missing (${local.paths.problems.join('; ')}), and no recognition service URL set`
      )
    }
  }
  // record:false is for the self-test — a self-test must not overwrite "the last real recording" with test audio.
  return async (wav, signal, options = {}) => {
    if (signal?.aborted) throw new Error('aborted')
    if (options.record !== false) {
      try {
        writeFileSync(LAST_WAV, wav)
      } catch {
        /* the last-utterance copy is a debug aid */
      }
    }
    return local.transcribe(wav, { language: config.language })
  }
}

/* ────────────────────────── service ────────────────────────── */

/* ── device model registry ───────────────────────────────────────────
 * One model = one JSON (built-in under sidecar/devices/*.json, user models under
 * <STATE_DIR>/devices/, same id overrides the built-in). Adding a remote model = drop in a JSON +
 * POST /devices/reload — no code change, no daemon restart.
 */
const DEVICES_DIR = join(STATE_DIR, 'devices')
let registry = loadDeviceProfiles({ userDir: DEVICES_DIR })

seedFromDsh()
const cachedDevice = readJson(DEVICE_FILE, null) as Record<string, unknown> | null

/** The one the bridge really connected to (seeded from cache at boot); rememberDevice updates it as the bridge reports. */
let device: { id: string; name: string } | null =
  cachedDevice && typeof cachedDevice.id === 'string'
    ? { id: cachedDevice.id, name: (cachedDevice.name ?? '') as string }
    : null

let config = mergeConfig(savedValues())

/**
 * Current model: prefer the device name the bridge reports (it is the truth about "who is connected");
 * before the bridge reports, use the target name from config. A name matching no profile → null: an
 * unregistered model still works, it just has no model key defaults.
 */
function currentProfile() {
  const name = (device && device.name) || config.deviceName || ''
  return name ? profileForDeviceName(registry, name) : null
}

/** Key lookup: model registry first, built-in hidUsageToCode as fallback (keeps old behaviour for old/unregistered keys). */
function resolveCode(page: number, usage: number): string | null {
  return codeFor(registry, page, usage) || hidUsageToCode(page, usage)
}

/** Which model the current keyMap/hidKeys were derived from; recomputed when the model switches (syncProfileDefaults). */
let appliedProfileId = currentProfile()?.id ?? null

/** An unregistered model is noted only once; no filtering, no keyMap reset. */
const unknownProfilesNoted = new Set<string>()
noteUnknownProfile((device && device.name) || '')

const buildLocal = () =>
  createSenseVoiceTranscriber({
    // Unset = falsy: null/undefined take the same env/default fallback path inside sensevoice.
    modelDir: config.modelDir || undefined,
    vadModel: config.vadModel || undefined,
    modelFile: config.modelFile || undefined,
    precision: config.precision,
    log
  })

let local = buildLocal()

/**
 * Bridge arguments must be recomputed **in place** (push/splice, never a new array).
 * SidecarTransport holds this array by reference from construction and cannot see a replacement —
 * observed symptom: after a device switch the bridge really restarted, yet reconnected to the previous device.
 */
const bridgeArgs: string[] = ['--hid']
function refreshBridgeArgs(): string[] {
  const wantedId = config.deviceId || (cachedDevice && typeof cachedDevice.id === 'string' ? cachedDevice.id : '')
  bridgeArgs.length = 0
  bridgeArgs.push('--hid')
  // The HID listen whitelist comes from the model registry: one --hid-device per pair, pages is the
  // union declared by all models. A new remote model only needs a JSON; the rest is automatic.
  for (const pair of hidPairsOf(registry)) bridgeArgs.push('--hid-device', pair)
  const pages = pagesOf(registry)
  if (pages.length > 0) bridgeArgs.push('--hid-pages', pages.map(page => `0x${page.toString(16)}`).join(','))
  if (wantedId) bridgeArgs.push('--device', wantedId)
  if (config.deviceName) bridgeArgs.push('--name', config.deviceName)
  return bridgeArgs
}
refreshBridgeArgs()

const transport = new SidecarTransport({
  binaryPath: BRIDGE_PATH,
  args: bridgeArgs,
  onLog: message => log(`[bridge] ${message}`)
})

/** Unregistered-model notice: log once, no filtering, no keyMap reset (unknown remotes keep working). */
function noteUnknownProfile(name: string): void {
  if (!name || currentProfile() || unknownProfilesNoted.has(name)) return
  unknownProfilesNoted.add(name)
  log(`unregistered model device=${name}, add it as ${DEVICES_DIR}/xxx.json`)
}

/**
 * Model switched → recompute keyMap/hidKeys for the new model (explicit settings.json config still wins).
 * For an unregistered model leave keyMap alone: there are no usable model defaults, so keeping the
 * current state is the safest option.
 */
function syncProfileDefaults(): void {
  const profile = currentProfile()
  if (!profile || profile.id === appliedProfileId) return
  appliedProfileId = profile.id
  config = mergeConfig(savedValues())
  applyConfigToRuntime()
  log(`key defaults derived from model "${profile.label}" (${profile.id}); settings.json config still wins`)
}

function rememberDevice(next: { id?: string; name?: string } | null | undefined): void {
  if (!next?.id) return
  device = { id: next.id, name: next.name || device?.name || '' }
  try {
    writeJsonAtomic(DEVICE_FILE, { id: device.id, name: device.name, at: Date.now() })
  } catch (error) {
    log(`failed to write device cache: ${error instanceof Error ? error.message : String(error)}`)
  }
  noteUnknownProfile(device.name)
  syncProfileDefaults()
  pushEvent('device', device)
}

transport.on('device', rememberDevice)
transport.on('connected', rememberDevice)
transport.on('ready', rememberDevice)

const service = new RemoteMicService({
  transport,
  // In 'active' mode this decides who "the current one" is: prefer the device name the bridge really
  // connected to (device is updated by the bridge's device events); before ready, fall back to the configured target name.
  targetDeviceName: () => (device && device.name) || config.deviceName || '',
  // Config is read dynamically: changing keyFilter needs no restart (applyPatch takes effect immediately).
  keyFilter: () => config.keyFilter || 'active',
  // Key lookup: model registry first, built-in table as fallback (effective immediately after POST /devices/reload).
  resolveCode,
  transcribe: transcriberFor(config),
  preflight: () => {
    if (!existsSync(BRIDGE_PATH)) {
      return `Bluetooth bridge not found at ${BRIDGE_PATH} (reinstalling the plugin fixes this)`
    }
    try {
      if ((statSync(BRIDGE_PATH).mode & 0o111) === 0) chmodSync(BRIDGE_PATH, 0o755)
    } catch {
      /* an executable bridge is the normal case */
    }
    return null
  },
  gapMs: config.gapMs,
  maxMs: config.maxMs,
  trimMs: config.trimMs,
  cutoffHz: config.cutoffHz,
  autoRestart: config.autoRestart,
  log
})

service.on('state', ({ state, detail }) => {
  lastDetail = detail ?? null
  pushEvent('state', { state, detail: lastDetail })
})
service.on('device', next => {
  rememberDevice(next)
})
service.on('key', ({ code, down }) => {
  if (!config.keysEnabled) return
  if (!config.hidKeys.includes(code)) return
  pushEvent('key', { code, down, source: 'native' })
})
service.on('transcript', entry => {
  fallbackPending = entry
  pushEvent('transcript', entry)
  if (config.history) appendHistory(entry)
  log(`[stt] ${entry.text.slice(0, 120)}`)
})
service.on('error', ({ message }) => {
  lastSttError = message
  log(`[stt] failed: ${message}`)
  pushEvent('error', { message })
})
service.on('notice', notice => {
  log(`[stt] ${notice.message}`)
  pushEvent('notice', notice)
})

/* ── Bluetooth authorisation watchdog ────────────────────────────────
 * CoreBluetooth's delegate never calls back when TCC has not granted Bluetooth: the bridge process is
 * alive, the log stops at "atvv-link started", and the service sits in starting. In the UI that looks
 * exactly like "the remote is asleep", but the fix is completely different, so we tell them apart here
 * and put the verdict into /state.detail and into an error event. Criterion: no state event arrives
 * within 8 seconds of the bridge coming up (with permission granted it sends one at boot).
 */
let bridgeStateSeen = false
let clockState: string | null = null
transport.on('state', ({ state }) => {
  bridgeStateSeen = true
  clockState = state
  void clockState // the original JS never read clockState after writing it; one read satisfies noUnusedLocals, no behaviour change
  log(`[bridge] bluetooth state ${state}`)
})

const BLUETOOTH_AUTH_HINT =
  'Bluetooth not ready: macOS has not granted this process Bluetooth permission (System Settings ▸ Privacy & Security ▸ Bluetooth — tick Hermes / osascript, then restart Hermes), or system Bluetooth is off'

function armAuthWatch(): void {
  const timer = setTimeout(() => {
    if (bridgeStateSeen) return
    lastDetail = BLUETOOTH_AUTH_HINT
    log(`[bridge] ${BLUETOOTH_AUTH_HINT}`)
    pushEvent('error', { message: BLUETOOTH_AUTH_HINT })
  }, 8000)
  timer.unref?.()
}
armAuthWatch()

/* ────────────────────────── history ────────────────────────── */

function appendHistory(entry: TranscriptEntry): void {
  try {
    const line = JSON.stringify({ text: entry.text, at: entry.at, audioSeconds: entry.audioSeconds }) + '\n'
    const existing = existsSync(HISTORY_FILE) ? readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean) : []
    existing.push(line.trim())
    const kept = existing.slice(-config.historyLimit)
    writeFileSync(HISTORY_FILE, `${kept.join('\n')}\n`, { mode: 0o600 })
  } catch (error) {
    log(`failed to write history: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function readHistory(limit = 50): unknown[] {
  if (!existsSync(HISTORY_FILE)) return []
  const rows = readFileSync(HISTORY_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line) as unknown
      } catch {
        return null
      }
    })
    .filter(Boolean)
  return rows.slice(-Math.max(1, Math.min(500, limit))).reverse()
}

/* ────────────────────────── stt install ────────────────────────── */

/** What POST /stt/install can fetch. */
type InstallWhat = 'models' | 'sherpa' | 'all'
/** Output channel of a fetch-models.mjs line: '[models] …' / '[sherpa] …' / anything else. */
type InstallPhase = 'models' | 'sherpa' | 'other'

/** One background install run (GET /stt, GET + POST /stt/install). */
interface InstallJob {
  id: string
  what: InstallWhat
  state: 'running' | 'ok' | 'failed'
  startedAt: number
  endedAt: number | null
  percent: number
  lines: string[]
  error: string | null
}

/** The most recent install job; null until one is started. */
let installJob: InstallJob | null = null
/** Last speech-recognition failure (transcription error or failed install). */
let lastSttError: string | null = null

const INSTALL_LINE_CAP = 200

/** Spawn fetch-models.mjs and stream every line into the job ring, the event stream and the job record. */
function startInstall(what: InstallWhat, script: string, args: string[]): InstallJob {
  const job: InstallJob = {
    id: randomBytes(4).toString('hex'),
    what,
    state: 'running',
    startedAt: Date.now(),
    endedAt: null,
    percent: 0,
    lines: [],
    error: null
  }
  installJob = job
  const stderrLines: string[] = []
  const emit = (line: string): void => {
    job.lines.push(line)
    if (job.lines.length > INSTALL_LINE_CAP) job.lines.splice(0, job.lines.length - INSTALL_LINE_CAP)
    // percent comes from a percentage in the line; lines without one re-report the running value.
    const percent = /(\d+(?:\.\d+)?)\s*%/.exec(line)
    if (percent) job.percent = Math.max(0, Math.min(100, Number(percent[1])))
    const phase: InstallPhase = line.startsWith('[models]') ? 'models' : line.startsWith('[sherpa]') ? 'sherpa' : 'other'
    pushEvent('stt-install', { id: job.id, phase, line, percent: job.percent, state: job.state })
  }
  const finish = (state: 'ok' | 'failed', error: string | null): void => {
    if (job.state !== 'running') return
    job.state = state
    job.endedAt = Date.now()
    if (state === 'ok') job.percent = 100
    job.error = error
    if (error) lastSttError = error
    log(`[stt] install finished ${job.id} state=${state} ${job.endedAt - job.startedAt}ms`)
    pushEvent('stt-install', { id: job.id, phase: 'other', line: '', percent: job.percent, state: job.state })
    if (state !== 'ok') return
    try {
      // Point the config at the freshly installed model set — but never over an explicit user choice.
      // applyPatch persists settings.json through its own atomic writer; never hand-write it here.
      if (!config.modelDir) {
        applyPatch({
          modelDir: join(STATE_DIR, 'models', 'sensevoice-onnx'),
          vadModel: join(STATE_DIR, 'models', 'silero-vad', 'silero_vad.onnx')
        })
      }
      local.dispose()
      local = buildLocal()
      service.setTranscriber(transcriberFor(config))
      pushEvent('state', { state: service.state, detail: lastDetail })
    } catch (error) {
      log(`[stt] post-install reload failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  log(`[stt] install started ${job.id} what=${what}`)
  let child
  try {
    child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    finish('failed', error instanceof Error ? error.message : String(error))
    return job
  }
  const wire = (stream: NodeJS.ReadableStream, fromStderr: boolean): void => {
    let buffer = ''
    const take = (line: string): void => {
      if (!line.trim()) return
      if (fromStderr) stderrLines.push(line)
      emit(line)
    }
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        take(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
      }
    })
    stream.on('end', () => take(buffer))
  }
  wire(child.stdout, false)
  wire(child.stderr, true)
  child.on('error', error => finish('failed', error.message))
  // 'close' (not 'exit'): the exit handlers must see the complete stderr tail.
  child.on('close', code => {
    if (code === 0) return finish('ok', null)
    finish('failed', stderrLines.slice(-3).join('\n') || `fetch-models.mjs exited with code ${code}`)
  })
  return job
}

/** GET /stt: what recognition is configured, what is installed, what the installer is doing. */
function sttReport(): unknown {
  const lookup = sherpaLookup()
  const kind = transcriberKind(config)
  return {
    kind,
    ready:
      (kind === 'openai' && Boolean(config.sttBaseUrl)) ||
      (local.paths.ok && lookup.found !== null),
    language: config.language,
    local: {
      model: local.paths.model,
      precision: local.paths.precision,
      wanted: local.paths.wanted,
      tokens: local.paths.tokens,
      vad: local.paths.vad,
      dir: local.paths.dir,
      problems: local.paths.problems
    },
    engine: { ok: lookup.found !== null, path: lookup.found, tried: lookup.candidates },
    external: {
      baseUrl: config.sttBaseUrl || null,
      model: config.sttBaseUrl ? config.sttModel : null,
      hasKey: Boolean(config.sttApiKey)
    },
    job: installJob,
    lastError: lastSttError
  }
}

/* ────────────────────────── state ────────────────────────── */

/**
 * The candidate remotes from the most recent scan.
 * They live in /state rather than only /devices because routers already mounted in the gateway do not
 * rescan: a newly added route 404s until the app restarts, while /state was mounted long ago. Auto-scan
 * plus cache keeps "switch remote" working on an old gateway.
 */
let knownDevices: ListedDevice[] = []
let knownDevicesAt = 0

function snapshot() {
  const profile = currentProfile()
  // Expose only the keys the *current model* really sends: settings.json may still hold the previous
  // remote's defaults (e.g. leftover Enter/InputSource in Xiaomi mode). Rendering this view keeps the page
  // from showing "Chromecast keys while the current remote is a Xiaomi". The full map stays in keys.stored.
  const profileCodes = profile ? new Set(keysOfProfile(profile)) : null
  const visibleKeyMap = profileCodes
    ? Object.fromEntries(Object.entries(config.keyMap).filter(([code]) => profileCodes.has(code)))
    : config.keyMap
  return {
    now: Date.now(),
    pid: process.pid,
    uptimeMs: Date.now() - startedAt,
    state: service.state,
    detail: lastDetail,
    device,
    profileId: profile ? profile.id : null,
    profiles: describeRegistry(registry, profile ? profile.id : null),
    devicesDir: DEVICES_DIR,
    battery: service.diagnostics.battery ?? null,
    diagnostics: service.diagnostics,
    transcriber: {
      kind: transcriberKind(config),
      ...(transcriberKind(config) === 'sensevoice' ? local.info : {}),
      baseUrl: config.sttBaseUrl || null,
      model: config.sttBaseUrl ? config.sttModel : local.paths.model,
      language: config.language
    },
    bridge: { path: BRIDGE_PATH, exists: existsSync(BRIDGE_PATH) },
    devices: knownDevices,
    devicesAt: knownDevicesAt || null,
    competitors: findCompetingBridges(),
    keys: {
      enabled: config.keysEnabled,
      map: visibleKeyMap,
      stored: config.keyMap,
      doubleMs: 300,
      longMs: 550,
      hidKeys: config.hidKeys
    },
    audio: {
      gapMs: config.gapMs,
      maxMs: config.maxMs,
      trimMs: config.trimMs,
      cutoffHz: config.cutoffHz
    },
    autoSend: config.autoSend,
    history: { enabled: config.history, limit: config.historyLimit, count: readHistoryCount() },
    phrases: config.phrases,
    config: editable(config),
    head: seq,
    logs: logs.slice(-30)
  }
}

function readHistoryCount(): number {
  if (!existsSync(HISTORY_FILE)) return 0
  try {
    return readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

function editable(current: Config) {
  return {
    gapMs: current.gapMs,
    maxMs: current.maxMs,
    trimMs: current.trimMs,
    cutoffHz: current.cutoffHz,
    language: current.language,
    autoSend: current.autoSend,
    keysEnabled: current.keysEnabled,
    autoRestart: current.autoRestart,
    autoStart: current.autoStart,
    hideActivated: current.hideActivated,
    history: current.history,
    historyLimit: current.historyLimit,
    keyMap: current.keyMap,
    phrases: current.phrases,
    hidKeys: current.hidKeys,
    sttBaseUrl: current.sttBaseUrl,
    sttModel: current.sttModel,
    sttApiKey: current.sttApiKey ? '••••••' : '',
    deviceId: current.deviceId,
    deviceName: current.deviceName,
    keyFilter: current.keyFilter,
    modelDir: current.modelDir,
    vadModel: current.vadModel,
    modelFile: current.modelFile,
    precision: current.precision
  }
}

const EDITABLE_KEYS = new Set(Object.keys(editable(DEFAULTS)))

function applyPatch(patch: unknown) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('patch must be an object')
  // Narrow to the field table: the cast changes no runtime value (same as the original JS passing patch through); the checks below are identical.
  const unknown = Object.keys(patch).filter(key => !EDITABLE_KEYS.has(key))
  if (unknown.length > 0) throw new Error(`unknown config keys: ${unknown.join(', ')}`)
  const normalized = mergeConfig({ ...savedValues(), ...pickSaved(patch as Record<string, unknown>) })
  validatePhraseRefs(normalized.keyMap, normalized.phrases)

  // Persist only what differs from the defaults so a future default change lands.
  const saved: Record<string, unknown> = { ...savedValues() }
  for (const [key, value] of Object.entries(pickSaved(patch as Record<string, unknown>))) {
    if (JSON.stringify(value) === JSON.stringify(DEFAULTS[key])) delete saved[key]
    else saved[key] = value
  }
  writeJsonAtomic(SETTINGS_FILE, { version: 1, values: saved })
  const previousDevice = `${config.deviceId}\u0000${config.deviceName}`
  config = normalized
  if (['modelDir', 'vadModel', 'modelFile', 'precision'].some(key => key in patch)) {
    local.dispose()
    local = buildLocal()
    log(`recognition model switched: ${local.paths.model || '(missing)'} · ${local.paths.precision || '?'}`)
  }
  applyConfigToRuntime()
  // A different remote means the bridge has to be re-spawned with new filters.
  if (`${config.deviceId}\u0000${config.deviceName}` !== previousDevice) {
    refreshBridgeArgs()
    log(`bridge arguments updated: ${bridgeArgs.join(' ')}`)
    // The stale device cache would mask the "who is connected" decision, so aim at the new target now and let the bridge overwrite it.
    device = config.deviceId ? { id: config.deviceId, name: config.deviceName || '' } : device
    void service.restart().catch(error => log(`restart for new device failed: ${error instanceof Error ? error.message : String(error)}`))
  }
  log(`settings updated: ${Object.keys(patch).join(', ') || 'empty patch'}`)
  return editable(config)
}

/** The stored form of a patch: human aliases resolved, secrets kept verbatim. */
function pickSaved(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'sttApiKey' && value === '••••••') continue
    if (key === 'keyMap') out.keyMap = normalizeKeyMap(value)
    else if (key === 'phrases') out.phrases = normalizePhrases(value)
    else out[key] = value
  }
  return out
}

function applyConfigToRuntime(): void {
  service.setTranscriber(transcriberFor(config))
  service.setAudioOptions({
    gapMs: config.gapMs,
    maxMs: config.maxMs,
    trimMs: config.trimMs,
    cutoffHz: config.cutoffHz
  })
  service.setAutoRestart(config.autoRestart)
}

function resetConfig() {
  writeJsonAtomic(SETTINGS_FILE, { version: 1, values: {} })
  config = mergeConfig({})
  local.dispose()
  local = buildLocal()
  applyConfigToRuntime()
  log('settings restored to defaults')
  return editable(config)
}

/* ────────────────────────── http ────────────────────────── */

/**
 * List candidate remotes: the bridge's --list mode only scans and opens no long-lived connection; 4s
 * covers the batch that "the system already connected" (retrieveConnectedPeripherals is instant).
 * Note child.stdin must stay open — the bridge treats stdin EOF as an exit signal.
 */
function listDevices(seconds = 4): Promise<ListedDevice[]> {
  return new Promise(resolve => {
    const found: ListedDevice[] = []
    const seen = new Set<unknown>()
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill('SIGKILL') } catch { /* already exited */ }
      resolve(found)
    }
    const child = spawn(BRIDGE_PATH, ['--list', String(seconds)], { stdio: ['pipe', 'pipe', 'pipe'] })
    const timer = setTimeout(finish, (seconds + 6) * 1000)
    let buffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (!line.trim()) continue
        // The bridge's stdout is JSON lines; the cast only narrows types, and bad lines (including the
        // TypeError from a null line) behave exactly as in the original JS.
        let event: Record<string, unknown> | undefined
        try { event = JSON.parse(line) as Record<string, unknown> } catch { continue }
        if (event === undefined) continue // JSON.parse cannot return undefined; this line only helps definite-assignment analysis
        if (event.event === 'candidate' && event.id && !seen.has(event.id)) {
          seen.add(event.id)
          found.push({ id: String(event.id), name: String(event.name || ''), connected: event.connected === true })
        }
        if (event.event === 'bye') return finish()
      }
    })
    child.on('error', finish)
    child.on('exit', finish)
  })
}

/**
 * Scan once and write the result into the cache (/state carries it out). A failed scan does not clear
 * the old result: showing the devices seen last time beats showing an empty list.
 */
let scanningDevices = false
async function refreshDevices(seconds = 3): Promise<ListedDevice[]> {
  if (scanningDevices) return knownDevices
  scanningDevices = true
  try {
    const found = await listDevices(seconds)
    if (found.length) {
      knownDevices = found
      knownDevicesAt = Date.now()
    }
    return knownDevices
  } finally {
    scanningDevices = false
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  })
  res.end(body)
}

function authorized(req: IncomingMessage, url: URL): boolean {
  const header = req.headers.authorization || ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  const query = url.searchParams.get('token') || ''
  return bearer === TOKEN || query === TOKEN
}

function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        // The request body is external input: the cast only narrows types, and non-object JSON behaves as in
        // the original JS (e.g. POST /config with null still throws a TypeError on body.reset).
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      } catch (error) {
        reject(new Error(`JSON parse failed: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
    req.on('error', reject)
  })
}

/* ── competing bridge detection ──────────────────────────────────────
 * DSH's remote-mic (or another Hermes profile) also runs an atvv-link and fights over the same
 * remote's ATVV connection: the symptom is connect-then-drop (link lost), or choppy audio. We read the
 * process table directly and put "another bridge is running" into /state.competitors so the page can ask the user to close it.
 */
let competitorCache: { at: number; list: Competitor[] } = { at: 0, list: [] }
function findCompetingBridges(): Competitor[] {
  if (Date.now() - competitorCache.at < 20_000) return competitorCache.list
  let list: Competitor[] = []
  try {
    const out = execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' })
    list = out
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const [pid, ...rest] = line.split(/\s+/)
        const command = rest.join(' ')
        return { pid: Number(pid), command }
      })
      // Only processes whose argv[0] really is atvv-link count: a process that merely has the string on
      // its command line (our own pgrep/grep, say) is not a competitor.
      .filter(item => {
        const argv0 = item.command.split(/\s+/)[0] || ''
        return Number.isFinite(item.pid) && item.pid !== process.pid && /\/atvv-link$/.test(argv0) && !argv0.includes(BRIDGE_PATH)
      })
  } catch {
    list = []
  }
  competitorCache = { at: Date.now(), list }
  return list
}

/* ── supervisor: the service must not stop "by itself" ───────────────
 * Only an explicit user "stop listening" (/stop) may leave it stopped long-term; any other path into
 * stopped (a history event, another process calling in, a stray UI click) silently breaks the whole
 * chain and the next day it looks like "the plugin is broken".
 */
let userStopped = false
let supervisorTimer: NodeJS.Timeout | null = null
// Serialise every start/restart: when the listen callback's autoStart, runtime's POST /start and the
// supervisor all arrive together, the transport would spawn one bridge each and both would fight over the same remote.
let lifecycleGate: Promise<void> = Promise.resolve()
function serialize(fn: () => Promise<void>): Promise<void> {
  const next = lifecycleGate.then(fn, fn)
  lifecycleGate = next.then(() => undefined, () => undefined)
  return next
}
function startSupervisor(): void {
  if (supervisorTimer !== null) return
  supervisorTimer = setInterval(() => {
    if (!config.autoStart || userStopped) return
    if (service.state !== 'stopped') return
    log('[supervisor] service is stopped (not by the user), reconnecting automatically')
    void serialize(() => service.start()).catch(error => log(`[supervisor] restart failed: ${error instanceof Error ? error.message : String(error)}`))
  }, 15_000)
  if (typeof supervisorTimer.unref === 'function') supervisorTimer.unref()
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`)
  try {
    if (url.pathname === '/health') {
      // Health is unauthenticated but says nothing sensitive: it only lets the
      // supervisor detect a live daemon on the port before dialing with a token.
      return json(res, 200, { ok: true, pid: process.pid, uptimeMs: Date.now() - startedAt, auth: 'required' })
    }
    if (!authorized(req, url)) return json(res, 401, { error: 'unauthorized' })

    switch (`${req.method} ${url.pathname}`) {
      case 'GET /state':
        return json(res, 200, snapshot())

      case 'GET /devices': {
        // With a second remote (Chromecast / Google TV etc.) the UI needs to know which other ATVV
        // devices the system has, so the user can switch. The scan is read-only and does not touch the live link.
        const seconds = Math.max(2, Math.min(10, Number(url.searchParams.get('seconds') || 4)) || 4)
        const devices = await refreshDevices(seconds)
        return json(res, 200, { devices, current: device, at: knownDevicesAt || Date.now() })
      }

      case 'POST /devices/reload': {
        // Hot-swap models: re-read the built-in and user model directories. The registry is replaced and the
        // bridge arguments refreshed in place; the link restarts only if the current model or the arguments changed
        // (service.restart only restarts the bridge, never the daemon).
        const beforeId = currentProfile()?.id ?? null
        const beforeArgs = bridgeArgs.join(' ')
        registry = loadDeviceProfiles({ userDir: DEVICES_DIR })
        refreshBridgeArgs()
        const profile = currentProfile()
        if (profile) {
          // Registered model: recompute key defaults from the new registry; keyMap/hidKeys in settings.json still win.
          config = mergeConfig(savedValues())
          appliedProfileId = profile.id
          applyConfigToRuntime()
        }
        const afterId = profile ? profile.id : null
        const argsChanged = bridgeArgs.join(' ') !== beforeArgs
        const restarted = afterId !== beforeId || argsChanged
        if (restarted) {
          await serialize(() => service.restart())
        }
        log(`device models reloaded: ${registry.profiles.length} profiles, current=${afterId || 'unregistered'}${afterId !== beforeId ? ' (model switched)' : ''}${argsChanged ? ', bridge arguments updated' : ''}`)
        return json(res, 200, {
          ok: true,
          profileId: afterId,
          profiles: describeRegistry(registry, afterId),
          bridgeArgs: [...bridgeArgs],
          restarted
        })
      }

      case 'GET /events': {
        const raw = url.searchParams.get('since')
        // bootAt lets the client notice "the daemon restarted": seq goes back to 1 while the client's
        // cursor still holds the old process's large number, so since=37 > head would return no events at
        // all (observed symptom: key events reach the event stream and Hermes does nothing).
        const boot = { pid: process.pid, bootAt: startedAt }
        if (raw === null || raw === 'head') return json(res, 200, { ...boot, cursor: seq, head: seq, events: [] })
        const since = Number(raw)
        const from = Number.isFinite(since) ? since : 0
        const slice = events.filter(event => event.seq > from)
        return json(res, 200, { ...boot, cursor: seq, head: seq, events: slice })
      }

      case 'POST /consume': {
        const entry = service.consume() ?? fallbackPending
        fallbackPending = null
        return json(res, 200, { transcript: entry })
      }

      case 'POST /selftest': {
        // Exercise the recogniser without the remote. Default source is the
        // bundled Chinese sample: a self-test must be deterministic, and the
        // last live utterance may be a cough, a door slam or a 700ms fragment —
        // transcribing that and reporting "recognised OK (empty)" tests nothing and, worse,
        // reads as a broken model. `{"file":"last"}` opts into the last real
        // utterance; `{"file":"/path.wav"}` takes an explicit file. Whenever the
        // chosen source comes back empty we retry the sample once, so an empty
        // result always means "the recogniser is unhappy", never "the audio was junk".
        const body = await readBody(req)
        const samplePath = join(ROOT, 'assets', 'sample-zh.wav')
        const requested = body?.file ? String(body.file) : ''
        const source = !requested ? samplePath : requested === 'last' ? LAST_WAV : resolvePath(requested)
        if (!existsSync(source)) return json(res, 404, { error: `no test audio available: ${source}` })
        const transcribe = transcriberFor(config)
        const startedAtMs = Date.now()
        const runOnce = async (file: string): Promise<SelftestTranscript> => {
          const result = await transcribe(new Uint8Array(readFileSync(file)), undefined, { record: false })
          return {
            text: String(result.text || '').trim(),
            at: Date.now(),
            audioSeconds: result.audioSeconds ?? 0,
            inferenceSeconds: result.inferenceSeconds ?? (Date.now() - startedAtMs) / 1000,
            durationMs: Math.round((result.audioSeconds ?? 0) * 1000),
            selftest: true,
            source: file
          }
        }
        let entry = await runOnce(source)
        let fellBack = false
        if (!entry.text && source !== samplePath && existsSync(samplePath)) {
          entry = await runOnce(samplePath)
          fellBack = true
        }
        entry.fellBack = fellBack
        if (entry.text) {
          fallbackPending = entry
          pushEvent('transcript', entry)
        }
        return json(res, 200, { transcript: entry, source: entry.source, fellBack })
      }

      case 'POST /mock/transcript': {
        // Verify "transcript → input box" without a remote: fabricate an event shaped exactly like a real transcript.
        const body = await readBody(req)
        const text = String(body?.text || '').trim()
        if (!text) throw new Error('missing text')
        const entry: PendingTranscript = { text, at: Date.now(), audioSeconds: 0, inferenceSeconds: 0, durationMs: 0, mock: true }
        fallbackPending = entry
        pushEvent('transcript', entry)
        log(`[mock] ${text.slice(0, 120)}`)
        return json(res, 200, { transcript: entry })
      }

      case 'POST /open/settings': {
        // Jump straight to the system privacy pane: without TCC Bluetooth permission the bridge stays unknown forever and the user has no idea where to click.
        const body = await readBody(req)
        const pane = String(body?.pane || 'bluetooth')
        const targets: Record<string, string> = {
          bluetooth: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Bluetooth',
          microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
        }
        const target = targets[pane]
        if (!target) throw new Error(`unknown pane: ${pane}`)
        const child = spawn('open', [target], { stdio: 'ignore', detached: true })
        child.unref()
        log(`opened system settings pane: ${pane}`)
        return json(res, 200, { ok: true, pane })
      }

      case 'POST /restart':
        bridgeStateSeen = false
        userStopped = false
        await serialize(() => service.restart())
        armAuthWatch()
        return json(res, 200, { ok: true, state: service.state })

      case 'POST /start':
        userStopped = false
        await serialize(() => service.start())
        return json(res, 200, { ok: true, state: service.state })

      case 'POST /stop':
        userStopped = true
        log(`[http] /stop (${req.headers['user-agent'] || 'unknown'})`)
        await service.stop()
        return json(res, 200, { ok: true, state: service.state })

      case 'POST /capture': {
        // "Window" mode for a full-chain self-test: send one ATVV mic-open request (0C 00), then wait for the
        // first transcript inside the window. Measured: the device only streams while the voice key is physically
        // pressed, so a human must press it; the upside is no input box involved — only link→decode→recognise→event.
        const body = await readBody(req).catch((): Record<string, unknown> => ({}))
        const waitMs = Math.max(1500, Math.min(30_000, Number(body?.waitMs) || 12_000))
        if (service.state !== 'ready' && service.state !== 'capturing') {
          userStopped = false
          await serialize(() => service.start())
          const deadlineStart = Date.now()
          // service.state is a getter and can change any millisecond; the cast undoes TS's premature narrowing from the if above.
          while ((service.state as RemoteMicState) !== 'ready' && Date.now() - deadlineStart < 8000) {
            await new Promise(done => setTimeout(done, 150))
          }
        }
        if (service.state !== 'ready') {
          return json(res, 503, { error: `link not ready: ${service.state}`, detail: lastDetail })
        }
        const before = seq
        service.openMicrophone()
        // The device only streams while its own voice key is held: the mic-open command sent here is a courtesy
        // request, the real trigger is still a human press. Hence a "timed window" self-test.
        log(`[capture] waiting for speech (press the remote's voice key within ${Math.round(waitMs / 1000)}s)`)
        const deadline = Date.now() + waitMs
        while (Date.now() < deadline) {
          const hit = events.find(event => event.seq > before && event.type === 'transcript')
          if (hit) return json(res, 200, { ok: true, transcript: hit.payload, state: service.state })
          await new Promise(done => setTimeout(done, 120))
        }
        return json(res, 504, {
          error: `timed out waiting for a transcript (${waitMs}ms)`,
          state: service.state,
          diagnostics: service.diagnostics
        })
      }

      case 'POST /key': {
        const body = await readBody(req)
        if (typeof body.code !== 'string' || !body.code) throw new Error('missing code')
        pushEvent('key', { code: body.code, down: body.down !== false, source: 'manual' })
        return json(res, 200, { ok: true })
      }

      case 'GET /config':
        return json(res, 200, { config: editable(config) })

      case 'POST /config': {
        const body = await readBody(req)
        if (body.reset === true) return json(res, 200, { config: resetConfig() })
        const patch = body.patch ?? body
        return json(res, 200, { config: applyPatch(patch) })
      }

      case 'GET /history':
        return json(res, 200, { entries: readHistory(Number(url.searchParams.get('limit') || 50)) })

      case 'DELETE /history':
        if (existsSync(HISTORY_FILE)) writeFileSync(HISTORY_FILE, '', { mode: 0o600 })
        return json(res, 200, { ok: true })

      case 'GET /audio/last': {
        if (!existsSync(LAST_WAV)) return json(res, 404, { error: 'no recording yet' })
        const bytes = readFileSync(LAST_WAV)
        res.writeHead(200, {
          'content-type': 'audio/wav',
          'content-length': bytes.length,
          'cache-control': 'no-store'
        })
        return res.end(bytes)
      }

      case 'GET /logs':
        return json(res, 200, { logs: logs.slice(-Number(url.searchParams.get('lines') || 80)) })

      case 'GET /stt':
        return json(res, 200, sttReport())

      case 'GET /stt/install':
        return json(res, 200, { job: installJob })

      case 'POST /stt/install': {
        const body = await readBody(req)
        const what = String(body?.what || 'all') as InstallWhat
        if (what !== 'models' && what !== 'sherpa' && what !== 'all') {
          throw new Error(`unknown install target: ${what} (expected "models", "sherpa" or "all")`)
        }
        if (installJob && installJob.state === 'running') {
          return json(res, 409, { error: 'an install job is already running', job: installJob })
        }
        const script = join(ROOT, '..', 'scripts', 'fetch-models.mjs')
        if (!existsSync(script)) {
          return json(res, 500, { error: `install script missing: ${script} (rebuild with node dev/build.mjs)` })
        }
        const args = [
          // engine flags: --with-sherpa for 'all', --sherpa-only for the engine alone, none for models.
          ...(what === 'all' ? ['--with-sherpa'] : what === 'sherpa' ? ['--sherpa-only'] : []),
          '--dir', join(STATE_DIR, 'models'),
          '--sherpa-dir', join(STATE_DIR, 'sherpa'),
          ...(body?.fp32 === true ? ['--fp32'] : [])
        ]
        return json(res, 202, { job: startInstall(what, script, args) })
      }

      default:
        return json(res, 404, { error: `no route ${req.method} ${url.pathname}` })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`[http] ${req.method} ${url.pathname} failed: ${message}`)
    return json(res, 400, { error: message })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  log(`baton daemon listening on 127.0.0.1:${PORT} (state=${STATE_DIR} bridge=${BRIDGE_PATH})`)
  process.stdout.write(`${JSON.stringify({ port: PORT, pid: process.pid, stateDir: STATE_DIR })}\n`)
  // A bridge left over from a previous life (daemon SIGKILLed, or pid reuse) keeps holding the remote's
  // ATVV connection, so the new link is "ready but receives no audio". Clean up only our own binary.
  try {
    execFileSync('pkill', ['-f', `^${BRIDGE_PATH}`], { stdio: 'ignore' })
    log('cleaned up leftover atvv-link process')
  } catch {
    /* no leftovers is the common case (pkill exit code 1) */
  }
  startSupervisor()
  // Device list: scan after the bridge connects, so two CoreBluetooth activities do not collide.
  // Every 5 minutes is plenty — remotes are not hot-plugged that often; the scan only keeps the UI from going blank.
  setTimeout(() => {
    void refreshDevices(3).catch(error => log(`device scan failed: ${error instanceof Error ? error.message : String(error)}`))
  }, 6000)
  const deviceTimer = setInterval(() => {
    void refreshDevices(3).catch(() => undefined)
  }, 5 * 60 * 1000)
  if (typeof deviceTimer.unref === 'function') deviceTimer.unref()
  if (config.autoStart) {
    void serialize(() => service.start()).catch(error => log(`start failed: ${error instanceof Error ? error.message : String(error)}`))
  } else {
    log('autoStart=false: waiting for /start')
  }
})

server.on('error', error => {
  log(`listen failed: ${error.message}`)
  process.stderr.write(`listen ${PORT} failed: ${error.message}\n`)
  process.exit(3)
})

/* ────────────────────────── lifecycle ────────────────────────── */

let shuttingDown = false
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log(`exit: ${reason}`)
  await service.stop().catch(() => undefined)
  server.close()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('uncaughtException', error => log(`uncaught exception: ${error?.stack ?? error}`))
// unhandledRejection's reason is {} | null | undefined in @types/node; the cast only
// narrows the type — at runtime it is still "stack if present, otherwise the value as-is", as in the original JS.
process.on('unhandledRejection', error => log(`unhandled promise rejection: ${(error as { stack?: string } | null | undefined)?.stack ?? error}`))

if (PARENT_PID > 0) {
  const timer = setInterval(() => {
    try {
      process.kill(PARENT_PID, 0)
    } catch {
      void shutdown(`parent process ${PARENT_PID} has exited`)
    }
  }, 5000)
  timer.unref?.()
}
