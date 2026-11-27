/**
 * baton — desktop half of the voice-remote plugin: transcript delivery, key
 * mapping, multi-model switching.
 *
 * Division of labour:
 *   - the Bluetooth link, ATVV/ADPCM framing and local SenseVoice recognition all
 *     live in the Node daemon (plugins/baton/sidecar/server.mjs), started on
 *     demand by runtime.py on the Python side;
 *   - this file only does the two things that must happen inside the renderer:
 *       1) insert transcript text into the *current* composer — that has to go
 *          through host.composer's focus bus, because only a mounted composer can
 *          answer, and any cross-process scheme would land in another session;
 *       2) turn remote keys into actions (submit / stop / new session / canned
 *          phrase), which likewise has to run in this process.
 *
 * Two key paths, do not mix them:
 *   - bridge path: keys reported by the daemon's hid-watch (Back / ContextMenu /
 *     media keys). The DOM never sees those, so they arrive through /events
 *     polling (400ms); single/double/long is decided from the event's own `at`
 *     timestamp, so polling latency does not affect timing accuracy.
 *   - DOM path: the remote is also a HID keyboard, so Enter/Home reach the window
 *     natively. Not intercepted by default — Enter already submits, so there is
 *     nothing to add. Taking those keys over requires enabling "capture keyboard"
 *     explicitly, at the cost of the same keys on a normal keyboard.
 *
 * Constraints: only @hermes/plugin-sdk / react may be imported (esbuild adds
 * react/jsx-runtime); the source is TSX and builds into the single file
 * desktop/plugin.js; Tailwind is a fixed build-time set, so styles are inline.
 *
 * Keys are always written as `{...{ key: … }}` spreads instead of JSX key
 * attributes: the test stub's react/jsx-runtime
 * (tests/node_modules/react/jsx-runtime.js) keeps key in props so assertions can
 * walk the tree, while the real runtime still lifts key from props — both paths
 * behave like the old h() version.
 */

import { host } from '@hermes/plugin-sdk'
import type {
  ComposerInsertMode,
  HermesPlugin,
  PluginContext,
  PluginRestOptions,
  ToastKind
} from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

import { L, applyLocale, fmt, en, zh } from './i18n'

/** Named exports for the test suites; the runtime loader only reads the default export. */
export const zhMessages = zh
export const enMessages = en

/* ── REST response shapes (mirroring the sidecar/server.mjs routes; every field optional) ── */

/** Action value: a string action name, or a canned-phrase object { action:'phrase', name }. */
type ActionValue = string | { action: string; name?: string }
type TapName = 'single' | 'double' | 'long'
interface KeyBinding {
  single?: ActionValue
  double?: ActionValue
  long?: ActionValue
}
type KeyMap = Record<string, KeyBinding>

/** Editable config for POST /config and /state.config (server.mjs editable()). */
interface EditableConfig {
  gapMs?: number
  maxMs?: number
  trimMs?: number
  cutoffHz?: number
  language?: string
  autoSend?: boolean
  keysEnabled?: boolean
  autoRestart?: boolean
  autoStart?: boolean
  hideActivated?: boolean
  history?: boolean
  historyLimit?: number
  keyMap?: KeyMap
  phrases?: Record<string, string>
  hidKeys?: string[]
  sttBaseUrl?: string
  sttModel?: string
  sttApiKey?: string
  deviceId?: string
  deviceName?: string
  keyFilter?: string
  modelDir?: string
  vadModel?: string
  modelFile?: string
  precision?: string
}

interface DeviceSummary {
  id?: string
  name?: string
}

/** /state.profiles[] (server.mjs describeRegistry()). */
interface ProfileSummary {
  id?: string
  label?: string
  vendor?: string
  current?: boolean
  keys?: string[]
  hidKeys?: string[]
  defaultKeyMap?: KeyMap
  pages?: number[]
  hidPairs?: string[]
  voiceHint?: string
  notes?: string
}

/** /state.diagnostics (vendor/plugin/service.js get diagnostics()). */
interface LastUtterance {
  frames?: number
  durationMs?: number
  coverage?: number
  reason?: string
  /** Read by the page as "last transcript"; the current server never writes it (see the port report). */
  text?: string
}
interface Diagnostics {
  caps?: { version?: string; codec?: string; frameSize?: number; sampleRate?: number } | null
  frames?: number
  sessions?: number
  streaming?: boolean
  retries?: number
  lastUtterance?: LastUtterance | null
  lastError?: string | null
  battery?: number | null
}

/** /state.transcriber (server.mjs transcriber block + stt/sensevoice.mjs info). */
interface TranscriberInfo {
  kind?: string
  ready?: boolean
  loaded?: boolean
  calls?: number
  loadMs?: number | null
  model?: string | null
  precision?: string | null
  wanted?: string
  notes?: string
  problems?: string[]
  baseUrl?: string | null
  language?: string
}

interface KeysInfo {
  enabled?: boolean
  map?: KeyMap
  stored?: KeyMap
  doubleMs?: number
  longMs?: number
  hidKeys?: string[]
}

interface AudioInfo {
  gapMs?: number
  maxMs?: number
  trimMs?: number
  cutoffHz?: number
}

interface HistoryInfo {
  enabled?: boolean
  limit?: number
  count?: number
}

interface BridgeInfo {
  path?: string
  exists?: boolean
}

interface Competitor {
  pid?: number
  command?: string
}

/** Candidate devices from GET /devices and /state.devices[] (server.mjs listDevices()). */
interface CandidateDevice {
  id?: string
  name?: string
  connected?: boolean
}

/** GET /state (server.mjs snapshot()). */
interface StateSnapshot {
  now?: number
  pid?: number
  uptimeMs?: number
  state?: string
  detail?: string | null
  device?: DeviceSummary | null
  profileId?: string | null
  profiles?: ProfileSummary[]
  devicesDir?: string
  battery?: number | null
  diagnostics?: Diagnostics
  transcriber?: TranscriberInfo
  bridge?: BridgeInfo
  devices?: CandidateDevice[]
  devicesAt?: number | null
  competitors?: Competitor[]
  keys?: KeysInfo
  audio?: AudioInfo
  autoSend?: boolean
  history?: HistoryInfo
  phrases?: Record<string, string>
  config?: EditableConfig
  head?: number
  logs?: string[]
}

/** /events payload (server.mjs pushEvent(); one shape shared by every event type). */
interface EventPayload {
  text?: string
  at?: number
  audioSeconds?: number
  /** Audio duration sent with a `notice` event (e.g. too-short). */
  audioMs?: number
  inferenceSeconds?: number
  code?: string
  down?: boolean
  state?: string
  detail?: string | null
  message?: string
  kind?: string
  selftest?: boolean
  /** `stt-install` progress: job id, phase, one log line, percent, job state. */
  id?: string
  phase?: string
  line?: string
  percent?: number
}
interface DaemonEvent {
  seq?: number
  type?: string
  at?: number
  payload?: EventPayload
}

/** GET /events. */
interface EventsResponse {
  pid?: number
  bootAt?: number
  cursor?: number
  head?: number
  events?: DaemonEvent[]
}

/** /devices?seconds= response: scanned candidates + the active device. */
interface DevicesResponse {
  devices?: CandidateDevice[]
  current?: DeviceSummary | null
  at?: number
}

/** One /history row (history.jsonl: {text, at, audioSeconds}). */
interface HistoryEntry {
  text?: string
  at?: number
  audioSeconds?: number
}
interface HistoryResponse {
  entries?: HistoryEntry[]
}

interface LogsResponse {
  logs?: string[]
}

interface ConfigResponse {
  config?: EditableConfig
}

/* ── GET /stt (sidecar stt status) + POST /stt/install (download job) ──── */

interface SttLocalInfo {
  model?: string | null
  precision?: string | null
  wanted?: string
  tokens?: number
  vad?: string | null
  dir?: string
  problems?: string[]
}

interface SttEngineInfo {
  ok?: boolean
  path?: string | null
  tried?: string[]
}

interface SttExternalInfo {
  baseUrl?: string | null
  model?: string | null
  hasKey?: boolean
  /** Where the key came from: the Hermes credential store, or a legacy settings.json value. */
  keySource?: 'env' | 'settings' | null
}

interface SttJobInfo {
  id?: string
  what?: string
  state?: string
  startedAt?: number
  endedAt?: number | null
  percent?: number
  lines?: string[]
  error?: string | null
}

/** GET /stt response. */
interface SttInfo {
  kind?: string
  ready?: boolean
  language?: string
  local?: SttLocalInfo
  engine?: SttEngineInfo
  external?: SttExternalInfo
  job?: SttJobInfo | null
  lastError?: string | null
}

/** POST /stt/install response (202) and GET /stt.install job snapshot. */
interface SttInstallResponse {
  job?: SttJobInfo | null
}

/** Transcript entry returned by /selftest and /mock/transcript. */
interface TranscriptInfo {
  text?: string
  at?: number
  audioSeconds?: number
  inferenceSeconds?: number
  durationMs?: number
  selftest?: boolean
  mock?: boolean
  fellBack?: boolean
  source?: string
}
interface SelftestResponse {
  transcript?: TranscriptInfo
  source?: string
  fellBack?: boolean
}
interface MockTranscriptResponse {
  transcript?: TranscriptInfo
}

/** Generic success body of /open/settings, /restart, /start, /stop. */
interface OkResponse {
  ok?: boolean
  state?: string
  pane?: string
}

/** A transcript item kept in store.transcripts for the page. */
interface TranscriptItem {
  text: string
  at: number
  audioSeconds: number
}

/** Renderer-local preferences (never part of the daemon config). */
interface Prefs {
  insertMode: ComposerInsertMode
  capture: boolean
  notifyTranscript: boolean
  userKeys: string[]
  /** Optional locale override; absent means "follow the OS language". */
  locale?: string
}

/* ── Theme colours (same names as the desktop CSS variables; no hard-coded colours) ── */

const C = {
  fg: 'var(--ui-text-primary)',
  fg2: 'var(--ui-text-secondary)',
  fg3: 'var(--ui-text-tertiary)',
  fg4: 'var(--ui-text-quaternary)',
  accent: 'var(--ui-accent)',
  green: 'var(--ui-green)',
  orange: 'var(--ui-orange)',
  red: 'var(--ui-red)',
  blue: 'var(--ui-blue)',
  purple: 'var(--ui-purple)',
  yellow: 'var(--ui-yellow)'
}
const LINE = 'var(--ui-stroke-secondary)'
const BORDER = '1px solid ' + LINE
const TINT = (c: string, p: number | string): string => 'color-mix(in oklab, ' + c + ' ' + p + '%, transparent)'
const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace'

const ID = 'baton'
const ROUTE = '/baton'

/* ── Module state: shared across components and routes; the engine runs with or without UI ── */

type RestFn = <T>(path: string, opts?: PluginRestOptions) => Promise<T>
let REST: RestFn | null = null // ctx.rest
let CTX: PluginContext | null = null

interface Store {
  snap: StateSnapshot | null // /state snapshot
  stt: SttInfo | null // GET /stt snapshot (speech service card)
  selftest: TranscriptInfo | null // last /selftest transcript, shown by the link card
  error: string | null // most recent backend error, already stringified
  cursor: number | null // event cursor; null = head not located yet
  bootId: number | null // daemon instance id (bootAt); a change means seq restarted, so the cursor must reset
  lastEventAt: number
  transcripts: TranscriptItem[] // [{text, at, audioSeconds}], last 20, for the page
  busy: boolean // one-shot action in flight (self-test, scan, …)
}

const store: Store = {
  snap: null,
  stt: null,
  selftest: null,
  error: null,
  cursor: null,
  bootId: null,
  lastEventAt: 0,
  transcripts: [],
  busy: false
}

/* ── 15-second "window self-test": a renderer-only state machine ──────────
 * The plugin_api.py router mounted inside the gateway is not rescanned at runtime,
 * so new routes such as /capture only exist after a gateway restart; the window
 * self-test needs no backend anyway: the daemon pushes capturing→transcribing→
 * transcript on /events, and this just reads those events for the window. It also
 * yields live phase hints.
 *   idle → waiting → capturing → transcribing → done | empty
 *                                        └→ timeout / error
 */
type ListenPhase = 'idle' | 'waiting' | 'capturing' | 'transcribing' | 'done' | 'timeout' | 'error'
interface ListenWindow {
  until: number
  phase: ListenPhase
  text: string
  entry: EventPayload | null
  note: string
  lingerMs: number
}
const listenWin: ListenWindow = { until: 0, phase: 'idle', text: '', entry: null, note: '', lingerMs: 8000 }

function startListenWindow(ms: number): void {
  listenWin.until = Date.now() + ms
  listenWin.phase = 'waiting'
  listenWin.text = ''
  listenWin.entry = null
  listenWin.note = ''
  publish()
}

function listenActive(): boolean {
  return listenWin.until > Date.now()
}

function listenRemain(): number {
  return Math.max(0, Math.ceil((listenWin.until - Date.now()) / 1000))
}

/** A terminal phase stays up long enough to read, then returns to idle. */
function listenSettle(phase: 'done' | 'timeout' | 'error'): void {
  listenWin.phase = phase
  listenWin.until = Date.now() + listenWin.lingerMs
  publish()
}

const subs = new Set<() => void>()
function publish(): void {
  subs.forEach(fn => {
    try {
      fn()
    } catch {
      /* a throwing subscriber must not kill the poll loop */
    }
  })
}

function useStore(): Store {
  const [, force] = useState(0)
  useEffect(() => {
    const fn = () => force(n => n + 1)
    subs.add(fn)
    return () => {
      subs.delete(fn)
    }
  }, [])
  return store
}

/* ── Renderer-local preferences (never part of the daemon config) ────────── */

const PREFS_KEY = 'prefs'
const DEFAULT_PREFS: Prefs = { insertMode: 'inline', capture: false, notifyTranscript: true, userKeys: [] }
let prefs: Prefs = { ...DEFAULT_PREFS }

