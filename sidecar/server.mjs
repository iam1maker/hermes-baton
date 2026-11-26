#!/usr/bin/env node
/**
 * baton daemon — the process half of the Hermes「指挥」plugin.
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

import { createServer } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'

import { SidecarTransport } from './vendor/ble/sidecar.js'
import { RemoteMicService, hidUsageToCode } from './vendor/plugin/service.js'
import { createSenseVoiceTranscriber } from './stt/sensevoice.mjs'
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

// 以下是「没有型号 profile 匹配」时的回退常量；有 profile 时按键默认改由
// profile.defaultKeyMap / profile.hidKeys 按当前型号派生（见 mergeConfig）。
// 两层 merge：型号默认 ← 用户 settings.json（用户配置永远压过型号默认）。
export const DEFAULT_KEY_MAP = {
  Enter: { single: 'submit' },
  ContextMenu: { single: 'stop' },
  Home: { single: 'new-session' },
  Backquote: { single: 'swallow' },
  F5: { single: 'swallow' },
  Back: { single: 'stop' },
  // Chromecast 的输入源键：系统不认这个 HID usage，按下去 macOS 什么都不做，
  // 所以它是整台遥控器上唯一干净的「第二功能键」。单击开新会话。
  InputSource: { single: 'new-session' }
}

/** Keys the DOM never delivers — the only ones the native HID reader forwards. */
export const DEFAULT_HID_KEYS = [
  // 小米蓝牙语音遥控器：Back、音量走 page 0x07
  'Back',
  'AudioVolumeUp',
  'AudioVolumeDown',
  'AudioVolumeMute',
  // Chromecast with Google TV 遥控器：主集合是 page 0x0C（Consumer Control），
  // 有独立的确认键与方向键（小米那边中键就是语音键，不会产生这些 code）。
  'Enter',
  'Home',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  // 专用键：默认只做「识别可得」，不预置任何动作——Power 会被 macOS 直接
  // 消费（按下去就锁屏/睡眠），媒体键会被系统当媒体键处理，绑 Hermes 动作
  // 只会让「想用遥控器」变成「把电脑锁了」。
  'Power',
  'InputSource',
  'Netflix',
  'YouTube'
]

const DEFAULTS = {
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
  // 按键归属：'active' = 只有当前生效那台管事（默认）；'any' = 两台都认。
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

function argsFrom(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--port') out.port = Number(argv[++i])
    else if (token === '--state-dir') out.stateDir = argv[++i]
    else if (token === '--parent-pid') out.parentPid = Number(argv[++i])
  }
  return out
}

const argv = argsFrom(process.argv.slice(2))
const envAny = (key) => process.env[`BATON_${key}`] || process.env[`REMOTE_MIC_${key}`]
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

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
}