/** Load prefs, then point the catalogue at the stored locale (or the OS one). */
function readPrefs(): void {
  try {
    const saved: unknown = CTX && CTX.storage ? CTX.storage.get(PREFS_KEY, null) : null
    const patch = saved && typeof saved === 'object' ? (saved as Partial<Prefs>) : {}
    prefs = { ...DEFAULT_PREFS, ...patch }
  } catch {
    prefs = { ...DEFAULT_PREFS }
  }
  applyLocale(prefs.locale)
}

function savePrefs(patch: Partial<Prefs>): void {
  prefs = { ...prefs, ...patch }
  try {
    if (CTX && CTX.storage) CTX.storage.set(PREFS_KEY, prefs)
  } catch {
    /* prefs must keep working even when they cannot be written */
  }
  publish()
}

/* ── Backend facade: everything goes through ctx.rest (same origin, plugin-scoped) ── */

type TimerId = ReturnType<typeof setTimeout>
const timers = new Set<TimerId>()
function later(fn: () => void, ms: number): TimerId {
  const id = setTimeout(() => {
    timers.delete(id)
    fn()
  }, ms)
  timers.add(id)
  return id
}
function cancel(id: TimerId | null | undefined): void {
  if (id) {
    clearTimeout(id)
    timers.delete(id)
  }
}

async function api<T>(path: string, options?: PluginRestOptions): Promise<T> {
  if (!REST) throw new Error(L.notices.backendNotReady)
  return REST<T>(path, options)
}

type PostOptions = PluginRestOptions & { quiet?: boolean }
function post<T>(path: string, body?: Record<string, unknown>, opts?: PostOptions): Promise<T> {
  return api<T>(path, { method: 'POST', body: body || {}, ...(opts || {}) })
}

/** Error → readable text: the original `(error && error.message) || error` semantics, String once. */
function errText(error: unknown): string {
  const e = error as { message?: unknown } | null | undefined
  return String((e && e.message) || error)
}

async function refreshState(): Promise<void> {
  try {
    const snap = await api<StateSnapshot>('/state', { timeoutMs: 15000 })
    store.snap = snap
    store.error = null
    applyRuntimeConfig(snap)
  } catch (error) {
    store.error = errText(error)
  }
  refreshStt()
  publish()
}

/* ── Speech service status (GET /stt) and install jobs (POST /stt/install) ──
 * /stt rides the same refresh cycle as /state (no second timer): refreshState()
 * fires it best-effort after every snapshot. `stt-install` events append to the
 * job's lines in between, so the progress block stays live without refetching.
 */

/** Last job whose finished state was already acted on (one refresh + one self-test per job). */
let sttDoneJob: string | null = null

async function refreshStt(): Promise<void> {
  try {
    const info = await api<SttInfo>('/stt', { timeoutMs: 15000 })
    const incoming = (info && info.job) || null
    const prior = (store.stt && store.stt.job) || null
    if (incoming && prior && String(incoming.id || '') === String(prior.id || '')) {
      // Same job: the event stream appends lines ahead of the snapshot — keep the longer list.
      const priorLines = Array.isArray(prior.lines) ? prior.lines : []
      const incomingLines = Array.isArray(incoming.lines) ? incoming.lines : []
      incoming.lines = priorLines.length >= incomingLines.length ? priorLines : incomingLines
    }
    store.stt = info
    watchSttJob()
    publish()
  } catch {
    /* an old backend without /stt leaves the card on its last known state */
  }
}

/** A finished job: refresh /state once (models changed), and prove recognition when it succeeded. */
function watchSttJob(): void {
  const job = (store.stt && store.stt.job) || null
  if (!job || !job.state || job.state === 'running') return
  const id = String(job.id || '')
  if (id === sttDoneJob) return
  sttDoneJob = id
  refreshState()
  if (job.state === 'ok') runSelftest()
}

/** POST /selftest through one shared path: the button and the post-install check both land here. */
async function runSelftest(): Promise<void> {
  store.busy = true
  publish()
  try {
    const result = await post<SelftestResponse>('/selftest')
    store.selftest = (result && result.transcript) || null
  } catch (error) {
    toast(errText(error), 'error')
  } finally {
    store.busy = false
    publish()
    refreshState()
  }
}

/** POST /stt/install: start a download job (202 { job }; 409 while one is running). */
async function installStt(what: 'models' | 'sherpa' | 'all', fp32: boolean): Promise<void> {
  store.busy = true
  publish()
  try {
    const body: Record<string, unknown> = what === 'sherpa' ? { what: 'sherpa' } : { what, fp32 }
    const res = await post<SttInstallResponse>('/stt/install', body)
    const job = (res && res.job) || null
    if (job) {
      const id = String(job.id || '')
      if (id !== String(((store.stt && store.stt.job) || {}).id || '')) {
        sttDoneJob = null // a new job gets its own finish handling
      }
      store.stt = { ...(store.stt || {}), job }
    }
  } catch (error) {
    toast(fmt(L.stt.installFailed, { error: errText(error) }), 'error')
  } finally {
    store.busy = false
    publish()
    refreshStt()
  }
}

/** Last path segment of a model / module path (display only). */
function pathBasename(value: string | null | undefined): string {
  return String(value || '').split('/').filter(Boolean).pop() || ''
}

/** Pure summary of GET /stt for the speech-service card: no JSX, no hooks (exported for tests). */
export interface SttSummary {
  kindLabel: string
  readyDot: string
  engineLabel: string
  modelLabel: string
  engineMissing: boolean
  needsInstall: boolean
}

export function sttSummary(state: SttInfo | null): SttSummary {
  const info: SttInfo = state || {}
  const kind = String(info.kind || '')
  const local: SttLocalInfo = info.local || {}
  const engine: SttEngineInfo = info.engine || {}
  const problems = Array.isArray(local.problems) ? local.problems : []
  const kindLabel =
    kind === 'openai' ? L.stt.kindExternal : kind === 'sensevoice' ? L.stt.kindLocal : L.stt.kindMissing
  return {
    kindLabel,
    readyDot: info.ready ? C.green : C.orange,
    engineLabel:
      engine.ok && engine.path
        ? fmt(L.stt.engineInstalled, { name: pathBasename(engine.path) })
        : L.stt.engineMissing,
    modelLabel: local.model
      ? pathBasename(local.model) + (local.precision ? L.common.dot + String(local.precision) : '')
      : problems.length
        ? problems.join(L.common.listSeparator)
        : L.stt.modelMissing,
    engineMissing: !engine.ok,
    // An external service answers regardless of what is installed locally.
    needsInstall: kind !== 'openai' && (!engine.ok || !local.model)
  }
}

/** The daemon config is the single source of truth: the engine re-syncs on every snapshot. */
function applyRuntimeConfig(snap: StateSnapshot | null): void {
  if (!snap) return
  cfg.keysEnabled = Boolean(snap.keys && snap.keys.enabled)
  cfg.map = (snap.keys && snap.keys.map) || {}
  cfg.hidKeys = (snap.keys && snap.keys.hidKeys) || []
  cfg.doubleMs = (snap.keys && snap.keys.doubleMs) || 300
  cfg.longMs = (snap.keys && snap.keys.longMs) || 550
  cfg.autoSend = Boolean(snap.autoSend)
  cfg.phrases = snap.phrases || {}
  cfg.head = Number(snap.head || 0)
}

/* ── Action execution ─────────────────────────────────────────────────── */

interface RuntimeCfg {
  keysEnabled: boolean
  map: KeyMap
  hidKeys: string[]
  doubleMs: number
  longMs: number
  autoSend: boolean
  phrases: Record<string, string>
  head: number
}
const cfg: RuntimeCfg = {
  keysEnabled: false,
  map: {},
  hidKeys: [],
  doubleMs: 300,
  longMs: 550,
  autoSend: false,
  phrases: {},
  head: 0
}

function focusedSessionId(): string | null {
  try {
    return host.state.focusedSessionId.get() || host.state.activeSessionId.get() || null
  } catch {
    return null
  }
}

function toast(message: string, kind?: ToastKind): void {
  try {
    host.notify({ kind: kind || 'info', message })
  } catch {
    /* notifications being unavailable is not a failure */
  }
}

function petLine(text: string): void {
  try {
    if (CTX && CTX.pet && CTX.pet.say) CTX.pet.say(text, { ttlMs: 4000 })
  } catch {
    /* no pet attached: stay silent */
  }
}

/** The renderer may only open http/https/file, so file:// launches System Settings.
 *  Panel-level jumps (straight to Bluetooth) go through the backend /open/settings,
 *  because the OS door refuses schemes such as x-apple:.
 *  `ctx.os` is the SDK's curated OS namespace; the raw `window.hermesDesktop`
 *  bridge is app-internal and catalog rule 8 keeps plugins off it. */
async function openSystemSettingsApp(): Promise<boolean> {
  try {
    if (!CTX || !CTX.os || typeof CTX.os.openExternal !== 'function') return false
    return await CTX.os.openExternal('file:///System/Applications/System%20Settings.app')
  } catch {
    return false
  }
}

/** Seconds for display: "?" when unknown, never a fake 0.00. */
const fmtSec = (value: number | string | null | undefined): string => {
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(2) : '?'
}

/** Submit a text immediately (bypassing the composer). Empty text returns false; the backend rejects it. */
function submitNow(text: string): boolean {
  if (!text || !String(text).trim()) return false
  try {
    return host.composer.submit(null, String(text).trim())
  } catch {
    return false
  }
}

/** Address of the visible composer.
 *  Passing null uses the app's "active composer" bus, and that pointer can land on an
 *  *invisible* mounted instance when the plugin replaces the main area or a keep-alive
 *  tab is left behind: insertText still acks true, but the text goes into a draft the
 *  user cannot see (measured: state grows every time, the UI stays blank).
 *  So locate by the focused session's persistent id (which lands on the main composer)
 *  and only fall back to 'new' when there is no session. */
function composerAddress(): string {
  try {
    const stored = host.state.focusedStoredSessionId && host.state.focusedStoredSessionId.get
      ? host.state.focusedStoredSessionId.get()
      : null
    if (stored) return stored
  } catch {
    /* unreadable: fall back to the new-session draft */
  }
  return 'new'
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Text of the visible composer. The DOM is the only proof that the user really sees it:
 *  getDraft proves the state holds the text, not that the editor repainted (observed:
 *  state had it, the UI was blank). */
function composerDomText(): string | null {
  // null = this environment cannot tell (node test harness, no real DOM).
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null
  try {
    const nodes = document.querySelectorAll('[role="textbox"][contenteditable="true"]')
    let best = ''
    nodes.forEach(node => {
      if (node.getClientRects().length === 0) return
      const text = String(node.textContent || '')
      if (text.length > best.length) best = text
    })
    return best
  } catch {
    return null
  }
}

async function domHas(body: string): Promise<boolean> {
  const probe = body.slice(0, Math.min(8, body.length))
  const first = composerDomText()
  if (first === null) return true // cannot verify: trust the ack
  if (first.includes(probe)) return true
  await sleep(120) // the editor repaints asynchronously: give it one beat
  const second = composerDomText()
  return second === null ? true : second.includes(probe)
}

async function insertIntoComposer(text: string, mode?: ComposerInsertMode): Promise<boolean> {
  const body = String(text || '').trim()
  if (!body) return false
  const m: ComposerInsertMode = mode || prefs.insertMode || 'inline'
  const addr = composerAddress()
  for (const target of [addr, 'new', null]) {
    let ok = false
    try {
      ok = await host.composer.insertText(target, body, { mode: m })
    } catch {
      ok = false
    }
    if (!ok) continue
    if (await domHas(body)) return true
    break // acked but the UI did not change: stop switching addresses to avoid double inserts
  }
  // Fallback: rewrite the whole draft (same value still counts as a change) to force a repaint.
  // Measured: "state has it, UI blank" only recovers after a setDraft. */
  try {
    const current = String((await host.composer.getDraft(addr)) || '')
    const next = current.includes(body)
      ? current
      : m === 'inline'
        ? `${current.trimEnd()}${current.trim() ? ' ' : ''}${body}`
        : `${current}${current && !current.endsWith('\n') ? '\n\n' : ''}${body}`
    await host.composer.setDraft(addr, next)
    if (await domHas(body)) return true
  } catch {
    /* fallback failed: the caller reports it */
  }
  return false
}

async function stopGeneration(): Promise<boolean> {
  const sessionId = focusedSessionId()
  if (!sessionId) {
    toast(L.toasts.stopNoSession)
    return false
  }
  try {
    await host.request('session.interrupt', { session_id: sessionId })
    return true
  } catch (error) {
    toast(fmt(L.toasts.stopFailed, { error: errText(error) }), 'error')
    return false
  }
}

/** Landing a transcript: auto-send (when the draft is empty) or insert into the draft. */
async function deliverTranscript(entry: EventPayload): Promise<void> {
  const text = String((entry && entry.text) || '').trim()
  if (!text) return
  store.transcripts = [{ text, at: entry.at || Date.now(), audioSeconds: entry.audioSeconds || 0 }, ...store.transcripts].slice(0, 20)
  publish()

  if (cfg.autoSend) {
    let draft = ''
    try {
      draft = String((await host.composer.getDraft(null)) || '')
    } catch {
      draft = ''
    }
    if (!draft.trim() && submitNow(text)) {
      petLine(L.toasts.sent)
      return
    }
    if (draft.trim()) {
      // The draft already has content: insert and say so, never throw away what the user is writing.
      await insertIntoComposer(text)
      toast(L.toasts.insertedDraft)
      return
    }
  }

  const ok = await insertIntoComposer(text)
  if (!ok) {
    toast(fmt(L.toasts.noComposer, { text: text.slice(0, 40) }))
    return
  }
  petLine('🎙 ' + text.slice(0, 40))
  if (prefs.notifyTranscript) {
    const secs = entry.audioSeconds ? Number(entry.audioSeconds).toFixed(1) + 's' : ''
    toast(secs ? fmt(L.toasts.insertedWithSeconds, { secs }) : L.toasts.inserted)
  }
}

/* ── Key engine (single / double / long press) ───────────────────────────── */

interface KeyState {
  held?: boolean
  longTimer?: TimerId | null
  singleTimer?: TimerId | null
  longFired?: boolean
  lastDownAt?: number
  lastDomAt?: number
}
interface EngineState {
  states: Record<string, KeyState> // code → {held, longTimer, singleTimer, longFired, lastDownAt, lastDomAt}
  lastAction: { action: ActionValue; code: string; at: number } | null
}
const engine: EngineState = {
  states: {},
  lastAction: null
}

/** Legacy action-label table: nothing reads it any more (actionLabel() has its own
 *  placeholder labels). Kept as-is so behaviour stays identical to the old plugin.js. */
const ACTION_LABEL = {
  submit: L.actions.submit,
  stop: L.actions.stop,
  'new-session': L.actions.newSession,
  swallow: L.actions.swallowLong,
  focus: L.actions.focus,
  none: L.actions.none
}
void ACTION_LABEL

function bindingOf(code: string): KeyBinding | null {
  if (!cfg.keysEnabled) return null
  const b = cfg.map && cfg.map[code]
  return b && typeof b === 'object' ? b : null
}

function runAction(action: ActionValue | null, code: string): void {
  if (!action) return
  engine.lastAction = { action, code, at: Date.now() }
  if (action === 'submit') {
    const sessionId = focusedSessionId()
    if (!sessionId) {
      toast(L.toasts.submitNoSession)
      return
    }
    // submit(sessionId, text) needs non-empty text: read the draft first, same as pressing Enter.
    Promise.resolve(host.composer.getDraft(null))
      .then(draft => {
        const text = String(draft || '').trim()
        if (!text) return
        if (!submitNow(text)) toast(L.toasts.submitNoAnswer, 'error')
      })
      .catch(() => toast(L.toasts.submitDraftError, 'error'))
    return
  }
  if (action === 'stop') {
    stopGeneration()
    return
  }
  if (action === 'new-session') {
    try {
      host.newChat()
    } catch {
      toast(L.toasts.newChatFailed, 'error')
    }
    return
  }
  if (action === 'focus') {
    try {
      host.composer.focus(null)
    } catch {
      /* no composer is no composer */
    }
    return
  }
  if (action === 'swallow' || action === 'none') return
  if (action && typeof action === 'object' && action.action === 'phrase') {
    const text = cfg.phrases && cfg.phrases[String(action.name)]
    if (!text) {
      toast(fmt(L.toasts.phraseMissing, { name: action.name }), 'error')
      return
    }
    insertIntoComposer(text).then(ok => {
      if (!ok) toast(L.toasts.phraseInsertFailed, 'error')
      else petLine('🎙 ' + String(text).slice(0, 40))
    })
    return
  }
}

function firstAction(binding: KeyBinding | null, tap: TapName): ActionValue | null {
  const value = binding && binding[tap]
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value.action) return value
  return null
}

function keyDown(code: string, source: string): boolean {
  const binding = bindingOf(code)
  if (!binding) return false
  const now = Date.now()
  const st = engine.states[code] || (engine.states[code] = {})
  if (st.held) return true // firmware repeats keydown: do not restart the timer while held
  st.held = true
  st.lastDownAt = now
  if (source === 'dom') st.lastDomAt = now

  const single = firstAction(binding, 'single')
  const double = firstAction(binding, 'double')
  const long = firstAction(binding, 'long')

  if (long) {
    cancel(st.longTimer)
    st.longFired = false
    st.longTimer = later(() => {
      st.longFired = true
      runAction(long, code)
    }, cfg.longMs)
  }
  // Single press only: no waiting, the action fires on press like a physical key.
  if (single && !double && !long) runAction(single, code)
  return true
}

function keyUp(code: string, source: string): boolean {
  void source // same signature as the original JS: callers pass a source tag, the body only uses code.
  const binding = bindingOf(code)
  if (!binding) return false
  const st = engine.states[code]
  if (!st || !st.held) return false
  st.held = false
  cancel(st.longTimer)
  st.longTimer = null

  const single = firstAction(binding, 'single')
  const double = firstAction(binding, 'double')
  const long = firstAction(binding, 'long')

  if (long && st.longFired) {
    st.longFired = false
    return true
  }
  if (double) {
    if (st.singleTimer) {
      // Second release within doubleMs: it is a double tap, cancel the pending single.
      cancel(st.singleTimer)
      st.singleTimer = null
      runAction(double, code)
    } else {
      cancel(st.singleTimer)
      st.singleTimer = later(() => {
        st.singleTimer = null
        if (single) runAction(single, code)
      }, cfg.doubleMs)
    }
    return true
  }
  if (single && long) {
    // Long press but no double: release before longMs fires the single; wait a beat so long press wins.
    const elapsed = Date.now() - (st.lastDownAt || 0)
    const wait = Math.max(0, cfg.longMs + 60 - elapsed)
    cancel(st.singleTimer)
    st.singleTimer = later(() => {
      st.singleTimer = null
      if (!st.longFired) runAction(single, code)
    }, wait)
    return true
  }
  return true
}

/* ── DOM path (only takes over when "capture keyboard" is enabled) ───────── */

const DOM_CODES = new Set(['Enter', 'NumpadEnter', 'Home', 'Backquote', 'F5', 'ContextMenu', 'Back', 'Escape', 'Space'])

/** Minimal keyboard-event shape (a DOM KeyboardEvent fits; so does the test stub's plain object). */
interface KeyLikeEvent {
  code?: string
  key?: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  repeat?: boolean
  preventDefault(): void
  stopPropagation(): void
}
function isKeyLikeEvent(value: unknown): value is KeyLikeEvent {
  return typeof value === 'object' && value !== null
}

function onDomKey(raw: unknown, down: boolean): void {
  if (!isKeyLikeEvent(raw)) return
  const event = raw
  if (!cfg.keysEnabled) return
  const code = event.code || event.key
  if (!code || !DOM_CODES.has(code)) return
  if (!cfg.map[code]) return
  if (event.metaKey || event.ctrlKey || event.altKey) return // system/app shortcuts win
  // Shift also means "a human is typing": Shift+Enter for a newline and Shift+Home to select
  // to line start must stay in the editor. The remote only sends bare keys, so nothing is lost.
  if (event.shiftKey) return
  if (!prefs.capture) return // capture off: observe mappings only, never take keys
  if (event.repeat) {
    // Auto-repeat while held: block it so the composer does not fill with a character run.
    if (bindingOf(code)) event.preventDefault()
    return
  }
  if (down) {
    // The bridge path reports the same key (hid-watch reports everything): 150ms dedupe.
    const st = engine.states[code]
    if (st && st.held) {
      event.preventDefault()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    keyDown(code, 'dom')
  } else {
    event.preventDefault()
    keyUp(code, 'dom')
  }
}

/* ── Event polling: transcripts / keys / link ────────────────────────────── */

let pollTimer: TimerId | null = null
let refreshTimer: TimerId | null = null // legacy from the original JS: declared, never used; kept as-is.
void pollTimer
void refreshTimer
let tickCount = 0

async function tick(): Promise<void> {
  tickCount += 1
  try {
    const payload = await api<EventsResponse>('/events?since=' + (store.cursor === null ? 'head' : store.cursor), { timeoutMs: 15000 })
    if (payload && typeof payload.cursor === 'number') {
      // After a daemon restart seq goes back to 1 while cursor still sits on the old
      // process's large number: then since=37 > head=3, the slice is always empty and every
      // event is lost (symptom: keys show up in daemon.log, Hermes does nothing). Detect a
      // new instance by bootAt and pull the cursor back to head when needed.
      const bootChanged = payload.bootAt !== undefined && store.bootId !== null && payload.bootAt !== store.bootId
      const rewound = typeof payload.head === 'number' && store.cursor !== null && payload.head < store.cursor
      if (payload.bootAt !== undefined) store.bootId = payload.bootAt
      if (store.cursor === null) {
        // First mount starts at head: do not replay events from the previous run.
        store.cursor = payload.cursor
      } else if (bootChanged || rewound) {
        store.cursor = typeof payload.head === 'number' ? payload.head : payload.cursor
      } else if (payload.events && payload.events.length) {
        store.cursor = payload.cursor
        for (const event of payload.events) handleEvent(event)
        store.lastEventAt = Date.now()
      }
    }
    if (store.error) {
      store.error = null
      publish()
    }
  } catch (error) {
    const message = errText(error)
    if (store.error !== message) {
      store.error = message
      publish()
    }
  }
  // Window self-test: countdown and expiry are advanced here (400ms per tick, second-level is enough).
  if (listenWin.until) {
    if (Date.now() > listenWin.until) {
      const phase = listenWin.phase
      listenWin.until = 0
      if (phase === 'waiting' || phase === 'capturing') listenSettle('timeout')
      else if (phase !== 'idle') {
        listenWin.phase = 'idle'
        publish()
      }
    } else if (listenWin.phase === 'waiting' || listenWin.phase === 'capturing') {
      publish()
    }
  }
  // A snapshot is cheaper than the event stream but less urgent: every 4th tick, plus after local actions.
  if (tickCount % 4 === 1) refreshState()
}

/** Daemon notice → local text. Known kinds are localised; unknown kinds pass the backend text through. */
function noticeText(payload: EventPayload): string {
  if (payload.kind === 'too-short') return fmt(L.notices.tooShort, { ms: Number(payload.audioMs || 0) })
  if (payload.kind === 'empty') return L.notices.empty
  return String(payload.message || '')
}

function handleEvent(event: DaemonEvent): void {
  const type = event && event.type
  const payload: EventPayload = (event && event.payload) || {}
  if (type === 'transcript') {
    if (payload.selftest) {
      // Self-test results are reported only, never written into the composer.
      publish()
      return
    }
    if (listenActive()) {
      // Speech inside the window is display-only and never touches the composer (the button promises that).
      listenWin.text = String(payload.text || '')
      listenWin.entry = payload
      listenSettle('done')
      return
    }
    deliverTranscript(payload)
    return
  }
  if (type === 'key') {
    const code = payload.code
    if (!code) return
    if (payload.down) {
      const st = engine.states[code]
      // 150ms dedupe against the DOM path: whoever arrives first wins, the later one is ignored.
      if (st && st.lastDomAt && Math.abs((event.at || Date.now()) - st.lastDomAt) < 150) return
      keyDown(code, 'native')
    } else {
      keyUp(code, 'native')
    }
    return
  }
  if (type === 'state' || type === 'device') {
    if (type === 'state' && listenActive() && (payload.state === 'capturing' || payload.state === 'transcribing')) {
      listenWin.phase = payload.state
    }
    publish()
    return
  }
  if (type === 'stt-install') {
    // Install progress: append to the job's lines in place — no refetch, the next
    // /stt snapshot only reconciles what the events already delivered.
    const id = String(payload.id || '')
    const current = (store.stt && store.stt.job) || null
    const job: SttJobInfo =
      current && String(current.id || '') === id
        ? current
        : { id, what: 'all', state: 'running', percent: 0, lines: [] }
    if (!Array.isArray(job.lines)) job.lines = []
    if (payload.line) job.lines.push(String(payload.line))
    if (typeof payload.percent === 'number') job.percent = payload.percent
    if (payload.state) job.state = String(payload.state)
    store.stt = { ...(store.stt || {}), job }
    publish()
    return
  }
  if (type === 'error') {
    if (listenActive()) {
      listenWin.note = String(payload.message || L.notices.recognitionFailed)
      listenSettle('error')
    }
    toast(fmt(L.notices.failed, { detail: String(payload.message || '').slice(0, 80) }), 'error')
    publish()
    return
  }
  if (type === 'notice') {
    // A readable daemon notice ("didn't catch that", "too short"): not an error, one light
    // hint, never interrupts typing.
    const message = noticeText(payload)
    if (listenActive() && payload.kind === 'empty') {
      // The window is still open, so another try is allowed: no terminal phase, just
      // record "didn't catch that" as the note.
      listenWin.note = message || L.notices.empty
      listenWin.phase = 'waiting'
      publish()
      return
    }
    if (message) {
      petLine('🎙 ' + message)
      toast(message, 'info')
    }
    publish()
  }
}

function startPolling(): void {
  const interval = () => (typeof document !== 'undefined' && document.visibilityState === 'hidden' ? 2000 : 400)
  const loop = () => {
    tick()
    pollTimer = later(loop, interval())
  }
  loop()
}

/* ── UI atoms ─────────────────────────────────────────────────────────── */

/* ── Visual primitives ──────────────────────────────────────────────────
 * Type sizes collapse to 5 steps (micro/tiny/small/body/lead + metric/title) and
 * spacing is always a multiple of 4; colours come from theme variables only.
 * Editing this one object retunes the whole density.
 */
const FS = { micro: 10.5, tiny: 11, small: 11.5, body: 12.5, lead: 13.5, metric: 16, title: 19 }

interface BtnProps {
  children?: ReactNode
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  tone?: string
  title?: string
  wide?: boolean
  ghost?: boolean
}

function Btn({ children, onClick, active, disabled, tone, title, wide, ghost }: BtnProps) {
  const accent = tone || C.accent
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      className={'rm-btn' + (active ? ' rm-active' : '')}
      style={{
        padding: wide ? '6px 14px' : '4px 11px',
        minHeight: 26,
        borderRadius: 7,
        border: '1px solid ' + (active ? TINT(accent, 55) : ghost ? 'transparent' : LINE),
        background: active ? TINT(accent, 14) : 'transparent',
        color: active ? (tone ? accent : C.fg) : C.fg2,
        fontSize: FS.body,
        fontFamily: 'inherit',
        lineHeight: '18px',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        whiteSpace: 'nowrap'
      }}
    >
      {children}
    </button>
  )
}