/** 32-hex bearer token; the Python backend reads the same file. */
function ensureToken() {
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
function seedFromDsh() {
  if (!existsSync(SETTINGS_FILE) && existsSync(DSH_SETTINGS)) {
    const seeded = readJson(DSH_SETTINGS, null)
    if (seeded && typeof seeded.values === 'object' && seeded.values !== null) {
      writeJsonAtomic(SETTINGS_FILE, { version: 1, values: seeded.values, seededFrom: DSH_SETTINGS })
      log(`已从 DSH 迁移设置 ${DSH_SETTINGS}`)
    }
  }
  if (!existsSync(DEVICE_FILE) && existsSync(DSH_DEVICE)) {
    const device = readJson(DSH_DEVICE, null)
    if (device && typeof device.id === 'string' && device.id) {
      writeJsonAtomic(DEVICE_FILE, device)
      log(`已从 DSH 迁移上次设备 ${device.name ?? device.id}`)
    }
  }
}

function savedValues() {
  const parsed = readJson(SETTINGS_FILE, {})
  const values = parsed && typeof parsed.values === 'object' && parsed.values !== null ? parsed.values : {}
  return values
}

function mergeConfig(values) {
  // 按键默认按「当前型号」派生：profile.defaultKeyMap / profile.hidKeys。
  // 两层 merge —— 型号默认 ← 用户 settings.json（用户显式配置压过型号默认）。
  // 未登记/没有型号匹配时退回 DEFAULT_KEY_MAP / DEFAULT_HID_KEYS 常量。
  const wantedName = (device && device.name) || (typeof values.deviceName === 'string' ? values.deviceName : '')
  const profile = wantedName ? profileForDeviceName(registry, wantedName) : null
  const baseKeyMap = profile ? profile.defaultKeyMap : DEFAULT_KEY_MAP
  const baseHidKeys = profile && profile.hidKeys.length > 0 ? [...profile.hidKeys] : [...DEFAULT_HID_KEYS]

  const config = { ...DEFAULTS, ...values }
  config.keyMap = { ...normalizeKeyMap(baseKeyMap), ...normalizeKeyMap(values.keyMap) }
  config.phrases = normalizePhrases(config.phrases)
  config.hidKeys = Array.isArray(values.hidKeys)
    ? values.hidKeys.filter(code => typeof code === 'string' && code.trim()).map(code => code.trim())
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

function normalizePhrases(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [name, text] of Object.entries(raw)) {
    const key = String(name).trim().slice(0, 40)
    const value = String(text ?? '').slice(0, 500)
    if (key && value) out[key] = value
    if (Object.keys(out).length >= 50) break
  }
  return out
}

function normalizeSlot(slot) {
  if (slot === undefined || slot === null) return undefined
  if (typeof slot === 'string') {
    if (KEY_ACTIONS.has(slot)) return slot
    if (slot.startsWith('phrase:')) return { action: 'phrase', name: slot.slice(7) }
    return undefined
  }
  if (typeof slot === 'object' && !Array.isArray(slot)) {
    if (slot.action === 'phrase' && typeof slot.name === 'string' && slot.name.trim()) {
      return { action: 'phrase', name: slot.name.trim() }
    }
    if (typeof slot.action === 'string' && KEY_ACTIONS.has(slot.action)) return slot.action
  }
  return undefined
}

function normalizeKeyMap(raw) {
  // 只做归一化，不做默认值兜底——keyMap 的默认层在 mergeConfig 里按型号派生。
  const out = {}
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  for (const [code, binding] of Object.entries(source)) {
    if (typeof code !== 'string' || !code.trim()) continue
    if (typeof binding === 'string') {
      const single = normalizeSlot(binding)
      if (single) out[code] = { single }
      continue
    }
    if (!binding || typeof binding !== 'object') continue
    const entry = {}
    for (const slot of ['single', 'double', 'long']) {
      const value = normalizeSlot(binding[slot])
      if (value !== undefined) entry[slot] = value
    }
    if (Object.keys(entry).length > 0) out[code] = entry
  }
  return out
}

/** Reject a patch that names a phrase which does not exist (silent typos are worse). */
function validatePhraseRefs(keyMap, phrases) {
  for (const [code, binding] of Object.entries(keyMap)) {
    for (const slot of ['single', 'double', 'long']) {
      const value = binding?.[slot]
      if (value && typeof value === 'object' && value.action === 'phrase' && !(value.name in phrases)) {
        throw new Error(`按键 ${code} 的 ${slot} 引用了不存在的常用语「${value.name}」`)
      }
    }
  }
}

/* ────────────────────────── logging ────────────────────────── */

const logs = []
function log(message) {
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

const events = []
let seq = 0
/** Backup copy of the last transcript, so `/consume` still answers after a UI reload. */
let fallbackPending = null
function pushEvent(type, payload) {
  seq += 1
  events.push({ seq, type, at: Date.now(), payload })
  if (events.length > 400) events.splice(0, events.length - 400)
}

/* ────────────────────────── transcriber ────────────────────────── */

let lastDetail = null

function openAiTranscriber(config) {
  const baseUrl = config.sttBaseUrl.replace(/\/+$/, '')
  const url = baseUrl.includes('/audio/transcriptions') ? baseUrl : `${baseUrl}/audio/transcriptions`
  return async (wav, signal) => {
    const form = new FormData()
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav')
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
      throw new Error(`识别服务 ${response.status}: ${detail || response.statusText}`)
    }
    const payload = await response.json()
    if (typeof payload?.text !== 'string') throw new Error('识别服务没有返回 text')
    return { text: payload.text }
  }
}

/** Which recogniser `/state` reports and the service actually uses. */
function transcriberKind(config) {
  if (config.sttBaseUrl) return 'openai'
  return local.paths.ok ? 'sensevoice' : 'missing'
}

function transcriberFor(config) {
  if (config.sttBaseUrl) return openAiTranscriber(config)
  if (!local.paths.ok) {
    return async () => {
      throw new Error(
        `未配置语音识别：本地 SenseVoice 模型缺失（${local.paths.problems.join('；')}），也没有填识别服务地址`
      )
    }
  }
  // record:false 用于自检——自检不该把"上一句真实录音"覆盖成测试音频。
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

/* ── 设备型号注册表 ──────────────────────────────────────────────────
 * 一个型号 = 一个 JSON（内置 sidecar/devices/*.json，用户自己的型号放
 * <STATE_DIR>/devices/，同名 id 覆盖内置）。新增遥控器型号 = 丢一个 JSON +
 * POST /devices/reload，不改代码、不重启守护进程。
 */
const DEVICES_DIR = join(STATE_DIR, 'devices')
let registry = loadDeviceProfiles({ userDir: DEVICES_DIR })

seedFromDsh()
const cachedDevice = readJson(DEVICE_FILE, null)

/** 桥真实连上的那台（启动时用缓存垫底）；rememberDevice 随桥的上报更新。 */
let device = cachedDevice && typeof cachedDevice.id === 'string' ? { id: cachedDevice.id, name: cachedDevice.name ?? '' } : null

let config = mergeConfig(savedValues())

/**
 * 当前型号：优先桥上报的设备名（它才是「谁在连」的真相），桥还没上报时看配置里的
 * 目标名。名字匹配不到任何 profile → null：未登记的型号照样能用，只是没有型号默认键。
 */
function currentProfile() {
  const name = (device && device.name) || config.deviceName || ''
  return name ? profileForDeviceName(registry, name) : null
}

/** 按键查表：型号注册表优先，内置 hidUsageToCode 兜底（保持旧型号/未登记键的旧行为）。 */
function resolveCode(page, usage) {
  return codeFor(registry, page, usage) || hidUsageToCode(page, usage)
}

/** 当前 keyMap/hidKeys 是按哪个型号派生的；型号切换时重算（syncProfileDefaults）。 */
let appliedProfileId = currentProfile()?.id ?? null

/** 未登记型号只提示一次，不做任何过滤、不重置 keyMap。 */
const unknownProfilesNoted = new Set()
noteUnknownProfile((device && device.name) || '')

const buildLocal = () =>
  createSenseVoiceTranscriber({
    modelDir: config.modelDir || null,
    vadModel: config.vadModel || null,
    modelFile: config.modelFile || null,
    precision: config.precision,
    log
  })

let local = buildLocal()

/**
 * 桥的启动参数必须**原地**重算（push/splice，不能换数组）。
 * SidecarTransport 在构造时就持有这个数组的引用，换一个新数组它读不到——
 * 实测症状：切设备后桥确实重启了，却依旧连回上一台。
 */
const bridgeArgs = ['--hid']
function refreshBridgeArgs() {
  const wantedId = config.deviceId || (cachedDevice && typeof cachedDevice.id === 'string' ? cachedDevice.id : '')
  bridgeArgs.length = 0
  bridgeArgs.push('--hid')
  // HID 旁听白名单来自型号注册表：每个 pair 一个 --hid-device，pages 是所有型号
  // 声明的并集。新增遥控器型号只要丢一个 JSON，这里自动带上，不用改代码。
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

/** 未登记型号的提示：只记一次日志，不做任何过滤、不重置 keyMap（未知遥控器照常工作）。 */
function noteUnknownProfile(name) {
  if (!name || currentProfile() || unknownProfilesNoted.has(name)) return
  unknownProfilesNoted.add(name)
  log(`未登记的型号 device=${name}，把它加进 ${DEVICES_DIR}/xxx.json`)
}

/**
 * 当前型号切换 → keyMap/hidKeys 按新型号重算（settings.json 里的显式配置仍压过型号默认）。
 * 未登记型号时不动 keyMap：没有可用的型号默认，保持现状最安全。
 */
function syncProfileDefaults() {
  const profile = currentProfile()
  if (!profile || profile.id === appliedProfileId) return
  appliedProfileId = profile.id
  config = mergeConfig(savedValues())
  applyConfigToRuntime()
  log(`按键默认已按型号「${profile.label}」（${profile.id}）派生，settings.json 里的配置仍优先`)
}

function rememberDevice(next) {
  if (!next?.id) return
  device = { id: next.id, name: next.name || device?.name || '' }
  try {
    writeJsonAtomic(DEVICE_FILE, { id: device.id, name: device.name, at: Date.now() })
  } catch (error) {
    log(`写入设备缓存失败: ${error instanceof Error ? error.message : String(error)}`)
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
  // 'active' 模式下用来判断谁是「当前那台」：优先桥真实连上的设备名
  // （device 由桥的 device 事件更新），桥还没 ready 时退回配置里的目标名。
  targetDeviceName: () => (device && device.name) || config.deviceName || '',
  // 动态读配置，改 keyFilter 不需要重启（applyPatch 直接生效）。
  keyFilter: () => config.keyFilter || 'active',
  // 按键查表：型号注册表优先、内置表兜底（POST /devices/reload 换注册表后立即生效）。
  resolveCode,
  transcribe: transcriberFor(config),
  preflight: () => {
    if (!existsSync(BRIDGE_PATH)) {
      return `找不到蓝牙桥 ${BRIDGE_PATH}（重新安装插件即可修好）`
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
  log(`[stt] 失败: ${message}`)
  pushEvent('error', { message })
})
service.on('notice', notice => {
  log(`[stt] ${notice.message}`)
  pushEvent('notice', notice)
})

/* ── 蓝牙授权看门狗 ──────────────────────────────────────────────────────
 * CoreBluetooth 的 delegate 在 TCC 未授权时永远不会回调：桥进程活着、日志停在
 * "atvv-link started"、服务卡在 starting。这个状态在界面上和"遥控器在睡觉"长得
 * 一模一样，但修法完全不同，所以这里主动区分，并把结论写进 /state.detail 与错误事件。
 * 判定依据：桥上线后 8 秒内一个 state 事件都没收到（授权正常时它开机即发）。
 */
let bridgeStateSeen = false
let clockState = null
transport.on('state', ({ state }) => {
  bridgeStateSeen = true
  clockState = state
  log(`[bridge] 蓝牙状态 ${state}`)
})

const BLUETOOTH_AUTH_HINT =
  '蓝牙未就绪：macOS 没有给本进程蓝牙权限（系统设置 ▸ 隐私与安全性 ▸ 蓝牙，勾选 Hermes / osascript 后重启 Hermes），或系统蓝牙被关闭'

function armAuthWatch() {
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

function appendHistory(entry) {
  try {
    const line = JSON.stringify({ text: entry.text, at: entry.at, audioSeconds: entry.audioSeconds }) + '\n'
    const existing = existsSync(HISTORY_FILE) ? readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean) : []
    existing.push(line.trim())
    const kept = existing.slice(-config.historyLimit)
    writeFileSync(HISTORY_FILE, `${kept.join('\n')}\n`, { mode: 0o600 })
  } catch (error) {
    log(`写入历史失败: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function readHistory(limit = 50) {
  if (!existsSync(HISTORY_FILE)) return []
  const rows = readFileSync(HISTORY_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  return rows.slice(-Math.max(1, Math.min(500, limit))).reverse()
}

/* ────────────────────────── state ────────────────────────── */

/**
 * 最近一次扫描到的候选遥控器。
 * 放进 /state 而不是只靠 /devices，是因为网关里已挂载的 router 不会热重扫：
 * 新加的路由在应用重启前一直 404，而 /state 早就挂着了。自动扫描 + 缓存让
 * 「切换遥控器」在旧网关上也能用。
 */
let knownDevices = []
let knownDevicesAt = 0

function snapshot() {
  const profile = currentProfile()
  // 只暴露「当前型号真的会发」的键：settings.json 里可能留着上一台遥控器的
  // 默认（如小米模式下残留 Enter/InputSource）。页面按这份视图渲染就不会
  // 出现「当前是小米却列出 Chromecast 键」。全量仍保留在 keys.stored 里备查。
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

function readHistoryCount() {
  if (!existsSync(HISTORY_FILE)) return 0
  try {
    return readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

function editable(current) {
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

function applyPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('patch 必须是对象')
  const unknown = Object.keys(patch).filter(key => !EDITABLE_KEYS.has(key))
  if (unknown.length > 0) throw new Error(`未知配置项: ${unknown.join(', ')}`)
  const normalized = mergeConfig({ ...savedValues(), ...pickSaved(patch) })
  validatePhraseRefs(normalized.keyMap, normalized.phrases)

  // Persist only what differs from the defaults so a future default change lands.
  const saved = { ...savedValues() }
  for (const [key, value] of Object.entries(pickSaved(patch))) {
    if (JSON.stringify(value) === JSON.stringify(DEFAULTS[key])) delete saved[key]
    else saved[key] = value
  }
  writeJsonAtomic(SETTINGS_FILE, { version: 1, values: saved })
  const previousDevice = `${config.deviceId}\u0000${config.deviceName}`
  config = normalized
  if (['modelDir', 'vadModel', 'modelFile', 'precision'].some(key => key in patch)) {
    local.dispose()
    local = buildLocal()
    log(`识别模型已切换: ${local.paths.model || '（缺失）'} · ${local.paths.precision || '?'}`)
  }
  applyConfigToRuntime()
  // A different remote means the bridge has to be re-spawned with new filters.
  if (`${config.deviceId}\u0000${config.deviceName}` !== previousDevice) {
    refreshBridgeArgs()
    log(`桥参数已更新: ${bridgeArgs.join(' ')}`)
    // 旧设备的缓存会盖住「谁在连」的判断，切换时先指向新目标，等桥自己上报覆盖。
    device = config.deviceId ? { id: config.deviceId, name: config.deviceName || '' } : device
    void service.restart().catch(error => log(`按新设备重启失败: ${error instanceof Error ? error.message : String(error)}`))
  }
  log(`设置已更新: ${Object.keys(patch).join(', ') || '空补丁'}`)
  return editable(config)
}

/** The stored form of a patch: human aliases resolved, secrets kept verbatim. */
function pickSaved(patch) {
  const out = {}
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'sttApiKey' && value === '••••••') continue
    if (key === 'keyMap') out.keyMap = normalizeKeyMap(value)
    else if (key === 'phrases') out.phrases = normalizePhrases(value)
    else out[key] = value
  }
  return out
}

function applyConfigToRuntime() {
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
  log('设置已恢复默认')
  return editable(config)
}

/* ────────────────────────── http ────────────────────────── */

/**
 * 列出候选遥控器：桥的 --list 模式只扫描、不建长连接，4 秒足够覆盖
 * 「系统已连接」那一批（retrieveConnectedPeripherals 是即时的）。
 * 注意 child.stdin 必须保持打开——桥把 stdin EOF 当作退出信号。
 */
function listDevices(seconds = 4) {
  return new Promise(resolve => {
    const found = []
    const seen = new Set()
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
      resolve(found)
    }
    const child = spawn(BRIDGE_PATH, ['--list', String(seconds)], { stdio: ['pipe', 'pipe', 'pipe'] })
    const timer = setTimeout(finish, (seconds + 6) * 1000)
    let buffer = ''
    child.stdout.on('data', chunk => {
      buffer += chunk.toString()
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (!line.trim()) continue
        let event
        try { event = JSON.parse(line) } catch { continue }
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
 * 扫描一次并把结果写进缓存（/state 会带出去）。扫描失败不清空旧结果：
 * 显示上一次看到的设备，比显示空列表更有用。
 */
let scanningDevices = false
async function refreshDevices(seconds = 3) {
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

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  })
  res.end(body)
}

function authorized(req, url) {
  const header = req.headers.authorization || ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  const query = url.searchParams.get('token') || ''
  return bearer === TOKEN || query === TOKEN
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new Error(`JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
    req.on('error', reject)
  })
}

/* ── 竞争桥检测 ─────────────────────────────────────────────────────────
 * DSH 的 remote-mic（或另一个 Hermes profile）也会跑一份 atvv-link，抢同一台遥控器的
 * ATVV 连接：表现是连上就掉（link lost）、或者收到的音频断断续续。这里直接看进程表，
 * 把"另一个桥在跑"写进 /state.competitors，页面据此提示关掉另一份。
 */
let competitorCache = { at: 0, list: [] }
function findCompetingBridges() {
  if (Date.now() - competitorCache.at < 20_000) return competitorCache.list
  let list = []
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
      // 只看 argv[0] 真的是 atvv-link 的进程：命令行里带上这个字符串的（比如我们自己
      // 的 pgrep/grep 命令）不算竞争。
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

/* ── 守护：服务不该"自己"停在 stopped ────────────────────────────────────
 * 只有用户显式点「停止监听」（/stop）才允许长期 stopped；其他路径掉到 stopped
 * （历史事件、别的进程调用、UI 误触）都会让整条链路静默失效，第二天看起来像"插件坏了"。
 */
let userStopped = false
let supervisorTimer = null
// 所有 start/restart 串行化：listen 回调的 autoStart、runtime 的 POST /start、supervisor
// 三方同时到达时，transport 会各自 spawn 一份桥，两份桥抢同一台遥控器的连接。
let lifecycleGate = Promise.resolve()
function serialize(fn) {
  const next = lifecycleGate.then(fn, fn)
  lifecycleGate = next.then(() => undefined, () => undefined)
  return next
}
function startSupervisor() {
  if (supervisorTimer !== null) return
  supervisorTimer = setInterval(() => {
    if (!config.autoStart || userStopped) return
    if (service.state !== 'stopped') return
    log('[supervisor] 服务处于 stopped（非用户主动停止），自动重新连接')
    void serialize(() => service.start()).catch(error => log(`[supervisor] 重启失败: ${error instanceof Error ? error.message : String(error)}`))
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
        // 有第二台遥控器（Chromecast / Google TV 等）以后，界面需要知道
        // 「系统里还有哪些 ATVV 设备」，再让用户切换。扫描是只读的，不影响当前链路。
        const seconds = Math.max(2, Math.min(10, Number(url.searchParams.get('seconds') || 4)) || 4)
        const devices = await refreshDevices(seconds)
        return json(res, 200, { devices, current: device, at: knownDevicesAt || Date.now() })
      }

      case 'POST /devices/reload': {
        // 热插拔型号：重读内置 + 用户型号目录。注册表换新、桥参数原地刷新；
        // 当前型号或桥参数变了才重启链路（service.restart 只重启桥，不动守护进程）。
        const beforeId = currentProfile()?.id ?? null
        const beforeArgs = bridgeArgs.join(' ')
        registry = loadDeviceProfiles({ userDir: DEVICES_DIR })
        refreshBridgeArgs()
        const profile = currentProfile()
        if (profile) {
          // 已登记型号：按键默认按新注册表重算；settings.json 里的 keyMap/hidKeys 仍压过型号默认。
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
        log(`设备型号已重载：${registry.profiles.length} 个型号，当前=${afterId || '未登记'}${afterId !== beforeId ? '（型号已切换）' : ''}${argsChanged ? '，桥参数已更新' : ''}`)
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
        // bootAt 让客户端能识别「守护进程重启过」：seq 会回到 1，而客户端的
        // cursor 还停在旧进程的大数字上，此时 since=37 > head 会一条事件都收不到
        // （实测表现：按键事件到达事件流，Hermes 里毫无反应）。
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
        // transcribing that and reporting "识别成功（空）" tests nothing and, worse,
        // reads as a broken model. `{"file":"last"}` opts into the last real
        // utterance; `{"file":"/path.wav"}` takes an explicit file. Whenever the
        // chosen source comes back empty we retry the sample once, so an empty
        // result always means "the recogniser is unhappy", never "the audio was junk".
        const body = await readBody(req)
        const samplePath = join(ROOT, 'assets', 'sample-zh.wav')
        const requested = body?.file ? String(body.file) : ''
        const source = !requested ? samplePath : requested === 'last' ? LAST_WAV : resolvePath(requested)
        if (!existsSync(source)) return json(res, 404, { error: `没有可用的测试音频：${source}` })
        const transcribe = transcriberFor(config)
        const startedAtMs = Date.now()
        const runOnce = async file => {
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
        // 没有遥控器也能验证「转写 → 输入框」这一段：造一条与真实转写同形的事件。
        const body = await readBody(req)
        const text = String(body?.text || '').trim()
        if (!text) throw new Error('缺少 text')
        const entry = { text, at: Date.now(), audioSeconds: 0, inferenceSeconds: 0, durationMs: 0, mock: true }
        fallbackPending = entry
        pushEvent('transcript', entry)
        log(`[mock] ${text.slice(0, 120)}`)
        return json(res, 200, { transcript: entry })
      }

      case 'POST /open/settings': {
        // 一步跳到系统隐私面板：TCC 没给蓝牙权限时桥永远停在 unknown，用户不知道该点哪里。
        const body = await readBody(req)
        const pane = String(body?.pane || 'bluetooth')
        const targets = {
          bluetooth: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Bluetooth',
          microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
        }
        const target = targets[pane]
        if (!target) throw new Error(`未知面板: ${pane}`)
        const child = spawn('open', [target], { stdio: 'ignore', detached: true })
        child.unref()
        log(`已打开系统设置面板：${pane}`)
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
        log(`[http] /stop（${req.headers['user-agent'] || 'unknown'}）`)
        await service.stop()
        return json(res, 200, { ok: true, state: service.state })

      case 'POST /capture': {
        // 全链路自检的"窗口"模式：发一次 ATVV 开麦请求（0C 00），然后等 window 内出现的
        // 第一条 transcript。实测设备只在物理按下语音键时才推流，所以这里必须有人按键；
        // 好处是不用碰输入框，只验证 链路→解码→识别→事件。
        const body = await readBody(req).catch(() => ({}))
        const waitMs = Math.max(1500, Math.min(30_000, Number(body?.waitMs) || 12_000))
        if (service.state !== 'ready' && service.state !== 'capturing') {
          userStopped = false
          await serialize(() => service.start())
          const deadlineStart = Date.now()
          while (service.state !== 'ready' && Date.now() - deadlineStart < 8000) {
            await new Promise(done => setTimeout(done, 150))
          }
        }
        if (service.state !== 'ready') {
          return json(res, 503, { error: `链路未就绪：${service.state}`, detail: lastDetail })
        }
        const before = seq
        service.openMicrophone()
        // 设备只在它自己的语音键被按下时才推流：这里发的开麦命令只是礼貌请求，
        // 真正的触发仍然要人按一下。所以这是一个"定时窗口"式自检。
        log(`[capture] 等待语音（请在这 ${Math.round(waitMs / 1000)} 秒内按一次遥控器语音键）`)
        const deadline = Date.now() + waitMs
        while (Date.now() < deadline) {
          const hit = events.find(event => event.seq > before && event.type === 'transcript')
          if (hit) return json(res, 200, { ok: true, transcript: hit.payload, state: service.state })
          await new Promise(done => setTimeout(done, 120))
        }
        return json(res, 504, {
          error: `等待转写超时（${waitMs}ms）`,
          state: service.state,
          diagnostics: service.diagnostics
        })
      }

      case 'POST /key': {
        const body = await readBody(req)
        if (typeof body.code !== 'string' || !body.code) throw new Error('缺少 code')
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
        if (!existsSync(LAST_WAV)) return json(res, 404, { error: '还没有录音' })
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

      default:
        return json(res, 404, { error: `no route ${req.method} ${url.pathname}` })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`[http] ${req.method} ${url.pathname} 失败: ${message}`)
    return json(res, 400, { error: message })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  log(`baton daemon 监听 127.0.0.1:${PORT}（state=${STATE_DIR} bridge=${BRIDGE_PATH}）`)
  process.stdout.write(`${JSON.stringify({ port: PORT, pid: process.pid, stateDir: STATE_DIR })}\n`)
  // 上一条命留下的桥（守护进程被 SIGKILL、或 pid 复用过）会一直占着遥控器的
  // ATVV 连接，导致新链接"ready 但收不到音频"。只清我们自己的那份二进制。
  try {
    execFileSync('pkill', ['-f', `^${BRIDGE_PATH}`], { stdio: 'ignore' })
    log('已清理残留的 atvv-link 进程')
  } catch {
    /* 没有残留是最常见的情况（pkill 退出码 1） */
  }
  startSupervisor()
  // 设备列表：桥连上之后再扫，免得两条 CoreBluetooth 活动撞在一起。
  // 5 分钟一次足够——遥控器不会频繁插拔，扫描只是为了别让界面显示空白。
  setTimeout(() => {
    void refreshDevices(3).catch(error => log(`设备扫描失败: ${error instanceof Error ? error.message : String(error)}`))
  }, 6000)
  const deviceTimer = setInterval(() => {
    void refreshDevices(3).catch(() => undefined)
  }, 5 * 60 * 1000)
  if (typeof deviceTimer.unref === 'function') deviceTimer.unref()
  if (config.autoStart) {
    void serialize(() => service.start()).catch(error => log(`启动失败: ${error instanceof Error ? error.message : String(error)}`))
  } else {
    log('autoStart=false：等待 /start')
  }
})

server.on('error', error => {
  log(`监听失败: ${error.message}`)
  process.stderr.write(`listen ${PORT} failed: ${error.message}\n`)
  process.exit(3)
})

/* ────────────────────────── lifecycle ────────────────────────── */

let shuttingDown = false
async function shutdown(reason) {
  if (shuttingDown) return
  shuttingDown = true
  log(`退出: ${reason}`)
  await service.stop().catch(() => undefined)
  server.close()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('uncaughtException', error => log(`未捕获异常: ${error?.stack ?? error}`))
process.on('unhandledRejection', error => log(`未处理的 Promise: ${error?.stack ?? error}`))

if (PARENT_PID > 0) {
  const timer = setInterval(() => {
    try {
      process.kill(PARENT_PID, 0)
    } catch {
      void shutdown(`父进程 ${PARENT_PID} 已退出`)
    }
  }, 5000)
  timer.unref?.()
}