/** Segmented control: mutually exclusive options in one trough read as a single setting. */
interface SegOption<V extends string | number> {
  value: V
  label: ReactNode
  title?: string
}

interface SegmentedProps<V extends string | number> {
  value: V
  options: Array<SegOption<V>>
  onChange: (value: V) => void
  tone?: string
  disabled?: boolean
}

function Segmented<V extends string | number>({ value, options, onChange, tone, disabled }: SegmentedProps<V>) {
  // Normalisation identical to the old version: bare strings become {value,label}; the cast only narrows.
  const list = (options || []).map(o => (typeof o === 'string' ? { value: o, label: o } : o)) as Array<SegOption<V>>
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'stretch',
        padding: 2,
        gap: 2,
        border: BORDER,
        borderRadius: 8,
        background: 'var(--ui-bg-elevated, transparent)'
      }}
    >
      {list.map(o => {
        const on = o.value === value
        return (
          <button
            {...{ key: String(o.value) }}
            type="button"
            disabled={disabled}
            title={o.title}
            onClick={disabled ? undefined : () => onChange(o.value)}
            className={'rm-btn' + (on ? ' rm-active' : '')}
            style={{
              padding: '2px 9px',
              minHeight: 22,
              borderRadius: 6,
              border: '1px solid ' + (on ? TINT(tone || C.accent, 88) : 'transparent'),
              background: on ? TINT(tone || C.accent, 36) : 'transparent',
              color: on ? C.fg : C.fg3,
              fontWeight: on ? 600 : 400,
              fontSize: FS.small,
              fontFamily: 'inherit',
              cursor: disabled ? 'default' : 'pointer',
              whiteSpace: 'nowrap'
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

interface CardProps {
  title?: ReactNode
  hint?: ReactNode
  action?: ReactNode
  children?: ReactNode
  tone?: string
  dense?: boolean
}

function Card({ title, hint, action, children, tone, dense }: CardProps) {
  const header = (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: dense ? '10px 14px' : '11px 16px',
        borderBottom: hint ? 'none' : BORDER,
        minHeight: 40,
        flexWrap: 'wrap'
      }}
    >
      <h2 style={{ margin: 0, fontSize: FS.tiny, fontWeight: 600, letterSpacing: '0.08em', color: C.fg3 }}>{title}</h2>
      <span style={{ flex: 1 }} />
      {action || null}
    </header>
  )
  return (
    <section
      style={{
        border: '1px solid ' + (tone ? TINT(tone, 26) : LINE),
        borderRadius: 12,
        background: 'var(--ui-bg-card, transparent)',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0
      }}
    >
      {header}
      {hint ? <p style={{ margin: 0, padding: '0 16px', fontSize: FS.small, color: C.fg4, lineHeight: '17px' }}>{hint}</p> : null}
      <div style={{ padding: dense ? '10px 14px 12px' : '12px 16px 14px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, flex: 1 }}>{children}</div>
    </section>
  )
}

/** Setting row: label left, control right, but only as wide as the card — no cross-screen pairing. */
interface FieldProps {
  label?: ReactNode
  hint?: ReactNode
  children?: ReactNode
}

function Field({ label, hint, children }: FieldProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 30 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: FS.body, color: C.fg2 }}>{label}</span>
        {hint ? <span style={{ fontSize: FS.tiny, color: C.fg4, lineHeight: '15px' }}>{hint}</span> : null}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>{children}</div>
    </div>
  )
}

/** Kept for old call sites (Row was a synonym of Field). */
const Row = Field
void Row

/** Metric tile: a small label above a reading, used for the "link" readout row. */
interface TileProps {
  label?: ReactNode
  children?: ReactNode
  sub?: ReactNode
  divider?: boolean
}

function Tile({ label, children, sub, divider }: TileProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        minWidth: 0,
        paddingLeft: divider ? 18 : 0,
        borderLeft: divider ? BORDER : 'none'
      }}
    >
      <span style={{ fontSize: FS.micro, color: C.fg4, letterSpacing: '0.09em', fontWeight: 500 }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, minHeight: 24 }}>{children}</div>
      {sub ? (
        <span style={{ fontSize: FS.tiny, color: C.fg4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</span>
      ) : null}
    </div>
  )
}

/** Inset panel: secondary content (log, explainer) in a one-step-lower background. */
interface PanelProps {
  children?: ReactNode
  style?: CSSProperties
}

function Panel({ children, style }: PanelProps) {
  return (
    <div
      style={{
        border: BORDER,
        borderRadius: 9,
        background: 'var(--ui-bg-elevated, transparent)',
        padding: '10px 12px',
        minWidth: 0,
        ...(style || {})
      }}
    >
      {children}
    </div>
  )
}

/** Keycap: the visual symbol of a key name, so "mapping" reads like a key table, not a form. */
function Keycap({ children }: { children?: ReactNode }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 24,
        padding: '2px 7px',
        borderRadius: 5,
        border: BORDER,
        background: 'var(--ui-bg-quaternary, transparent)',
        fontFamily: MONO,
        fontSize: FS.tiny,
        color: C.fg2,
        whiteSpace: 'nowrap'
      }}
    >
      {children}
    </span>
  )
}

function Empty({ children }: { children?: ReactNode }) {
  return <p style={{ margin: 0, fontSize: FS.small, color: C.fg4, lineHeight: '18px' }}>{children}</p>
}

interface ToggleProps {
  on: boolean
  onChange: (on: boolean) => void
  labels?: [string, string]
}

function Toggle({ on, onChange, labels }: ToggleProps) {
  const pair = labels || [L.toggles.on, L.toggles.off]
  return (
    <Segmented
      value={on ? 1 : 0}
      options={[{ value: 1, label: pair[0] }, { value: 0, label: pair[1] }]}
      onChange={v => onChange(v === 1)}
    />
  )
}

interface NumProps {
  value: number
  onCommit: (value: number) => void
  min?: number
  max?: number
  step?: number
  suffix?: string
}

function Num({ value, onCommit, min, max, step, suffix }: NumProps) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = () => {
    const v = Number(draft)
    if (!Number.isFinite(v)) {
      setDraft(String(value))
      return
    }
    const clamped = Math.min(max === undefined ? 1e9 : max, Math.max(min === undefined ? -1e9 : min, v))
    setDraft(String(clamped))
    if (clamped !== value) onCommit(clamped)
  }
  const input = (
    <input
      value={draft}
      className="rm-field"
      inputMode="numeric"
      step={step || 1}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') commit()
      }}
      style={{
        width: 72,
        padding: '4px 6px',
        borderRadius: 6,
        border: BORDER,
        background: 'transparent',
        color: C.fg,
        fontSize: 12,
        fontFamily: MONO,
        textAlign: 'right',
        outline: 'none'
      }}
    />
  )
  return suffix ? (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {input}
      <span style={{ fontSize: 11, color: C.fg4, width: 20 }}>{suffix}</span>
    </span>
  ) : (
    input
  )
}

const SELECT_STYLE: CSSProperties = {
  padding: '4px 6px',
  borderRadius: 6,
  border: BORDER,
  background: 'var(--ui-bg-elevated, transparent)',
  color: C.fg,
  fontSize: 12,
  fontFamily: 'inherit',
  outline: 'none',
  maxWidth: 190
}

interface SelectOption {
  value: string
  label: string
}

interface SelectProps {
  value?: string
  options: SelectOption[]
  onChange: (value: string) => void
  style?: CSSProperties
}

function Select({ value, options, onChange, style }: SelectProps) {
  return (
    <select
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      className="rm-field"
      style={{ ...SELECT_STYLE, width: '100%', maxWidth: 'none', ...(style || {}) }}
    >
      {options.map(o => (
        <option {...{ key: o.value }} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

interface TextInputProps {
  value?: string
  onChange: (value: string) => void
  placeholder?: string
  width?: string | number
  type?: string
}

function TextInput({ value, onChange, placeholder, width, type }: TextInputProps) {
  return (
    <input
      value={value || ''}
      className="rm-field"
      type={type || 'text'}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      style={{
        width: width || 160,
        padding: '4px 8px',
        borderRadius: 6,
        border: BORDER,
        background: 'transparent',
        color: C.fg,
        fontSize: 12,
        fontFamily: 'inherit',
        outline: 'none'
      }}
    />
  )
}

/** Page-header glyph: a microphone, same semantics as the sidebar codicon. */
function MicGlyph() {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect {...{ key: 'b' }} x={9} y={2.5} width={6} height={11} rx={3} />
      <path {...{ key: 'a' }} d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
      <path {...{ key: 's' }} d="M12 18v3.5" />
    </svg>
  )
}

function Dot({ tone, pulse }: { tone?: string; pulse?: boolean }) {
  return (
    <span
      className={pulse ? 'animate-pulse' : ''}
      style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 999, background: tone, flexShrink: 0 }}
    />
  )
}

/* ── Status-bar chip ──────────────────────────────────────────────────── */

/** Daemon state → label from the active catalogue; "" when the state is unknown. */
function stateText(state: string | null | undefined): string {
  const key = String(state || '')
  const table: Record<string, string> = L.states
  return key && table[key] ? table[key] : ''
}

function stateTone(state: string | null | undefined): string {
  if (state === 'ready') return C.green
  if (state === 'capturing') return C.accent
  if (state === 'transcribing') return C.blue
  if (state === 'starting') return C.yellow || C.orange
  if (state === 'error') return C.red
  return C.fg4
}

/* ── Status-bar badge: 18px icon + battery ─────────────────────────────── */

// The animation needs @keyframes, which inline styles cannot express, so inject one <style>.
let badgeStyleReady = false
function ensureBadgeStyle(): void {
  if (badgeStyleReady) return
  badgeStyleReady = true
  try {
    const style = document.createElement('style')
    style.setAttribute('data-baton', 'badge')
    style.textContent = [
      '.rm-btn{transition:background-color .12s ease,border-color .12s ease,color .12s ease}',
      '.rm-btn:hover:not(:disabled){background-color:var(--ui-bg-quaternary,rgba(127,127,127,.14))!important}',
      '.rm-active:hover:not(:disabled){filter:brightness(1.08);border-color:var(--ui-accent)!important}',
      '.rm-row{transition:background-color .1s ease}',
      '.rm-row:hover{background-color:var(--ui-bg-tertiary,rgba(127,127,127,.07))}',
      '.rm-field:hover{border-color:var(--ui-stroke-tertiary,var(--ui-stroke-secondary))}',
      '.rm-field:focus{outline:none;border-color:var(--ui-accent)!important}',
      '.rm-log::-webkit-scrollbar,.rm-page::-webkit-scrollbar{width:9px;height:9px}',
      '.rm-log::-webkit-scrollbar-thumb,.rm-page::-webkit-scrollbar-thumb{background:var(--ui-stroke-secondary);border-radius:4px;border:2px solid transparent;background-clip:padding-box}',
      '.rm-bars{display:inline-flex;align-items:center;justify-content:center;gap:2px;width:20px;height:16px}',
      '.rm-bars i{display:block;width:2.5px;height:4px;border-radius:1.5px;background:currentColor;opacity:.65;animation:rm-bar .9s ease-in-out infinite}',
      '.rm-bars i:nth-child(2){animation-delay:.12s}',
      '.rm-bars i:nth-child(3){animation-delay:.24s}',
      '.rm-bars i:nth-child(4){animation-delay:.36s}',
      '.rm-bars i:nth-child(5){animation-delay:.48s}',
      '@keyframes rm-bar{0%,100%{height:4px;opacity:.55}50%{height:13px;opacity:1}}',
      '@media (prefers-reduced-motion:reduce){.rm-bars i{animation:none;height:9px;opacity:.8}}'
    ].join('')
    document.head.appendChild(style)
  } catch {
    /* no document: degrade to static glyphs, functionality unaffected */
  }
}

// Corner brackets shared by the locked states; colour follows the state.
function cornerFrame(tone: string, brokenTopRight: boolean) {
  return (
    <g {...{ key: 'frame' }} fill="none" stroke={tone} strokeWidth={1.8} strokeLinecap="round">
      <path {...{ key: 'tl' }} d="M4 9V6a2 2 0 0 1 2-2h3" />
      <path {...{ key: 'tr' }} d={brokenTopRight ? 'M16.6 3.5h3a2 2 0 0 1 2 2v3.1' : 'M15 4h3a2 2 0 0 1 2 2v3'} />
      <path {...{ key: 'br' }} d="M20 15v3a2 2 0 0 1-2 2h-3" />
      <path {...{ key: 'bl' }} d="M9 20H6a2 2 0 0 1-2-2v-3" />
    </g>
  )
}

// ready: intact frame + solid green centre (online and locked); error: broken top-right + slashed circle.
function badgeIcon({ state, error }: { state?: string | null; error: boolean }) {
  ensureBadgeStyle()
  const svg = (children: ReactNode) => (
    <svg width={18} height={18} viewBox="0 0 24 24" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
      {children}
    </svg>
  )
  if (error || state === 'error') {
    return svg([
      cornerFrame(C.red, true),
      <circle {...{ key: 'c' }} cx={12} cy={12} r={2.2} fill="none" stroke={C.red} strokeWidth={1.8} />,
      <path {...{ key: 's' }} d="M10.6 13.4l2.8-2.8" fill="none" stroke={C.red} strokeWidth={1.8} strokeLinecap="round" />
    ])
  }
  if (state === 'capturing') {
    return (
      <span className="rm-bars" style={{ color: C.red }} aria-hidden="true">
        {[1, 2, 3, 4, 5].map(n => (
          <i {...{ key: n }} />
        ))}
      </span>
    )
  }
  if (state === 'ready') {
    return svg([cornerFrame(C.fg3, false), <circle {...{ key: 'dot' }} cx={12} cy={12} r={2.3} fill={C.green} />])
  }
  if (state === 'transcribing') {
    // Transcribing is transitional: blue dot here, the text label handles the rest.
    return svg([cornerFrame(C.fg3, false), <circle {...{ key: 'dot' }} cx={12} cy={12} r={2.3} fill={C.blue} />])
  }
  // starting / stopped / unknown: grey hollow frame, the text label is the fallback.
  return svg([
    cornerFrame(C.fg4, false),
    <circle {...{ key: 'dot' }} cx={12} cy={12} r={2.1} fill="none" stroke={C.fg4} strokeWidth={1.8} />
  ])
}

// Battery: phone-style cell, inner bar filled by percentage, colour steps at 20% / 45%.
function batteryTone(level: number): string {
  if (level <= 20) return C.red
  if (level <= 45) return C.orange || C.yellow
  return C.green
}

function BatteryIcon({ key, level }: { key?: string; level: number }) {
  const width = Math.max(1.6, (15.6 * level) / 100)
  return (
    <svg
      {...{ key }}
      width={24}
      height={12}
      viewBox="0 0 24 12"
      role="img"
      aria-label={fmt(L.chip.batteryLabel, { level })}
      style={{ display: 'block', flexShrink: 0 }}
    >
      <rect {...{ key: 'case' }} x={0.6} y={0.6} width={18.8} height={10.8} rx={3.2} fill="none" stroke={C.fg4} strokeWidth={1.2} />
      <rect {...{ key: 'nub' }} x={20.1} y={3.9} width={2.3} height={4.2} rx={1.2} fill={C.fg4} />
      <rect {...{ key: 'fill' }} x={2.2} y={2.2} width={width} height={7.6} rx={2} fill={batteryTone(level)} />
    </svg>
  )
}

function Chip() {
  ensureBadgeStyle()
  const s = useStore()
  const snap = s.snap
  const state = snap && snap.state
  const error = Boolean(s.error) || state === 'error'
  const detail = s.error || (snap && snap.detail)
  const battery = snap && (snap.battery !== null && snap.battery !== undefined ? snap.battery : snap.diagnostics && snap.diagnostics.battery)
  const level = typeof battery === 'number' && isFinite(battery)
    ? Math.max(0, Math.min(100, Math.round(battery)))
    : null
  const label = s.error ? L.chip.offline : stateText(state) || (snap ? String(state || L.common.unknown) : '…')
  // Transitional states (connecting / stopped / transcribing / not yet known) keep a small label; others show the icon only.
  const showText = !error && (state === 'transcribing' || state === 'starting' || state === 'stopped' || !state)
  const device = deviceName(snap)
  const title = [
    L.plugin.name,
    label + (detail ? ' · ' + detail : ''),
    device ? fmt(L.chip.device, { device }) : null,
    level !== null ? fmt(L.chip.battery, { level }) : null,
    L.chip.open
  ]
    .filter(Boolean)
    .join(L.common.separator)

  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={() => host.navigate(ROUTE)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 6px',
        height: 24,
        borderRadius: 6,
        border: '1px solid transparent',
        background: 'transparent',
        color: error ? C.red : C.fg2,
        fontSize: 11.5,
        fontFamily: 'inherit',
        lineHeight: 1,
        cursor: 'pointer'
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background = TINT(C.accent, 12)
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = 'transparent'
      }}
    >
      <span {...{ key: 'icon' }} style={{ display: 'inline-flex', alignItems: 'center' }}>
        {[badgeIcon({ state, error })]}
      </span>
      {level !== null ? <BatteryIcon {...{ key: 'bat' }} level={level} /> : null}
      {showText ? <span {...{ key: 'label' }} style={{ color: C.fg3 }}>{label}</span> : null}
    </button>
  )
}

/* ── Whole page ───────────────────────────────────────────────────────── */

/** Legacy status-row table (the current page renders Tile readouts and never calls it; kept as-is). */
function statusRows(snap: StateSnapshot | null): string[][] {
  const rows: string[][] = []
  if (!snap) return rows
  const diag: Diagnostics = snap.diagnostics || {}
  const tr: TranscriberInfo = snap.transcriber || {}
  rows.push([L.rows.link, (stateText(snap.state) || snap.state || L.common.unknown) + (snap.detail ? L.common.dot + snap.detail : '')])
  if (snap.device && (snap.device.name || snap.device.id)) {
    rows.push([L.rows.device, (deviceName(snap) || L.rows.unnamed) + (snap.device.id ? L.common.dot + String(snap.device.id).slice(0, 8) : '')])
  }
  const battery = snap.battery !== null && snap.battery !== undefined ? snap.battery : diag.battery
  if (battery !== null && battery !== undefined) rows.push([L.rows.battery, battery + '%'])
  rows.push([L.rows.recognition, (tr.kind || '?') + L.common.dot + (tr.language || 'zh') + L.common.dot + String(tr.model || '').split('/').pop()!])
  if (diag.frames !== undefined) rows.push([L.rows.sessions, fmt(L.rows.sessionFrames, { sessions: String(diag.sessions || 0), frames: String(diag.frames || 0) })])
  if (diag.lastUtterance && diag.lastUtterance.text) rows.push([L.rows.lastTranscript, diag.lastUtterance.text])
  if (diag.lastError) rows.push([L.rows.lastError, String(diag.lastError)])
  rows.push([L.rows.daemon, fmt(L.rows.uptime, { pid: String(snap.pid), minutes: Math.round((snap.uptimeMs || 0) / 60000) })])
  return rows
}
void statusRows

const CODE_OPTIONS_HINT = ['Enter', 'NumpadEnter', 'Back', 'ContextMenu', 'Home', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backquote', 'F5', 'Escape', 'Space', 'AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute', 'Netflix', 'YouTube', 'InputSource', 'Power']

/* ── Remote models (/state.profileId + /state.profiles) ────────────────────
 * The two remotes (Xiaomi BT Remote 2 / Chromecast with Google TV) have entirely
 * different keys, so the "key mapping" table must render against the active model.
 * When profiles are missing (old backend / test stub) or the bridge is connected but
 * the model is not registered (profileId is null), degrade to the full key table plus
 * a registration hint.
 */
function currentProfile(snap: StateSnapshot | null): ProfileSummary | null {
  const id = snap && snap.profileId
  const list = snap && Array.isArray(snap.profiles) ? snap.profiles : null
  if (!id || !list) return null
  for (const p of list) if (p && p.id === id) return p
  return null
}

function profileKeysOf(profile: ProfileSummary | null): string[] | null {
  const keys = profile && Array.isArray(profile.keys) ? profile.keys : null
  if (!keys) return null
  return keys.filter((k, i) => typeof k === 'string' && k && keys.indexOf(k) === i)
}

/** Bridge device name for display: the active model's catalogue label wins, the backend name is the fallback. */
function deviceName(snap: StateSnapshot | null): string | null {
  const dev = snap && snap.device
  const raw = dev ? dev.name || dev.id : null
  if (!raw) return null
  const id = snap && snap.profileId ? String(snap.profileId) : ''
  return (id && L.deviceLabels[id]) || String(raw)
}

/** Model display name: the catalogue's device label wins, the backend label is the fallback. */
function profileLabel(profile: ProfileSummary | null): string {
  if (!profile) return L.page.modelUnregistered
  const id = profile.id ? String(profile.id) : ''
  return (id && L.deviceLabels[id]) || profile.label || id || ''
}

/** Action value → label (placeholder copy): strings hit the label table, phrases get "Phrase \"name\"". */
function actionLabel(action: ActionValue | null | undefined): string {
  const LABELS: Record<string, string> = {
    submit: L.actions.submit,
    stop: L.actions.stop,
    'new-session': L.actions.newSession,
    swallow: L.actions.swallow,
    none: L.actions.none,
    focus: L.actions.focus
  }
  if (!action) return ''
  if (typeof action === 'string') return LABELS[action] || action
  if (action.action === 'phrase') return fmt(L.actions.phraseQuoted, { name: String(action.name || '') })
  return ''
}

/** Placeholder copy for a model's defaultKeyMap: grey text shown only while the cell has
 *  no mapping at all. It is never written into keyMap — that is a factory suggestion, not
 *  a user choice. */
function defaultTapLabel(profile: ProfileSummary | null, code: string, tap: TapName): string {
  const entry = profile && profile.defaultKeyMap && profile.defaultKeyMap[code]
  return actionLabel(entry && entry[tap])
}

function actionOptions(phrases: Record<string, string>): SelectOption[] {
  const base: SelectOption[] = [
    { value: '', label: L.actions.noAction },
    { value: 'submit', label: L.actions.submit },
    { value: 'stop', label: L.actions.stopGenerating },
    { value: 'new-session', label: L.actions.createSession },
    { value: 'focus', label: L.actions.focus },
    { value: 'swallow', label: L.actions.swallow }
  ]
  const list = Object.keys(phrases || {}).map(name => ({ value: 'phrase:' + name, label: fmt(L.actions.phraseQuoted, { name }) }))
  return base.concat(list)
}

function actionToValue(action: ActionValue | null | undefined): string {
  if (!action) return ''
  if (typeof action === 'string') return action
  if (action.action === 'phrase') return 'phrase:' + action.name
  return ''
}

function valueToAction(value: string): ActionValue | null {
  if (!value) return null
  if (value.indexOf('phrase:') === 0) return { action: 'phrase', name: value.slice(7) }
  return value
}

async function patchConfig(patch: Partial<EditableConfig>): Promise<boolean> {
  try {
    const payload = await post<ConfigResponse>('/config', { patch })
    const next = (payload && payload.config) || {}
    if (store.snap) {
      // The backend already persisted it: merge the response back into the snapshot so selects do not snap back.
      store.snap = {
        ...store.snap,
        config: next,
        keys: { ...(store.snap.keys || {}), enabled: next.keysEnabled, map: next.keyMap, hidKeys: next.hidKeys },
        phrases: next.phrases,
        autoSend: next.autoSend,
        audio: { gapMs: next.gapMs, maxMs: next.maxMs, trimMs: next.trimMs, cutoffHz: next.cutoffHz }
      }
      applyRuntimeConfig(store.snap)
      publish()
    }
    return true
  } catch (error) {
    toast(fmt(L.toasts.saveFailed, { error: errText(error) }), 'error')
    return false
  }
}

/* ── Speech service: what local recognition runs on, and how to fix it ──── */

function SttCard() {
  const s = useStore()
  const info: SttInfo = s.stt || {}
  const summary = sttSummary(s.stt)
  const local: SttLocalInfo = info.local || {}
  const external: SttExternalInfo = info.external || {}
  const job: SttJobInfo = info.job || {}
  const running = job.state === 'running' || s.busy
  const values: EditableConfig = (s.snap && s.snap.config) || {}
  // External-service fields: base URL / model follow the daemon config until the user types
  // (same rule as Num); the API key never echoes back — GET /config masks it.
  const [baseUrl, setBaseUrl] = useState(String(values.sttBaseUrl || ''))
  const [sttModel, setSttModel] = useState(String(values.sttModel || ''))
  useEffect(() => setBaseUrl(String(values.sttBaseUrl || '')), [values.sttBaseUrl])
  useEffect(() => setSttModel(String(values.sttModel || '')), [values.sttModel])
  const lines = Array.isArray(job.lines) ? job.lines.slice(-6) : []
  const percent = Math.max(0, Math.min(100, Number(job.percent) || 0))

  const saveExternal = async (): Promise<void> => {
    // Only the non-secret fields are the page's to write: the key belongs to the credential
    // store (catalog rule 11), so the daemon never persists one that came from here.
    const patch: Partial<EditableConfig> = { sttBaseUrl: baseUrl.trim(), sttModel: sttModel.trim() }
    const ok = await patchConfig(patch)
    if (ok) {
      toast(L.stt.saved, 'info')
      refreshState()
    }
  }

  return (
    <Card
      {...{ key: 'stt' }}
      title={L.stt.card}
      hint={L.stt.cardHint}
      action={
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '2px 9px',
            borderRadius: 999,
            border: '1px solid ' + TINT(summary.readyDot, 32),
            background: TINT(summary.readyDot, 12),
            fontSize: FS.tiny,
            color: C.fg2,
            lineHeight: '16px'
          }}
        >
          <Dot {...{ key: 'd' }} tone={summary.readyDot} pulse={running} />
          <span {...{ key: 'k' }}>{summary.kindLabel}</span>
          <span {...{ key: 'r' }} style={{ color: C.fg4 }}>{info.ready ? L.stt.ready : L.stt.attention}</span>
        </span>
      }
    >
      <Field label={L.stt.engine}>
        <span style={{ fontSize: FS.small, color: summary.engineMissing ? C.orange : C.fg2 }}>{summary.engineLabel}</span>
        <Btn ghost disabled={running} onClick={() => installStt('sherpa', false)}>
          {L.stt.installEngine}
        </Btn>
      </Field>
      <Field label={L.stt.model}>
        <span
          style={{
            fontSize: FS.small,
            color: summary.needsInstall ? C.orange : C.fg2,
            maxWidth: 280,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {summary.modelLabel}
        </span>
      </Field>
      <Field label={L.stt.vad}>
        <span style={{ fontSize: FS.small, color: local.vad ? C.fg2 : C.orange }}>
          {local.vad ? fmt(L.stt.vadPresent, { name: pathBasename(local.vad) }) : L.stt.vadMissing}
        </span>
      </Field>
      <Field label={L.stt.language}>
        <span style={{ fontSize: FS.small, color: C.fg2 }}>{String(info.language || 'zh')}</span>
      </Field>
      <div {...{ key: 'dl' }} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Btn {...{ key: 'i8' }} disabled={running} onClick={() => installStt('all', false)}>
          {L.stt.download}
        </Btn>
        <Btn {...{ key: 'f32' }} disabled={running} onClick={() => installStt('all', true)}>
          {L.stt.downloadFp32}
        </Btn>
      </div>
      {job.state ? (
        <Panel {...{ key: 'job' }} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ height: 3, borderRadius: 999, background: TINT(C.fg4, 26), overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: percent + '%',
                background: job.state === 'failed' ? C.red : C.accent,
                borderRadius: 999,
                transition: 'width .2s ease'
              }}
            />
          </div>
          <div
            style={{
              fontSize: FS.tiny,
              color: job.state === 'ok' ? C.green : job.state === 'failed' ? C.red : C.fg3
            }}
          >
            {job.state === 'running'
              ? L.stt.jobRunning
              : job.state === 'ok'
                ? L.stt.jobOk
                : fmt(L.stt.jobFailed, { error: String(job.error || '') })}
          </div>
          {lines.length ? (
            <pre
              className="rm-log"
              style={{
                margin: 0,
                maxHeight: 110,
                overflow: 'auto',
                padding: '8px 10px',
                border: BORDER,
                borderRadius: 8,
                background: 'var(--ui-bg-elevated, transparent)',
                fontSize: FS.micro,
                lineHeight: '15px',
                fontFamily: MONO,
                color: C.fg3,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all'
              }}
            >
              {lines.join('\n')}
            </pre>
          ) : null}
        </Panel>
      ) : null}
      <Panel {...{ key: 'ext' }} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontSize: FS.micro, color: C.fg4, letterSpacing: '0.08em', fontWeight: 500 }}>{L.stt.external}</span>
        <Field {...{ key: 'url' }} label={L.stt.baseUrl}>
          <TextInput value={baseUrl} placeholder={L.stt.baseUrlPlaceholder} width={220} onChange={setBaseUrl} />
        </Field>
        <Field {...{ key: 'mdl' }} label={L.stt.modelField}>
          <TextInput value={sttModel} placeholder={L.stt.modelPlaceholder} width={160} onChange={setSttModel} />
        </Field>
        <Field {...{ key: 'key' }} label={L.stt.apiKey}>
          <span
            style={{
              fontSize: FS.tiny,
              color: external.keySource === 'settings' ? C.orange : external.hasKey ? C.fg3 : C.fg4,
              maxWidth: 320,
              lineHeight: 1.45
            }}
          >
            {external.keySource === 'settings'
              ? L.stt.keyLegacy
              : external.hasKey
                ? L.stt.keyFromStore
                : L.stt.keyMissing}
          </span>
        </Field>
        <div {...{ key: 'save' }} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Btn disabled={s.busy} onClick={saveExternal}>
            {L.stt.save}
          </Btn>
          <span style={{ fontSize: FS.tiny, color: C.fg4 }}>{L.stt.externalHint}</span>
        </div>
      </Panel>
    </Card>
  )
}

function RemoteMicPage() {
  const s = useStore()
  const snap = s.snap
  const values: EditableConfig = (snap && snap.config) || {}
  const phrases: Record<string, string> = (snap && snap.phrases) || {}
  const keyMap: KeyMap = (snap && snap.keys && snap.keys.map) || {}
  const profile = currentProfile(snap)
  const profileKeys = profileKeysOf(profile)
  const devicesDir = String((snap && snap.devicesDir) || '~/.hermes/baton/devices').replace(/\/+$/, '')
  // "Keys the user added by hand" leave a trace (prefs.userKeys: written when "add mapping"
  // is clicked, cleared when the row is deleted). A key in keyMap without a trace is treated
  // as legacy — an old version wrote Chromecast defaults into settings, and those entries
  // look exactly like real user config in keyMap; the trace is the only way to tell. They are
  // indistinguishable there, so only the trace can separate them.
  const userKeys = Array.isArray(prefs.userKeys) ? prefs.userKeys : []
  const isVolumeKey = (code: string): boolean => String(code).indexOf('AudioVolume') === 0
  // Rows = the current model's keys (in model order) ∪ keys the user added by hand (shown
  // greyed as "unknown / not reported by this model"). Volume keys belong to macOS (always
  // passed through): no mapping, no row; mapping, row. Legacy keys (not in the model, never
  // added by hand) are hidden entirely — Enter / InputSource never appear under Xiaomi. An
  // unknown model falls back to the old full table.
  const extraRows = profileKeys ? userKeys.filter(code => profileKeys.indexOf(code) < 0) : []
  const rowCodes = profileKeys
    ? profileKeys.filter(code => keyMap[code] || !isVolumeKey(code)).concat(extraRows)
    : Object.keys(keyMap).sort()
  const [newCode, setNewCode] = useState('')
  const [newPhrase, setNewPhrase] = useState({ name: '', text: '' })
  const [history, setHistory] = useState<HistoryEntry[] | null>(null)
  const selftest = s.selftest
  const [logs, setLogs] = useState<string[] | null>(null)
  const [devices, setDevices] = useState<CandidateDevice[] | null>(null)
  const [scanning, setScanning] = useState(false)

  const busy = s.busy
  const state = snap && snap.state

  const run = async <T,>(path: string, body?: Record<string, unknown>, opts?: PostOptions): Promise<T | null> => {
    const quiet = Boolean(opts && opts.quiet)
    store.busy = true
    publish()
    try {
      return await post<T>(path, body || {}, opts)
    } catch (error) {
      if (!quiet) toast(errText(error), 'error')
      return null
    } finally {
      store.busy = false
      publish()
      refreshState()
    }
  }

  const setMap = (code: string, tap: TapName, value: string): void => {
    const next = { ...keyMap }
    const binding: KeyBinding = { ...(next[code] || {}) }
    const action = valueToAction(value)
    if (action === null) delete binding[tap]
    else binding[tap] = action
    if (!Object.keys(binding).length) delete next[code]
    else next[code] = binding
    patchConfig({ keyMap: next })
  }

  /* Remote list: one bridge connects to one device; switching rewrites config's
     deviceId/deviceName and the backend restarts the bridge when applyPatch sees the
     change, so the page needs no extra step. */
  const scanDevices = async (): Promise<void> => {
    setScanning(true)
    try {
      const res = await api<DevicesResponse>('/devices?seconds=4', { timeoutMs: 20000 })
      const list = (res && res.devices) || []
      setDevices(list)
      toast(
        list.length ? fmt(L.toasts.devicesFound, { count: list.length }) : L.toasts.devicesNone,
        list.length ? 'info' : 'warning'
      )
    } catch (error) {
      const text = errText(error)
      // A router already mounted in the gateway is not rescanned: a /devices route added
      // before this launch keeps returning 404 until the app restarts. Fall back to the
      // daemon's cached list in /state (rescanned every 5 minutes) so "switch remote" still
      // works on an old gateway instead of degrading into "please restart".
      if (/404|not found/i.test(text)) {
        const cachedList = (snap && snap.devices) || []
        setDevices(cachedList)
        toast(
          cachedList.length
            ? fmt(L.toasts.devicesCached, { count: cachedList.length })
            : L.toasts.devicesNeedsRestart,
          'warning'
        )
      } else {
        toast(fmt(L.toasts.scanFailed, { error: text }), 'warning')
      }
    } finally {
      setScanning(false)
    }
  }

  const useDevice = async (candidate: CandidateDevice): Promise<void> => {
    const ok = await patchConfig({ deviceId: candidate.id, deviceName: candidate.name || '' })
    if (!ok) return
    toast(fmt(L.toasts.switched, { name: candidate.name || String(candidate.id).slice(0, 8) }), 'info')
    setDevices(null)
  }

  const diag: Diagnostics = (snap && snap.diagnostics) || {}
  const tr: TranscriberInfo = (snap && snap.transcriber) || {}
  const device: DeviceSummary = (snap && snap.device) || {}
  const battery = snap && snap.battery !== null && snap.battery !== undefined ? snap.battery : diag.battery
  const rivals: Competitor[] = (snap && snap.competitors) || []
  const uptimeMin = Math.round(((snap && snap.uptimeMs) || 0) / 60000)
  const uptimeText = uptimeMin >= 60
    ? Math.floor(uptimeMin / 60) + 'h ' + String(uptimeMin % 60).padStart(2, '0') + 'm'
    : uptimeMin + 'm'
  const modelName = String(tr.model || '').split('/').pop() || '—'
  const precision = String(tr.precision || '').toLowerCase()
  const activeDevice = deviceName(snap)
  const devText = activeDevice
    ? activeDevice + (device.id ? L.common.dot + String(device.id).slice(0, 8) : '')
    : L.page.noDevice
  // The daemon caches the last scan (/state.devices) so the page can list candidates as soon
  // as it opens; clicking "scan devices" just rescans immediately.
  const cachedDevices: CandidateDevice[] = (snap && snap.devices) || []
  const listed = devices !== null ? devices : (cachedDevices.length ? cachedDevices : null)
  const tone = s.error ? C.red : stateTone(state)
  const stateLabel = s.error ? L.page.backendNotConnected : stateText(state) || String(state || '…')
  const detailText = snap && snap.detail ? (snap.detail === 'remote' ? L.page.remoteTriggered : String(snap.detail)) : ''
  const live = state === 'capturing' || state === 'transcribing'

  const notice = (t: string, extra?: CSSProperties): CSSProperties => ({
    border: '1px solid ' + TINT(t, 36),
    background: TINT(t, 10),
    borderRadius: 9,
    padding: '9px 12px',
    fontSize: FS.small,
    color: C.fg2,
    lineHeight: '18px',
    ...(extra || {})
  })
  const TH: CSSProperties = { fontSize: FS.micro, color: C.fg4, letterSpacing: '0.08em', fontWeight: 500 }
  const delBtn: CSSProperties = { padding: '0 8px', minHeight: 24, borderRadius: 6, border: BORDER, background: 'transparent', color: C.fg4, fontSize: 13, fontFamily: 'inherit', cursor: 'pointer', lineHeight: '20px' }

  return (
    <div
      className="rm-page"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        padding: '22px 26px 56px',
        color: C.fg,
        fontSize: FS.lead,
        overflowY: 'auto',
        height: '100%'
      }}
    >
      <div {...{ key: 'wrap' }} style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1180, width: '100%' }}>
        {/* ── Header: icon + state + device/engine in one line, actions on the right ── */}
        <header {...{ key: 'h' }} style={{ display: 'flex', alignItems: 'center', gap: 13, flexWrap: 'wrap', paddingBottom: 4 }}>
          <div
            {...{ key: 'ic' }}
            style={{
              width: 38,
              height: 38,
              borderRadius: 11,
              border: '1px solid ' + TINT(tone, 30),
              background: TINT(tone, 10),
              color: tone,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0
            }}
          >
            <MicGlyph />
          </div>
          <div {...{ key: 't' }} style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <div {...{ key: 'l1' }} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <h1 style={{ margin: 0, fontSize: FS.title, fontWeight: 650, letterSpacing: '-0.015em', lineHeight: '24px' }}>{L.plugin.name}</h1>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '2px 9px',
                  borderRadius: 999,
                  border: '1px solid ' + TINT(tone, 32),
                  background: TINT(tone, 12),
                  fontSize: FS.tiny,
                  color: C.fg2,
                  lineHeight: '16px'
                }}
              >
                <Dot {...{ key: 'd' }} tone={tone} pulse={live} />
                <span {...{ key: 's' }}>{stateLabel}</span>
                {detailText ? <span {...{ key: 'x' }} style={{ color: C.fg4 }}>{'· ' + detailText}</span> : null}
              </span>
            </div>
            <span
              {...{ key: 'l2' }}
              style={{ fontSize: FS.small, color: C.fg3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {fmt(L.page.subtitle, { device: devText, language: String(tr.language || 'zh'), model: modelName }) + (precision ? L.common.dot + precision : '')}
            </span>
          </div>
          <span {...{ key: 'sp' }} style={{ flex: 1 }} />
          <div {...{ key: 'act' }} style={{ display: 'flex', gap: 8 }}>
            <Btn {...{ key: 'r' }} onClick={() => run('/restart')} disabled={busy} title={L.page.reconnectTitle}>{L.page.reconnect}</Btn>
            <Btn {...{ key: 's' }} onClick={() => run(state === 'stopped' ? '/start' : '/stop')} disabled={busy}>
              {state === 'stopped' ? L.page.startListening : L.page.stopListening}
            </Btn>
          </div>
        </header>

        {s.error ? (
          <div {...{ key: 'err' }} style={notice(C.red)}>
            {fmt(L.page.backendDown, { error: s.error })}
          </div>
        ) : null}

        {rivals.length > 0 ? (
          <div {...{ key: 'rival' }} style={notice(C.orange)}>
            {fmt(L.page.rival, { pids: rivals.map(c => c.pid).join(L.common.listSeparator) })}
          </div>
        ) : null}

        {/* ── Link: one row of readings + one row of actions ── */}
        <Card
          {...{ key: 'status' }}
          title={L.cards.link}
          tone={tone}
          dense
          action={
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <Btn
                {...{ key: 'bt' }}
                ghost
                title={L.page.bluetoothTitle}
                onClick={async () => {
                  // Prefer the backend route (lands straight on the Bluetooth panel). A router
                  // already mounted in the gateway is not rescanned, so the route only exists
                  // after a gateway restart; when it is gone, launch System Settings itself
                  // rather than leaving the user staring at a 404.
                  const opened = await run<OkResponse>('/open/settings', { pane: 'bluetooth' }, { quiet: true })
                  if (opened) {
                    toast(L.toasts.settingsOpened, 'info')
                    return
                  }
                  const launched = await openSystemSettingsApp()
                  toast(
                    launched
                      ? L.toasts.settingsLaunched
                      : L.toasts.settingsManual,
                    launched ? 'info' : 'warning'
                  )
                }}
              >
                {L.page.buttons.bluetooth}
              </Btn>
              <Btn
                {...{ key: 'mock' }}
                ghost
                title={L.page.mockTitle}
                disabled={busy}
                onClick={async () => {
                  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false })
                  const result = await run<MockTranscriptResponse>('/mock/transcript', { text: fmt(L.page.mockText, { stamp }) })
                  if (result && result.transcript) {
                    store.selftest = null
                    publish()
                  }
                }}
              >
                {L.page.buttons.mock}
              </Btn>
              <Btn
                {...{ key: 'self' }}
                ghost
                onClick={() => runSelftest()}
                disabled={busy}
              >
                {busy ? L.common.running : L.page.buttons.selftest}
              </Btn>
              <Btn
                {...{ key: 'listen' }}
                ghost
                active={listenWin.phase === 'waiting' || listenWin.phase === 'capturing' || listenWin.phase === 'transcribing'}
                title={L.page.listenTitle}
                onClick={() => startListenWindow(15000)}
              >
                {listenWin.phase === 'waiting' || listenWin.phase === 'capturing' || listenWin.phase === 'transcribing'
                  ? fmt(L.page.listenActive, { remain: listenRemain() })
                  : L.page.listenButton}
              </Btn>
            </div>
          }
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(172px, 1fr))', columnGap: 18, rowGap: 14 }}>
            <Tile {...{ key: 'st' }} label={L.tiles.linkState}>
              <span style={{ fontSize: FS.metric, fontWeight: 600, letterSpacing: '-0.01em' }}>{stateLabel}</span>
              {detailText || (live ? L.tiles.live : L.tiles.standby)}
            </Tile>
            <Tile
              {...{ key: 'bt' }}
              label={L.tiles.battery}
              divider
              sub={battery === null || battery === undefined ? L.tiles.batteryUnknown : battery <= 20 ? L.tiles.batteryReplace : battery <= 45 ? L.tiles.batteryLow : L.tiles.batteryFull}
            >
              {battery === null || battery === undefined
                ? [<span {...{ key: 'v' }} style={{ fontSize: FS.metric, fontWeight: 600 }}>{'—'}</span>]
                : [
                    <BatteryIcon {...{ key: 'i' }} level={battery} />,
                    <span {...{ key: 'v' }} style={{ fontSize: FS.metric, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{battery + '%'}</span>
                  ]}
            </Tile>
            <Tile
              {...{ key: 'asr' }}
              label={L.tiles.engine}
              divider
              sub={modelName + (precision ? ' · ' + precision : '')}
            >
              <span {...{ key: 'v' }} style={{ fontSize: FS.metric, fontWeight: 600 }}>{String(tr.kind || 'sensevoice')}</span>
              <span {...{ key: 'l' }} style={{ fontSize: FS.tiny, color: C.fg4 }}>{String(tr.language || 'zh')}</span>
            </Tile>
            <Tile
              {...{ key: 'ses' }}
              label={L.tiles.sessions}
              divider
              sub={fmt(L.tiles.frames, { frames: String(diag.frames || 0) })}
            >
              <span {...{ key: 'v' }} style={{ fontSize: FS.metric, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{String(diag.sessions || 0)}</span>
              <span {...{ key: 'u' }} style={{ fontSize: FS.tiny, color: C.fg4 }}>{fmt(L.tiles.calls, { calls: String(tr.calls || 0) })}</span>
            </Tile>
            <Tile
              {...{ key: 'pid' }}
              label={L.tiles.daemon}
              divider
              sub={tr.loadMs ? fmt(L.tiles.modelLoad, { ms: tr.loadMs }) : ''}
            >
              <span {...{ key: 'v' }} style={{ fontSize: FS.metric, fontWeight: 600, fontFamily: MONO }}>{snap ? 'pid ' + snap.pid : L.tiles.notStarted}</span>
              {uptimeText}
            </Tile>
          </div>

          {listenWin.phase !== 'idle' ? (
            <div
              style={notice(
                listenWin.phase === 'done' ? C.green : listenWin.phase === 'error' ? C.red : listenWin.phase === 'timeout' ? C.orange : C.accent
              )}
            >
              {listenWin.phase === 'waiting'
                ? (listenWin.note ? listenWin.note + L.common.fullWidthSpace : '') + fmt(L.listen.waiting, { remain: listenRemain() })
                : listenWin.phase === 'capturing'
                  ? fmt(L.listen.capturing, { remain: listenRemain() })
                  : listenWin.phase === 'transcribing'
                    ? L.listen.transcribing
                    : listenWin.phase === 'done'
                      ? fmt(L.listen.done, { text: listenWin.text, inference: fmtSec(listenWin.entry && listenWin.entry.inferenceSeconds), audio: fmtSec(listenWin.entry && listenWin.entry.audioSeconds) })
                      : listenWin.phase === 'timeout'
                        ? L.listen.timeout
                        : fmt(L.listen.error, { reason: listenWin.note || L.listen.unknownReason })}
            </div>
          ) : null}

          {selftest
            ? (() => {
                // An empty result must not turn green as "success (empty)": that would lie about the model.
                const text = String(selftest.text || '')
                const t = text ? C.green : C.orange
                const note = text
                  ? ''
                  : selftest.fellBack
                    ? L.selftest.fellBack
                    : L.selftest.emptyNote
                return (
                  <div style={notice(t)}>
                    {text
                      ? fmt(L.selftest.result, { text, inference: fmtSec(selftest.inferenceSeconds), audio: fmtSec(selftest.audioSeconds) })
                      : fmt(L.selftest.empty, { audio: fmtSec(selftest.audioSeconds) }) + note}
                  </div>
                )
              })()
            : null}
        </Card>

        {/* ── Remotes: discover and switch between devices ── */}
        <Card
          {...{ key: 'devices' }}
          title={L.cards.devices}
          hint={L.cards.devicesHint}
          action={<Btn {...{ key: 'scan' }} ghost disabled={scanning} onClick={scanDevices}>{scanning ? L.common.scanning : L.page.buttons.scan}</Btn>}
        >
          <div {...{ key: 'cur' }} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Dot {...{ key: 'd' }} tone={tone} />
            <span {...{ key: 'n' }} style={{ fontSize: FS.lead, fontWeight: 600 }}>{activeDevice || L.page.noDevice}</span>
            {device.id ? (
              <span {...{ key: 'i' }} style={{ fontSize: FS.tiny, color: C.fg4, fontFamily: MONO }}>{String(device.id).slice(0, 8)}</span>
            ) : null}
            {battery !== null && battery !== undefined ? (
              <span {...{ key: 'b' }} style={{ fontSize: FS.tiny, color: C.fg3 }}>{fmt(L.chip.battery, { level: battery })}</span>
            ) : null}
          </div>
          <div {...{ key: 'model' }} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span {...{ key: 'l' }} style={{ fontSize: FS.micro, color: C.fg4, letterSpacing: '0.08em', fontWeight: 500 }}>{L.page.modelLabel}</span>
            <span {...{ key: 'v' }} style={{ fontSize: FS.small, color: profile ? C.fg : C.fg3 }}>
              {profile ? profileLabel(profile) + (profile.vendor ? L.common.dot + profile.vendor : '') : L.page.modelUnregistered}
            </span>
            {profile && profile.voiceHint ? (
              <span {...{ key: 'h' }} style={{ fontSize: FS.small, color: C.fg3 }}>{String(profile.voiceHint)}</span>
            ) : null}
          </div>
          {!profile ? (
            <div {...{ key: 'reg' }} style={{ fontSize: FS.small, color: C.fg4, lineHeight: '17px' }}>
              {fmt(L.page.registerHint, { dir: devicesDir })}
            </div>
          ) : null}
          {listed === null ? (
            <div {...{ key: 'hint' }} style={{ fontSize: FS.small, color: C.fg4 }}>
              {L.page.scanHint}
            </div>
          ) : listed.length === 0 ? (
            <div {...{ key: 'none' }} style={{ fontSize: FS.small, color: C.fg3 }}>
              {L.page.noCandidates}
            </div>
          ) : (
            <div
              {...{ key: 'list' }}
              style={{
                display: 'flex', flexDirection: 'column',
                border: BORDER, borderRadius: 9, background: 'var(--ui-bg-elevated, transparent)', overflow: 'hidden'
              }}
            >
              {listed.map((candidate, index) => {
                const active = Boolean(device.id) && candidate.id === device.id
                return (
                  <div
                    {...{ key: candidate.id }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
                      borderTop: index ? BORDER : 'none'
                    }}
                  >
                    <Dot {...{ key: 'd' }} tone={active ? C.green : candidate.connected ? C.fg3 : C.orange} />
                    <span
                      {...{ key: 'n' }}
                      style={{ fontSize: FS.small, color: C.fg, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {candidate.name || L.page.unnamedDevice}
                    </span>
                    <span {...{ key: 's' }} style={{ fontSize: FS.tiny, color: C.fg4 }}>{candidate.connected ? L.page.connected : L.page.connectable}</span>
                    {active ? (
                      <span {...{ key: 'on' }} style={{ fontSize: FS.tiny, color: C.green }}>{L.page.inUse}</span>
                    ) : (
                      <Btn {...{ key: 'u' }} ghost disabled={busy} onClick={() => useDevice(candidate)}>{L.page.buttons.switch}</Btn>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </Card>

        {/* ── Speech service: local SenseVoice setup + external STT ── */}
        <SttCard {...{ key: 'stt' }} />

        {/* ── Two columns: voice delivery / canned phrases ── */}
        <div
          {...{ key: 'row2' }}
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(370px, 1fr))', gap: 14, alignItems: 'stretch' }}
        >
          <Card
            {...{ key: 'voice' }}
            title={L.cards.voice}
            hint={L.cards.voiceHint}
          >
            <Field
              label={L.fields.afterRecognition}
              hint={values.autoSend ? L.fields.afterRecognitionAuto : L.fields.afterRecognitionManual}
            >
              <Toggle
                on={Boolean(values.autoSend)}
                onChange={on => patchConfig({ autoSend: on })}
                labels={[L.toggles.directSend, L.toggles.insertOnly]}
              />
            </Field>
            <Field label={L.fields.insertMode}>
              <Segmented
                value={prefs.insertMode}
                options={[{ value: 'inline', label: L.fields.insertInline }, { value: 'block', label: L.fields.insertBlock }]}
                onChange={v => savePrefs({ insertMode: v })}
              />
            </Field>
            <Field label={L.fields.notifyAfterInsert}>
              <Toggle
                on={Boolean(prefs.notifyTranscript)}
                onChange={on => savePrefs({ notifyTranscript: on })}
                labels={[L.toggles.notify, L.toggles.silent]}
              />
            </Field>
            <Field label={L.fields.autoConnect} hint={L.fields.autoConnectHint}>
              <Toggle
                on={values.autoStart !== false}
                onChange={on => patchConfig({ autoStart: on })}
              />
            </Field>
            <Field label={L.fields.autoReconnect} hint={L.fields.autoReconnectHint}>
              <Toggle
                on={values.autoRestart !== false}
                onChange={on => patchConfig({ autoRestart: on })}
              />
            </Field>
          </Card>

          <Card
            {...{ key: 'phrases' }}
            title={L.cards.phrases}
            hint={L.cards.phrasesHint}
          >
            <div
              {...{ key: 'list' }}
              style={{
                display: 'flex', flexDirection: 'column', flex: '0 1 auto', maxHeight: 220,
                border: BORDER, borderRadius: 9, background: 'var(--ui-bg-elevated, transparent)',
                overflowY: 'auto'
              }}
            >
              {Object.keys(phrases).length === 0
                ? [
                    <div
                      {...{ key: 'empty' }}
                      style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '18px 0' }}
                    >
                      <Empty>{L.phrases.empty}</Empty>
                    </div>
                  ]
                : Object.keys(phrases).map((name, i) => (
                    <div
                      {...{ key: 'p-' + name }}
                      style={{
                        display: 'grid', gridTemplateColumns: '96px minmax(0,1fr) auto', gap: 8, alignItems: 'center',
                        padding: '7px 10px', borderTop: i ? BORDER : 'none'
                      }}
                    >
                      <div {...{ key: 'n' }} style={{ overflow: 'hidden' }}>
                        <Keycap>{name}</Keycap>
                      </div>
                      <TextInput {...{ key: 't' }} value={phrases[name]} width="100%" onChange={v => patchConfig({ phrases: { ...phrases, [name]: v } })} />
                      <button
                        {...{ key: 'x' }}
                        type="button"
                        title={L.phrases.deleteTitle}
                        onClick={() => { const next = { ...phrases }; delete next[name]; patchConfig({ phrases: next }) }}
                        style={delBtn}
                      >
                        {'×'}
                      </button>
                    </div>
                  ))}
            </div>
            <div {...{ key: 'add' }} style={{ display: 'grid', gridTemplateColumns: '96px minmax(0,1fr) auto', gap: 8, alignItems: 'center', marginTop: 'auto' }}>
              <TextInput {...{ key: 'n' }} value={newPhrase.name} placeholder={L.phrases.namePlaceholder} width="100%" onChange={v => setNewPhrase({ ...newPhrase, name: v })} />
              <TextInput {...{ key: 't' }} value={newPhrase.text} placeholder={L.phrases.textPlaceholder} width="100%" onChange={v => setNewPhrase({ ...newPhrase, text: v })} />
              <Btn
                {...{ key: 'b' }}
                disabled={!newPhrase.name.trim() || !newPhrase.text.trim()}
                onClick={() => {
                  const name = newPhrase.name.trim()
                  patchConfig({ phrases: { ...phrases, [name]: newPhrase.text.trim() } })
                  setNewPhrase({ name: '', text: '' })
                }}
              >
                {L.page.buttons.add}
              </Btn>
            </div>
          </Card>
        </div>

        {/* ── Key mapping: one key table, not a pile of selects ── */}
        <Card
          {...{ key: 'keys' }}
          title={L.cards.keys}
          action={<Toggle on={Boolean(values.keysEnabled)} onChange={on => patchConfig({ keysEnabled: on })} />}
          hint={profileKeys && profile
            ? fmt(L.keys.hintProfile, { label: profileLabel(profile), hint: profile.voiceHint ? String(profile.voiceHint) : '' })
            : fmt(L.keys.hintGeneric, { dir: devicesDir })}
        >
          {rowCodes.length === 0
            ? (
                <Empty>
                  {profileKeys
                    ? L.keys.emptyProfile
                    : L.keys.emptyAll}
                </Empty>
              )
            : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <div
                    style={{ display: 'grid', gridTemplateColumns: '132px repeat(3, minmax(0,1fr)) 30px', gap: 10, padding: '0 6px 4px' }}
                  >
                    <span {...{ key: 'k' }} style={TH}>{L.keys.tableKey}</span>
                    <span {...{ key: 's' }} style={TH}>{L.keys.single}</span>
                    <span {...{ key: 'd' }} style={TH}>{L.keys.double}</span>
                    <span {...{ key: 'l' }} style={TH}>{L.keys.long}</span>
                    <span {...{ key: 'x' }} />
                  </div>
                  {rowCodes.map(code => {
                    const binding = keyMap[code] || {}
                    const options = actionOptions(phrases)
                    // Keys absent from the model were added by hand: tag them "unknown" and grey them; never drop user config.
                    const unknown = Boolean(profileKeys) && profileKeys!.indexOf(code) < 0
                    // defaultKeyMap is a placeholder only while the whole key has no mapping (grey "Default: X"); never written to keyMap.
                    const hasMapping = Boolean(keyMap[code])
                    const tapCell = (name: TapName, key: string) => {
                      const placeholder = hasMapping ? '' : defaultTapLabel(profile, code, name)
                      return (
                        <Select
                          {...{ key }}
                          value={actionToValue(binding[name])}
                          options={placeholder ? [{ value: '', label: fmt(L.keys.defaultPrefix, { label: placeholder }) }].concat(options.slice(1)) : options}
                          onChange={v => setMap(code, name, v)}
                          style={placeholder ? { color: C.fg4 } : undefined}
                        />
                      )
                    }
                    return (
                      <div
                        {...{ key: 'map-' + code }}
                        className="rm-row"
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '132px repeat(3, minmax(0,1fr)) 30px',
                          gap: 10,
                          alignItems: 'center',
                          padding: '5px 6px',
                          borderRadius: 8,
                          opacity: unknown ? 0.72 : 1
                        }}
                      >
                        <div {...{ key: 'c' }} style={{ minWidth: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                          <Keycap>{code}</Keycap>
                          {unknown ? (
                            <span
                              {...{ key: 'u' }}
                              title={L.keys.unknownTitle}
                              style={{ fontSize: FS.micro, color: C.fg3, border: BORDER, borderRadius: 999, padding: '0 6px', lineHeight: '15px', whiteSpace: 'nowrap' }}
                            >
                              {L.keys.unknown}
                            </span>
                          ) : null}
                          {unknown ? (
                            <span {...{ key: 'g' }} style={{ fontSize: FS.micro, color: C.fg4, lineHeight: '12px', width: '100%' }}>{L.keys.notReported}</span>
                          ) : null}
                        </div>
                        {tapCell('single', 's')}
                        {tapCell('double', 'd')}
                        {tapCell('long', 'l')}
                        {hasMapping || unknown
                          ? (
                              <button
                                {...{ key: 'x' }}
                                type="button"
                                title={L.keys.deleteTitle}
                                onClick={() => {
                                  const next = { ...keyMap }
                                  delete next[code]
                                  patchConfig({ keyMap: next })
                                  if (userKeys.indexOf(code) >= 0) savePrefs({ userKeys: userKeys.filter(c => c !== code) })
                                }}
                                style={delBtn}
                              >
                                {'×'}
                              </button>
                            )
                          : <span {...{ key: 'x' }} />}
                      </div>
                    )
                  })}
                </div>
              )}
          <div {...{ key: 'add' }} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 4, borderTop: BORDER }}>
            <Select
              {...{ key: 'sel' }}
              value={newCode}
              options={[{ value: '', label: L.keys.selectPlaceholder }].concat(
                (profileKeys ? profileKeys.filter(code => !keyMap[code]) : CODE_OPTIONS_HINT)
                  .map(code => ({ value: code, label: code }))
              )}
              onChange={setNewCode}
            />
            <Btn
              {...{ key: 'b' }}
              disabled={!newCode}
              onClick={() => {
                const next = { ...keyMap, [newCode]: { single: 'submit' } }
                // Keys absent from the model leave a trace (prefs.userKeys): the only proof
                // that "the user added this". An untraced keyMap entry counts as legacy and is
                // hidden under other models.
                if (userKeys.indexOf(newCode) < 0) savePrefs({ userKeys: userKeys.concat([newCode]) })
                patchConfig({ keyMap: next })
                setNewCode('')
              }}
            >
              {L.keys.addMapping}
            </Btn>
            <span {...{ key: 'dbl' }} style={{ fontSize: FS.tiny, color: C.fg4 }}>
              {fmt(L.keys.timing, { double: snap && snap.keys ? snap.keys.doubleMs : 300, long: snap && snap.keys ? snap.keys.longMs : 550 })}
            </span>
          </div>
          <Panel style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Field
              {...{ key: 'filter' }}
              label={L.fields.keyFilter}
              hint={L.fields.keyFilterHint}
            >
              <Select
                value={values.keyFilter || 'active'}
                options={[{ value: 'active', label: L.fields.keyFilterActive }, { value: 'any', label: L.fields.keyFilterAny }]}
                onChange={v => patchConfig({ keyFilter: v })}
              />
            </Field>
            <Field
              {...{ key: 'cap' }}
              label={L.fields.capture}
              hint={L.fields.captureHint + (profile && Array.isArray(profile.hidKeys) && profile.hidKeys.length
                    ? fmt(L.fields.captureHintHid, { keys: profile.hidKeys.join(' + ') })
                    : L.fields.captureHintDefault)}
            >
              <Toggle
                on={Boolean(prefs.capture)}
                onChange={on => savePrefs({ capture: on })}
              />
            </Field>
          </Panel>
        </Card>

        {/* ── Two columns: capture settings / transcript history ── */}
        <div
          {...{ key: 'row3' }}
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(370px, 1fr))', gap: 14, alignItems: 'stretch' }}
        >
          <Card
            {...{ key: 'audio' }}
            title={L.cards.audio}
            hint={L.cards.audioHint}
          >
            <Field
              label={L.fields.precision}
              hint={values.precision === 'fp32'
                ? L.fields.precisionFp32
                : L.fields.precisionInt8}
            >
              <Segmented
                value={values.precision === 'fp32' ? 'fp32' : 'int8'}
                options={[{ value: 'int8', label: 'int8' }, { value: 'fp32', label: 'fp32' }]}
                onChange={v => patchConfig({ precision: v })}
              />
            </Field>
            <Field label={L.fields.gap} hint={L.fields.gapHint}>
              <Num value={values.gapMs || 350} min={150} max={2000} step={50} suffix="ms" onCommit={v => patchConfig({ gapMs: v })} />
            </Field>
            <Field label={L.fields.max} hint={L.fields.maxHint}>
              <Num value={values.maxMs || 30000} min={3000} max={120000} step={1000} suffix="ms" onCommit={v => patchConfig({ maxMs: v })} />
            </Field>
            <Field label={L.fields.trim} hint={L.fields.trimHint}>
              <Num value={values.trimMs === undefined ? 200 : values.trimMs} min={0} max={800} step={20} suffix="ms" onCommit={v => patchConfig({ trimMs: v })} />
            </Field>
            <Field label={L.fields.cutoff} hint={L.fields.cutoffHint}>
              <Num value={values.cutoffHz === undefined ? 100 : values.cutoffHz} min={0} max={400} step={10} suffix="Hz" onCommit={v => patchConfig({ cutoffHz: v })} />
            </Field>
            <Field label={L.fields.language} hint={L.fields.languageHint}>
              <Select
                value={values.language || 'zh'}
                options={['zh', 'en', 'ja', 'ko', 'yue'].map(v => ({ value: v, label: v }))}
                onChange={v => patchConfig({ language: v })}
                style={{ width: 96 }}
              />
            </Field>
          </Card>

          <Card
            {...{ key: 'history' }}
            title={L.cards.history}
            hint={L.cards.historyHint}
            action={
              <div style={{ display: 'flex', gap: 6 }}>
                <Toggle {...{ key: 't' }} on={Boolean(values.history)} onChange={on => patchConfig({ history: on })} />
                <Btn
                  {...{ key: 'l' }}
                  ghost
                  onClick={async () => {
                    try {
                      const payload = await api<HistoryResponse>('/history?limit=50')
                      setHistory((payload && payload.entries) || [])
                    } catch (error) {
                      toast(fmt(L.history.loadFailed, { error: errText(error) }), 'error')
                    }
                  }}
                >
                  {L.page.buttons.load}
                </Btn>
                {history ? (
                  <Btn
                    {...{ key: 'c' }}
                    ghost
                    onClick={async () => {
                      try {
                        await api('/history', { method: 'DELETE' })
                        setHistory([])
                      } catch (error) {
                        toast(fmt(L.history.clearFailed, { error: errText(error) }), 'error')
                      }
                    }}
                  >
                    {L.page.buttons.clear}
                  </Btn>
                ) : null}
              </div>
            }
          >
            {(() => {
              const rows = history || store.transcripts
              const sliced = rows.slice(0, history ? 50 : 8)
              if (!sliced.length) {
                return (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px 0' }}>
                    <Empty>
                      {values.history
                        ? L.history.emptyEnabled
                        : L.history.emptyDisabled}
                    </Empty>
                  </div>
                )
              }
              return (
                <div
                  style={{
                    display: 'flex', flexDirection: 'column', gap: 0, flex: 1, minHeight: 120,
                    maxHeight: history ? 240 : 220, overflowY: 'auto',
                    border: BORDER, borderRadius: 9, background: 'var(--ui-bg-elevated, transparent)'
                  }}
                >
                  {sliced.map((entry, i) => (
                    <div
                      {...{ key: 'h' + i }}
                      style={{
                        display: 'grid', gridTemplateColumns: '46px minmax(0,1fr) auto', gap: 10, alignItems: 'baseline',
                        padding: '6px 10px',
                        borderTop: i ? BORDER : 'none'
                      }}
                    >
                      <span {...{ key: 't' }} style={{ color: C.fg4, fontFamily: MONO, fontSize: FS.micro }}>
                        {new Date(entry.at || Date.now()).toTimeString().slice(0, 5)}
                      </span>
                      <span {...{ key: 'x' }} style={{ color: C.fg2, fontSize: FS.body, wordBreak: 'break-word' }}>{entry.text}</span>
                      {entry.audioSeconds ? (
                        <span {...{ key: 'd' }} style={{ color: C.fg4, fontSize: FS.micro, fontVariantNumeric: 'tabular-nums' }}>{fmtSec(entry.audioSeconds) + 's'}</span>
                      ) : (
                        <span {...{ key: 'd' }} />
                      )}
                    </div>
                  ))}
                </div>
              )
            })()}
          </Card>
        </div>

        {/* ── Log: full width, small monospace text inside an inset panel ── */}
        <Card
          {...{ key: 'logs' }}
          title={L.cards.logs}
          dense
          action={
            <Btn
              ghost
              onClick={async () => {
                try {
                  const payload = await api<LogsResponse>('/logs?lines=60')
                  setLogs((payload && payload.logs) || [])
                } catch (error) {
                  toast(fmt(L.logs.loadFailed, { error: errText(error) }), 'error')
                }
              }}
            >
              {L.page.buttons.refresh}
            </Btn>
          }
        >
          <pre
            className="rm-log"
            style={{
              margin: 0,
              maxHeight: 260,
              overflow: 'auto',
              padding: '10px 12px',
              border: BORDER,
              borderRadius: 9,
              background: 'var(--ui-bg-elevated, transparent)',
              fontSize: FS.tiny,
              lineHeight: '17px',
              fontFamily: MONO,
              color: C.fg3,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all'
            }}
          >
            {logs ? logs.join('\n') : (snap && snap.logs ? snap.logs.join('\n') : L.logs.empty)}
          </pre>
        </Card>
      </div>
    </div>
  )
}

/* ── Registration ─────────────────────────────────────────────────────── */

const plugin = {
  id: ID,
  // Provisional: the module body runs before prefs are readable, so `register()` refreshes these
  // two from the resolved locale below.
  name: L.plugin.name,
  description: L.plugin.description,
  register(ctx: PluginContext) {
    CTX = ctx
    REST = (path: string, options?: PluginRestOptions) => ctx.rest(path, options)
    readPrefs()
    plugin.name = L.plugin.name
    plugin.description = L.plugin.description
    applyRuntimeConfig(store.snap)

    ctx.register({ id: 'nav', area: 'sidebar.nav', data: { codicon: 'mic', label: L.nav.title, path: ROUTE } })

    ctx.register({
      id: 'page',
      area: 'routes',
      title: L.plugin.name,
      data: { path: ROUTE },
      render: () => <RemoteMicPage />
    })

    ctx.register({
      id: 'palette',
      area: 'palette',
      order: 235,
      data: {
        id: 'baton.open',
        label: L.palette.title,
        keywords: L.palette.keywords,
        run: () => host.navigate(ROUTE)
      }
    })

    ctx.register({ id: 'chip', area: 'statusBar.right', order: 120, render: () => <Chip /> })

    // Both paths must be active as soon as the plugin loads: they do not depend on the page being open.
    ctx.addEventListener(window, 'keydown', event => onDomKey(event, true), true)
    ctx.addEventListener(window, 'keyup', event => onDomKey(event, false), true)

    ctx.onDispose(() => {
      timers.forEach(id => clearTimeout(id))
      timers.clear()
      engine.states = {}
    })

    startPolling()
    refreshState()
    // One load marker: the desktop log confirms this plugin really was loaded by the renderer log (only failures log by themselves).
    try {
      console.info('[baton] plugin loaded')
    } catch {
      /* console being unavailable is not a failure */
    }
  }
} satisfies HermesPlugin

export default plugin
