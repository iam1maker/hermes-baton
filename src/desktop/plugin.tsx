/**
 * baton（指挥）— 蓝牙语音遥控器的桌面端：语音落地、按键映射、多型号切换。
 *
 * 分工（重要）：
 *   - 蓝牙链路、ATVV/ADPCM 解帧、本地 SenseVoice 识别，全在 Node 守护进程里
 *     （plugins/baton/sidecar/server.mjs），由 Python 侧 runtime.py 拉起；
 *   - 本文件只做两件渲染进程内才能做的事：
 *       1) 把转写文本插进「当前输入框」——必须走 host.composer 的焦点总线，
 *          只有挂载中的 composer 能应答，任何跨进程方案都会插到别的会话里；
 *       2) 把遥控器按键变成动作（提交/停止/新会话/常用语），同样必须在本进程执行。
 *
 * 按键两条通路，别混：
 *   - 桥通路：守护进程 hid-watch 报上来的键（Back / ContextMenu / 媒体键），
 *     DOM 拿不到，走 /events 轮询（400ms），用事件自带的 at 时间戳做单击/双击/长按判定，
 *     所以轮询延迟不影响判定精度。
 *   - DOM 通路：遥控器同时是 HID 键盘，Enter/Home 这类键原生会到窗口，
 *     默认不拦截——Enter 本来就能提交，没有额外映射的必要。
 *     要接管这些键必须显式打开「捕获键盘」，代价是普通键盘的同名键也一起被接管。
 *
 * 约束：只能 import @hermes/plugin-sdk / react（react/jsx-runtime 由 esbuild 自动引入）；
 * 源码是 TSX，构建打成单文件 desktop/plugin.js；Tailwind 是构建期固定集合，样式走 inline style。
 *
 * key 一律写成 `{...{ key: … }}` 展开、不用 JSX 的 key 属性：测试桩的 react/jsx-runtime
 * （tests/node_modules/react/jsx-runtime.js）把 key 留在 props 里供渲染树断言，真实
 * runtime 也照常从 props 里提取 key 当元素 key——两条通路都与旧版 h() 行为一致。
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

/* ── REST 响应结构（照 sidecar/server.mjs 各路由的 JSON 形状写，字段全部可选） ── */

/** 动作值：字符串动作名，或常用语对象 { action:'phrase', name }。 */
type ActionValue = string | { action: string; name?: string }
type TapName = 'single' | 'double' | 'long'
interface KeyBinding {
  single?: ActionValue
  double?: ActionValue
  long?: ActionValue
}
type KeyMap = Record<string, KeyBinding>

/** POST /config 与 /state.config 的可编辑配置（server.mjs 的 editable()）。 */
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

/** /state.profiles[]（server.mjs 的 describeRegistry()）。 */
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

/** /state.diagnostics（vendor/plugin/service.js 的 get diagnostics()）。 */
interface LastUtterance {
  frames?: number
  durationMs?: number
  coverage?: number
  reason?: string
  /** 页面读「上次转写」用；当前服务端不写这个字段（见移植报告的行为风险）。 */
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

/** /state.transcriber（server.mjs 的 transcriber 段 + stt/sensevoice.mjs 的 info）。 */
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

/** GET /devices 的候选设备与 /state.devices[]（server.mjs 的 listDevices()）。 */
interface CandidateDevice {
  id?: string
  name?: string
  connected?: boolean
}

/** GET /state（server.mjs 的 snapshot()）。 */
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

/** /events 的事件体（server.mjs 的 pushEvent()；payload 按事件类型共用一个形状）。 */
interface EventPayload {
  text?: string
  at?: number
  audioSeconds?: number
  inferenceSeconds?: number
  code?: string
  down?: boolean
  state?: string
  detail?: string | null
  message?: string
  kind?: string
  selftest?: boolean
}
interface DaemonEvent {
  seq?: number
  type?: string
  at?: number
  payload?: EventPayload
}

/** GET /events。 */
interface EventsResponse {
  pid?: number
  bootAt?: number
  cursor?: number
  head?: number
  events?: DaemonEvent[]
}

/** /devices?seconds= 的响应：扫描到的候选遥控器 + 当前生效设备。 */
interface DevicesResponse {
  devices?: CandidateDevice[]
  current?: DeviceSummary | null
  at?: number
}

/** /history 的一行（history.jsonl：{text, at, audioSeconds}）。 */
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

/** /selftest 与 /mock/transcript 的转写条目。 */
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

/** /open/settings、/restart、/start、/stop 的通用成功体。 */
interface OkResponse {
  ok?: boolean
  state?: string
  pane?: string
}

/** 转写条目落进 store.transcripts（页面展示用）。 */
interface TranscriptItem {
  text: string
  at: number
  audioSeconds: number
}

/** 渲染进程本地偏好（不进守护进程配置）。 */
interface Prefs {
  insertMode: ComposerInsertMode
  capture: boolean
  notifyTranscript: boolean
  userKeys: string[]
}

/* ── 主题色（与桌面端 CSS 变量同名，不写死颜色） ───────────────────────── */

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

/* ── 模块级状态：跨组件、跨路由共享，UI 挂载与否引擎都在跑 ─────────────── */

type RestFn = <T>(path: string, opts?: PluginRestOptions) => Promise<T>
let REST: RestFn | null = null // ctx.rest
let CTX: PluginContext | null = null

interface Store {
  snap: StateSnapshot | null // /state 快照
  error: string | null // 最近一次后端错误（字符串）
  cursor: number | null // 事件游标；null = 还没定位到 head
  bootId: number | null // 守护进程实例标识（bootAt）；变了说明 seq 已从头开始，游标必须重置
  lastEventAt: number
  transcripts: TranscriptItem[] // [{text, at, audioSeconds}] 最近 20 条，页面展示用
  busy: boolean // 正在跑自检等一次性动作
}

const store: Store = {
  snap: null,
  error: null,
  cursor: null,
  bootId: null,
  lastEventAt: 0,
  transcripts: [],
  busy: false
}

/* ── 15 秒「窗口自检」：纯渲染层状态机 ──────────────────────────────────
 * 网关里挂载的 plugin_api.py router 不会热重扫，/capture 这类新路由要等网关重启才存在；
 * 而窗口自检本来就不需要后端：守护进程把 capturing→transcribing→transcript 全推在
 * /events 上，这里只要在窗口期内把这些事件读出来即可。顺带得到实时阶段提示。
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

/** 终态只留着让人看完，到点自动回到 idle。 */
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
      /* 订阅者异常不能拖垮轮询 */
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

/* ── 渲染进程本地偏好（不进守护进程配置） ─────────────────────────────── */

const PREFS_KEY = 'prefs'
const DEFAULT_PREFS: Prefs = { insertMode: 'inline', capture: false, notifyTranscript: true, userKeys: [] }
let prefs: Prefs = { ...DEFAULT_PREFS }

function readPrefs(): void {
  try {
    const saved: unknown = CTX && CTX.storage ? CTX.storage.get(PREFS_KEY, null) : null
    const patch = saved && typeof saved === 'object' ? (saved as Partial<Prefs>) : {}
    prefs = { ...DEFAULT_PREFS, ...patch }
  } catch {
    prefs = { ...DEFAULT_PREFS }
  }
}

function savePrefs(patch: Partial<Prefs>): void {
  prefs = { ...prefs, ...patch }
  try {
    if (CTX && CTX.storage) CTX.storage.set(PREFS_KEY, prefs)
  } catch {
    /* 偏好写不进去也要继续工作 */
  }
  publish()
}

/* ── 后端门面：全部经 ctx.rest（同源、按插件命名空间隔离） ─────────────── */

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
  if (!REST) throw new Error('插件后端未就绪')
  return REST<T>(path, options)
}

type PostOptions = PluginRestOptions & { quiet?: boolean }
function post<T>(path: string, body?: Record<string, unknown>, opts?: PostOptions): Promise<T> {
  return api<T>(path, { method: 'POST', body: body || {}, ...(opts || {}) })
}

/** 错误对象 → 可读文本：`(error && error.message) || error` 的原语义，String 一次。 */
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
  publish()
}

/** 守护进程的配置是唯一真相：引擎每次拿到快照就同步一份。 */
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

/* ── 动作执行 ─────────────────────────────────────────────────────────── */

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
    /* 通知不可用不算失败 */
  }
}

function petLine(text: string): void {
  try {
    if (CTX && CTX.pet && CTX.pet.say) CTX.pet.say(text, { ttlMs: 4000 })
  } catch {
    /* 没有宠物就静默 */
  }
}

/** 桌面桥（window.hermesDesktop）的最小形状：只有 openExternal 会被用到。 */
interface DesktopBridge {
  openExternal?: (url: string) => Promise<unknown>
}

/** 渲染进程只能开 http/https/file：用 file:// 把「系统设置」拉起来。
 *  面板级跳转（直接落在蓝牙）要走后端 /open/settings，桌面桥不放行 x-apple: 这种 scheme。 */
async function openSystemSettingsApp(): Promise<boolean> {
  try {
    const bridge: DesktopBridge | undefined = typeof window !== 'undefined'
      ? (window as unknown as { hermesDesktop?: DesktopBridge }).hermesDesktop
      : undefined
    if (!bridge || typeof bridge.openExternal !== 'function') return false
    await bridge.openExternal('file:///System/Applications/System%20Settings.app')
    return true
  } catch {
    return false
  }
}

/** 秒数显示：拿不到就给「?」，不假装 0.00。 */
const fmtSec = (value: number | string | null | undefined): string => {
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(2) : '?'
}

/** 立刻提交一条文本（不走输入框）。空文本直接返回 false，后端会拒。 */
function submitNow(text: string): boolean {
  if (!text || !String(text).trim()) return false
  try {
    return host.composer.submit(null, String(text).trim())
  } catch {
    return false
  }
}

/** 可见 composer 的地址。
 *  传 null 走的是应用的「active composer」总线，那条指针在插件整页替换主区域、
 *  或 keep-alive 标签页残留时会指向一个**看不见**的挂载实例：insertText 照样
 *  ack true，文字却落在用户看不到的草稿里（实测状态长度逐次累加、界面始终空白）。
 *  所以先用「聚焦会话的持久 id」定位（它落在主 composer 上），没有会话才用 'new'。 */
function composerAddress(): string {
  try {
    const stored = host.state.focusedStoredSessionId && host.state.focusedStoredSessionId.get
      ? host.state.focusedStoredSessionId.get()
      : null
    if (stored) return stored
  } catch {
    /* 读不到就走新会话草稿 */
  }
  return 'new'
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** 可见 composer 的文本。DOM 是唯一能证明「用户真的看得到」的证据：
 *  getDraft 只能证明状态里有，证明不了编辑器重绘过（曾经状态有、界面空）。 */
function composerDomText(): string | null {
  // 返回 null = 这个环境无从取证（node 测试 harness、没有真实 DOM）。
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
  if (first === null) return true // 无从取证：信 ack
  if (first.includes(probe)) return true
  await sleep(120) // 编辑器重绘是异步的，给一拍再判
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
    break // ack 了但界面没变：不再换地址，避免重复插入
  }
  // 兜底：整篇重写（同值也算改动），逼编辑器重绘一次。
  // 实测「状态里有、界面空白」只有走过 setDraft 才会恢复。
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
    /* 兜底失败：交给调用方提示 */
  }
  return false
}

async function stopGeneration(): Promise<boolean> {
  const sessionId = focusedSessionId()
  if (!sessionId) {
    toast('没有聚焦的会话，无法停止')
    return false
  }
  try {
    await host.request('session.interrupt', { session_id: sessionId })
    return true
  } catch (error) {
    toast('停止失败：' + errText(error), 'error')
    return false
  }
}

/** 语音转写的落地：自动发送（草稿为空时）或插入草稿。 */
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
      petLine('🎙 已发送')
      return
    }
    if (draft.trim()) {
      // 草稿里已经有内容：塞进去并提示，不要替用户丢掉正在写的东西。
      await insertIntoComposer(text)
      toast('语音已插入（草稿非空，未自动发送）')
      return
    }
  }

  const ok = await insertIntoComposer(text)
  if (!ok) {
    toast('语音识别完成，但当前没有可写入的输入框：' + text.slice(0, 40))
    return
  }
  petLine('🎙 ' + text.slice(0, 40))
  if (prefs.notifyTranscript) {
    const secs = entry.audioSeconds ? Number(entry.audioSeconds).toFixed(1) + 's' : ''
    toast('已插入语音' + (secs ? '（' + secs + '）' : ''))
  }
}

/* ── 按键引擎（单击 / 双击 / 长按）───────────────────────────────────────── */

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

/** 旧版遗留的动作中文名表：现有代码不再读它（actionLabel() 另有一份占位用标签）。
 *  原样保留以免与旧 desktop/plugin.js 产生语义差异。 */
const ACTION_LABEL = {
  submit: '提交',
  stop: '停止',
  'new-session': '新会话',
  swallow: '吞掉（不做任何事）',
  focus: '聚焦输入框',
  none: '忽略'
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
      toast('没有聚焦的会话，无法提交')
      return
    }
    // submit(sessionId, text) 必须带非空文本：先把草稿取出来再提交，等同按回车。
    Promise.resolve(host.composer.getDraft(null))
      .then(draft => {
        const text = String(draft || '').trim()
        if (!text) return
        if (!submitNow(text)) toast('提交失败：输入框没有应答', 'error')
      })
      .catch(() => toast('提交失败：读取草稿出错', 'error'))
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
      toast('新建会话失败', 'error')
    }
    return
  }
  if (action === 'focus') {
    try {
      host.composer.focus(null)
    } catch {
      /* 无 composer 就是无 composer */
    }
    return
  }
  if (action === 'swallow' || action === 'none') return
  if (action && typeof action === 'object' && action.action === 'phrase') {
    const text = cfg.phrases && cfg.phrases[String(action.name)]
    if (!text) {
      toast('常用语「' + action.name + '」不存在', 'error')
      return
    }
    insertIntoComposer(text).then(ok => {
      if (!ok) toast('常用语插入失败：没有输入框应答', 'error')
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
  if (st.held) return true // 固件会重复 keydown：按住期间不再重新计时
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
  // 只有单击动作时不等待：按下即触发，手感最接近实体键。
  if (single && !double && !long) runAction(single, code)
  return true
}

function keyUp(code: string, source: string): boolean {
  void source // 与原 JS 签名一致：调用方传来源标签，本体只用 code。
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
      // 第二次抬起在 doubleMs 之内：判为双击，撤掉待发的单击。
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
    // 有长按但没有双击：抬起早于 longMs 就补发单击，稍等一点避免和长按抢。
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

/* ── DOM 通路（默认只在显式开启「捕获键盘」时接管）─────────────────────── */

const DOM_CODES = new Set(['Enter', 'NumpadEnter', 'Home', 'Backquote', 'F5', 'ContextMenu', 'Back', 'Escape', 'Space'])

/** 键盘事件的最小形状（DOM KeyboardEvent 满足；测试桩的裸对象也满足）。 */
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
  if (event.metaKey || event.ctrlKey || event.altKey) return // 系统/应用快捷键优先
  // Shift 也算「人在用键盘」：Shift+Enter 换行、Shift+Home 选到行首都要留给编辑器。
  // 遥控器只发单键、从不带修饰键，所以这一条不会挡掉任何遥控器按键。
  if (event.shiftKey) return
  if (!prefs.capture) return // 没开启捕获：只观察映射，不抢键
  if (event.repeat) {
    // 按住产生的重复事件：拦掉，避免在输入框里刷一串字符。
    if (bindingOf(code)) event.preventDefault()
    return
  }
  if (down) {
    // 桥通路也会报同一个键（hid-watch 报全部）：150ms 内的重复只认一次。
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

/* ── 事件轮询：转写 / 按键 / 链路 ──────────────────────────────────────── */

let pollTimer: TimerId | null = null
let refreshTimer: TimerId | null = null // 原 JS 遗留：声明后从未赋值/读取，保留原样。
void pollTimer
void refreshTimer
let tickCount = 0

async function tick(): Promise<void> {
  tickCount += 1
  try {
    const payload = await api<EventsResponse>('/events?since=' + (store.cursor === null ? 'head' : store.cursor), { timeoutMs: 15000 })
    if (payload && typeof payload.cursor === 'number') {
      // 守护进程重启后 seq 会回到 1，而 cursor 还停在旧进程的大数字上——此时
      // since=37 > head=3，切片永远为空，事件全丢（表现：按键有反应在 daemon.log，
      // Hermes 里毫无动静）。靠 bootAt 识别新实例，必要时把游标拉回 head。
      const bootChanged = payload.bootAt !== undefined && store.bootId !== null && payload.bootAt !== store.bootId
      const rewound = typeof payload.head === 'number' && store.cursor !== null && payload.head < store.cursor
      if (payload.bootAt !== undefined) store.bootId = payload.bootAt
      if (store.cursor === null) {
        // 首次挂载从 head 起，不重放上次运行留下的事件。
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
  // 窗口自检：等待阶段的倒计时与到点收尾都在这里推进（400ms 一拍，秒级足够）。
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
  // 状态快照比事件流便宜、但没那么急：每 4 拍取一次，另外就地操作后手动刷新。
  if (tickCount % 4 === 1) refreshState()
}

function handleEvent(event: DaemonEvent): void {
  const type = event && event.type
  const payload: EventPayload = (event && event.payload) || {}
  if (type === 'transcript') {
    if (payload.selftest) {
      // 自检结果只上报，不写进输入框。
      publish()
      return
    }
    if (listenActive()) {
      // 窗口期内的语音只做展示，不改输入框（按钮的承诺）。
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
      // 与 DOM 通路 150ms 内去重：谁先到谁说了算，后到的不再触发。
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
  if (type === 'error') {
    if (listenActive()) {
      listenWin.note = String(payload.message || '识别失败')
      listenSettle('error')
    }
    toast('识别失败：' + String(payload.message || '').slice(0, 80), 'error')
    publish()
    return
  }
  if (type === 'notice') {
    // 守护进程的可读提示（"没听清""太短了"）：不是错误，只轻提示一次，不打断输入。
    const message = String(payload.message || '')
    if (listenActive() && payload.kind === 'empty') {
      // 窗口还开着，允许再说一次：不落终态，只把「这次没听清」写进提示。
      listenWin.note = message || '没听清'
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

/* ── UI 原子件 ────────────────────────────────────────────────────────── */

/* ── 视觉基元 ──────────────────────────────────────────────────────────
 * 字号按 5 档收敛（micro/tiny/small/body/lead + metric/title），间距只有
 * 4 的倍数；颜色一律走主题变量。改这一个对象就能整体调密度。
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

/** 分段控件：一组互斥选项装进同一个槽里，比两个独立按钮更像一个「设置项」。 */
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
  // 归一化与旧版逐字相同：裸字符串补成 {value,label}；断言只是收窄写法，运行时无差别。
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

/** 设置项：标签在左、控件贴右，但整行只有卡片那么宽——视线不需要跨屏配对。 */
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

/** 兼容旧调用点（原 Row 与 Field 同义）。 */
const Row = Field
void Row

/** 指标块：上面一行小字标签，下面一个读数值，用来铺「链路」那排读数。 */
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

/** 凹陷面板：日志、说明这类「次级内容」放进浅一层底色的框里，和主内容分层。 */
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

/** 键帽：按键名的视觉符号，让「映射」读起来像一张键位表而不是表单。 */
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
  const pair = labels || ['开', '关']
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
}

function TextInput({ value, onChange, placeholder, width }: TextInputProps) {
  return (
    <input
      value={value || ''}
      className="rm-field"
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

/** 页头图标：一支麦克风，和侧栏 codicon 同源语义。 */
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

/* ── 状态栏芯片 ───────────────────────────────────────────────────────── */

const STATE_TEXT: Record<string, string> = {
  ready: '就绪',
  capturing: '收音中',
  transcribing: '识别中',
  starting: '连接中',
  stopped: '已停止',
  error: '异常'
}

function stateTone(state: string | null | undefined): string {
  if (state === 'ready') return C.green
  if (state === 'capturing') return C.accent
  if (state === 'transcribing') return C.blue
  if (state === 'starting') return C.yellow || C.orange
  if (state === 'error') return C.red
  return C.fg4
}

/* ── 状态栏徽标：18px 图标 + 电量电池 ─────────────────────────────────── */

// 动画需要 @keyframes，inline style 做不到，所以注入一次 <style>。
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
    /* 没有 document 就退化成静态图形，不影响功能 */
  }
}

// 四角锁定框：锁定态共用，颜色随状态。
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

// ready：框完好 + 中心实心绿点（在线且已锁定）；error：右上角错位 + 空心划斜杠。
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
    // 识别中属于过渡态，图标用蓝点，文字另给（一闪而过要说清）。
    return svg([cornerFrame(C.fg3, false), <circle {...{ key: 'dot' }} cx={12} cy={12} r={2.3} fill={C.blue} />])
  }
  // starting / stopped / 未知：灰色空心框，文字兜底。
  return svg([
    cornerFrame(C.fg4, false),
    <circle {...{ key: 'dot' }} cx={12} cy={12} r={2.1} fill="none" stroke={C.fg4} strokeWidth={1.8} />
  ])
}

// 电量：手机式电池，内条按百分比填充，25% / 45% 两个坎换颜色。
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
      aria-label={'电量 ' + level + '%'}
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
  const label = s.error ? '未连接' : STATE_TEXT[state ?? ''] || (snap ? String(state || '未知') : '…')
  // 过渡态（连接中 / 已停止 / 识别中 / 还没拿到状态）留一行小字，其余只留图标。
  const showText = !error && (state === 'transcribing' || state === 'starting' || state === 'stopped' || !state)
  const device = snap && snap.device ? snap.device.name || snap.device.id : null
  const title = [
    '指挥',
    label + (detail ? ' · ' + detail : ''),
    device ? '设备 ' + device : null,
    level !== null ? '电量 ' + level + '%' : null,
    '点击打开设置'
  ]
    .filter(Boolean)
    .join('｜')

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

/* ── 整页 ─────────────────────────────────────────────────────────────── */

/** 状态行文本表（历史遗留：现版页面用 Tile 铺读数，没有调用点；原样保留）。 */
function statusRows(snap: StateSnapshot | null): string[][] {
  const rows: string[][] = []
  if (!snap) return rows
  const diag: Diagnostics = snap.diagnostics || {}
  const tr: TranscriberInfo = snap.transcriber || {}
  rows.push(['链路', (STATE_TEXT[snap.state ?? ''] || snap.state || '未知') + (snap.detail ? ' · ' + snap.detail : '')])
  if (snap.device && (snap.device.name || snap.device.id)) {
    rows.push(['设备', (snap.device.name || '未命名') + (snap.device.id ? ' · ' + String(snap.device.id).slice(0, 8) : '')])
  }
  const battery = snap.battery !== null && snap.battery !== undefined ? snap.battery : diag.battery
  if (battery !== null && battery !== undefined) rows.push(['电量', battery + '%'])
  rows.push(['识别', (tr.kind || '?') + ' · ' + (tr.language || 'zh') + ' · ' + String(tr.model || '').split('/').pop()!])
  if (diag.frames !== undefined) rows.push(['语音会话', String(diag.sessions || 0) + ' 次 / ' + String(diag.frames || 0) + ' 帧'])
  if (diag.lastUtterance && diag.lastUtterance.text) rows.push(['上次转写', diag.lastUtterance.text])
  if (diag.lastError) rows.push(['最近错误', String(diag.lastError)])
  rows.push(['守护进程', 'pid ' + snap.pid + ' · 运行 ' + Math.round((snap.uptimeMs || 0) / 60000) + ' 分钟'])
  return rows
}
void statusRows

const CODE_OPTIONS_HINT = ['Enter', 'NumpadEnter', 'Back', 'ContextMenu', 'Home', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backquote', 'F5', 'Escape', 'Space', 'AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute', 'Netflix', 'YouTube', 'InputSource', 'Power']

/* ── 遥控器型号（/state.profileId + /state.profiles）─────────────────────
 * 两台遥控器（小米蓝牙语音遥控器 2 / Chromecast with Google TV）按键完全不同，
 * 「按键映射」表必须按当前生效的型号渲染。profiles 缺失（老后端 / 测试桩）、
 * 或桥连上了但型号没登记（profileId 为 null）时一律降级：全量按键表 + 登记提示。
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

/** 动作值 → 中文名（占位文案用）：字符串走标签表，常用语对象给「常用语「名字」」。 */
function actionLabel(action: ActionValue | null | undefined): string {
  const LABELS: Record<string, string> = { submit: '提交', stop: '停止', 'new-session': '新会话', swallow: '吞掉', none: '忽略', focus: '聚焦输入框' }
  if (!action) return ''
  if (typeof action === 'string') return LABELS[action] || action
  if (action.action === 'phrase') return '常用语「' + String(action.name || '') + '」'
  return ''
}

/** 型号 defaultKeyMap 的占位文案：只在「这一格还没有任何映射」时显示成灰字，
 *  绝不写进 keyMap——那是出厂建议，不是用户的选择。 */
function defaultTapLabel(profile: ProfileSummary | null, code: string, tap: TapName): string {
  const entry = profile && profile.defaultKeyMap && profile.defaultKeyMap[code]
  return actionLabel(entry && entry[tap])
}

function actionOptions(phrases: Record<string, string>): SelectOption[] {
  const base: SelectOption[] = [
    { value: '', label: '（无）' },
    { value: 'submit', label: '提交' },
    { value: 'stop', label: '停止生成' },
    { value: 'new-session', label: '新建会话' },
    { value: 'focus', label: '聚焦输入框' },
    { value: 'swallow', label: '吞掉' }
  ]
  const list = Object.keys(phrases || {}).map(name => ({ value: 'phrase:' + name, label: '常用语「' + name + '」' }))
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
      // 后端已经落盘：把返回值并回快照，避免下拉框弹回旧值。
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
    toast('保存失败：' + errText(error), 'error')
    return false
  }
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
  // 「用户手动加过的键」有留痕（prefs.userKeys，点「添加映射」时记、删行时清）。
  // keyMap 里但没留痕的键一律按历史遗留处理——旧版本把 Chromecast 默认写进过 settings，
  // 这些条目和真正的用户配置在 keyMap 里长得一模一样，只能靠留痕区分。
  const userKeys = Array.isArray(prefs.userKeys) ? prefs.userKeys : []
  const isVolumeKey = (code: string): boolean => String(code).indexOf('AudioVolume') === 0
  // 键行 = 当前型号的键（按型号顺序）∪ 用户手动加过的键（标「未知/该型号未上报」灰显）。
  // 音量键归 macOS（始终直通），没配映射就不出行，配了才显示；历史遗留键（型号没有、
  // 也没手动加过）整行隐藏——Enter / InputSource 在小米下绝不出现。型号未知退回老的全量表。
  const extraRows = profileKeys ? userKeys.filter(code => profileKeys.indexOf(code) < 0) : []
  const rowCodes = profileKeys
    ? profileKeys.filter(code => keyMap[code] || !isVolumeKey(code)).concat(extraRows)
    : Object.keys(keyMap).sort()
  const [newCode, setNewCode] = useState('')
  const [newPhrase, setNewPhrase] = useState({ name: '', text: '' })
  const [history, setHistory] = useState<HistoryEntry[] | null>(null)
  const [selftest, setSelftest] = useState<TranscriptInfo | null>(null)
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

  /* 遥控器列表：一条桥只连一台设备，切换靠改 config 的 deviceId/deviceName，
     后端 applyPatch 检测到变化会自己重启桥，不需要页面做额外动作。 */
  const scanDevices = async (): Promise<void> => {
    setScanning(true)
    try {
      const res = await api<DevicesResponse>('/devices?seconds=4', { timeoutMs: 20000 })
      const list = (res && res.devices) || []
      setDevices(list)
      toast(
        list.length ? '发现 ' + list.length + ' 台候选遥控器' : '没发现候选设备：先在 系统设置 ▸ 蓝牙 里配对连接',
        list.length ? 'info' : 'warning'
      )
    } catch (error) {
      const text = errText(error)
      // 网关里已挂载的 router 不热重扫：本次启动前新增的 /devices 会一直 404，
      // 直到应用重启。这时退回 /state 里守护进程自己缓存的列表（每 5 分钟扫一次），
      // 让「切换遥控器」在旧网关上照样可用，而不是退化成一句「要重启」。
      if (/404|not found/i.test(text)) {
        const cachedList = (snap && snap.devices) || []
        setDevices(cachedList)
        toast(
          cachedList.length
            ? '这是守护进程缓存的 ' + cachedList.length + ' 台设备（实时扫描需重启一次应用），可以直接切换。'
            : '设备扫描要重启一次 Hermes 应用才可用（网关路由不热更新）。眼下可以直接让我帮你切换。',
          'warning'
        )
      } else {
        toast('扫描失败：' + text, 'warning')
      }
    } finally {
      setScanning(false)
    }
  }

  const useDevice = async (candidate: CandidateDevice): Promise<void> => {
    const ok = await patchConfig({ deviceId: candidate.id, deviceName: candidate.name || '' })
    if (!ok) return
    toast('已切换到 ' + (candidate.name || String(candidate.id).slice(0, 8)) + '，桥正在重连', 'info')
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
  const devText = device.name
    ? device.name + (device.id ? ' · ' + String(device.id).slice(0, 8) : '')
    : '未连接设备'
  // 守护进程会缓存最近一次扫描结果（/state.devices），页面一开就能列出候选设备，
  // 不必等用户点「扫描设备」——点按钮只是立刻重扫一遍。
  const cachedDevices: CandidateDevice[] = (snap && snap.devices) || []
  const listed = devices !== null ? devices : (cachedDevices.length ? cachedDevices : null)
  const tone = s.error ? C.red : stateTone(state)
  const stateLabel = s.error ? '后端未连接' : STATE_TEXT[state ?? ''] || String(state || '…')
  const detailText = snap && snap.detail ? (snap.detail === 'remote' ? '遥控器触发' : String(snap.detail)) : ''
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
        {/* ── 页头：图标 + 状态 + 设备/引擎一行带过，动作收在右端 ───────── */}
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
              <h1 style={{ margin: 0, fontSize: FS.title, fontWeight: 650, letterSpacing: '-0.015em', lineHeight: '24px' }}>{'指挥'}</h1>
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
              {devText + '　·　SenseVoice 本机识别 · ' + String(tr.language || 'zh') + ' · ' + modelName + (precision ? ' · ' + precision : '')}
            </span>
          </div>
          <span {...{ key: 'sp' }} style={{ flex: 1 }} />
          <div {...{ key: 'act' }} style={{ display: 'flex', gap: 8 }}>
            <Btn {...{ key: 'r' }} onClick={() => run('/restart')} disabled={busy} title="重新扫描并连接遥控器">{'重连'}</Btn>
            <Btn {...{ key: 's' }} onClick={() => run(state === 'stopped' ? '/start' : '/stop')} disabled={busy}>
              {state === 'stopped' ? '开始监听' : '停止监听'}
            </Btn>
          </div>
        </header>

        {s.error ? (
          <div {...{ key: 'err' }} style={notice(C.red)}>
            {'后端不可达：' + s.error + '　（网关内的 Python 侧会按需拉起 Node 守护进程；若持续失败，看 ~/.hermes/baton/daemon.out）'}
          </div>
        ) : null}

        {rivals.length > 0 ? (
          <div {...{ key: 'rival' }} style={notice(C.orange)}>
            {'另一个 atvv-link 正在跑（pid ' + rivals.map(c => c.pid).join('、') + '）：它和本插件抢同一台遥控器的连接，表现为「连上就掉」或「收不到音频」。请退出 DSH 的无线麦后再点「重连」。'}
          </div>
        ) : null}

        {/* ── 链路：一排读数 + 一排动作 ─────────────────────────────────── */}
        <Card
          {...{ key: 'status' }}
          title="链路"
          tone={tone}
          dense
          action={
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <Btn
                {...{ key: 'bt' }}
                ghost
                title="打开「系统设置 ▸ 隐私与安全性 ▸ 蓝牙」，把 Hermes 勾上，然后点「重连」"
                onClick={async () => {
                  // 首选后端路由（一步落在蓝牙面板）。网关里已挂载的 router 不热重扫，这条路由
                  // 要等网关重启才存在；不在了就把「系统设置」本身拉起来，别让人对着 404 发呆。
                  const opened = await run<OkResponse>('/open/settings', { pane: 'bluetooth' }, { quiet: true })
                  if (opened) {
                    toast('已打开 系统设置 ▸ 隐私与安全性 ▸ 蓝牙：给 Hermes 勾上，然后点「重连」', 'info')
                    return
                  }
                  const launched = await openSystemSettingsApp()
                  toast(
                    launched
                      ? '系统设置已打开：切到 隐私与安全性 ▸ 蓝牙，勾选 Hermes，再回来点「重连」'
                      : '手动打开：系统设置 ▸ 隐私与安全性 ▸ 蓝牙 → 勾选 Hermes → 回来点「重连」',
                    launched ? 'info' : 'warning'
                  )
                }}
              >
                {'蓝牙授权'}
              </Btn>
              <Btn
                {...{ key: 'mock' }}
                ghost
                title="走和真实语音相同的通路，验证「转写 → 输入框」，不需要遥控器"
                disabled={busy}
                onClick={async () => {
                  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false })
                  const result = await run<MockTranscriptResponse>('/mock/transcript', { text: '这是一条模拟语音（' + stamp + '）' })
                  if (result && result.transcript) setSelftest(null)
                }}
              >
                {'模拟一条语音'}
              </Btn>
              <Btn
                {...{ key: 'self' }}
                ghost
                onClick={async () => {
                  const result = await run<SelftestResponse>('/selftest')
                  if (result) setSelftest(result.transcript || null)
                }}
                disabled={busy}
              >
                {busy ? '运行中…' : '识别自检'}
              </Btn>
              <Btn
                {...{ key: 'listen' }}
                ghost
                active={listenWin.phase === 'waiting' || listenWin.phase === 'capturing' || listenWin.phase === 'transcribing'}
                title="开一个 15 秒窗口：期间按一次遥控器语音键说话，只显示文字，不改输入框"
                onClick={() => startListenWindow(15000)}
              >
                {listenWin.phase === 'waiting' || listenWin.phase === 'capturing' || listenWin.phase === 'transcribing'
                  ? '窗口开着 · ' + listenRemain() + 's'
                  : '窗口自检 15 秒'}
              </Btn>
            </div>
          }
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(172px, 1fr))', columnGap: 18, rowGap: 14 }}>
            <Tile {...{ key: 'st' }} label="链路状态">
              <span style={{ fontSize: FS.metric, fontWeight: 600, letterSpacing: '-0.01em' }}>{stateLabel}</span>
              {detailText || (live ? '实时采集中' : '蓝牙桥待命')}
            </Tile>
            <Tile
              {...{ key: 'bt' }}
              label="遥控器电量"
              divider
              sub={battery === null || battery === undefined ? '未上报' : (battery <= 20 ? '该换电池了' : battery <= 45 ? '电量偏低' : '电量充足')}
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
              label="识别引擎"
              divider
              sub={modelName + (precision ? ' · ' + precision : '')}
            >
              <span {...{ key: 'v' }} style={{ fontSize: FS.metric, fontWeight: 600 }}>{String(tr.kind || 'sensevoice')}</span>
              <span {...{ key: 'l' }} style={{ fontSize: FS.tiny, color: C.fg4 }}>{String(tr.language || 'zh')}</span>
            </Tile>
            <Tile
              {...{ key: 'ses' }}
              label="语音会话"
              divider
              sub={'累计 ' + String(diag.frames || 0) + ' 帧音频'}
            >
              <span {...{ key: 'v' }} style={{ fontSize: FS.metric, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{String(diag.sessions || 0)}</span>
              <span {...{ key: 'u' }} style={{ fontSize: FS.tiny, color: C.fg4 }}>{'次 · 识别 ' + String(tr.calls || 0) + ' 次'}</span>
            </Tile>
            <Tile
              {...{ key: 'pid' }}
              label="守护进程"
              divider
              sub={tr.loadMs ? '模型加载 ' + tr.loadMs + 'ms' : ''}
            >
              <span {...{ key: 'v' }} style={{ fontSize: FS.metric, fontWeight: 600, fontFamily: MONO }}>{snap ? 'pid ' + snap.pid : '未启动'}</span>
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
                ? (listenWin.note ? listenWin.note + '　' : '') + '按下遥控器语音键，说一句，松手即识别（剩 ' + listenRemain() + 's）'
                : listenWin.phase === 'capturing'
                  ? '正在采集…松手后开始识别（剩 ' + listenRemain() + 's）'
                  : listenWin.phase === 'transcribing'
                    ? '识别中…'
                    : listenWin.phase === 'done'
                      ? '窗口内识别：「' + listenWin.text + '」（' + fmtSec(listenWin.entry && listenWin.entry.inferenceSeconds) + 's 推理 / ' + fmtSec(listenWin.entry && listenWin.entry.audioSeconds) + 's 音频）· 未写入输入框'
                      : listenWin.phase === 'timeout'
                        ? '15 秒内没收到按键：确认遥控器已连接、没被 DSH 抢占，并看下面的守护进程日志有没有 [hid] / [atvv] 行'
                        : '识别失败：' + (listenWin.note || '未知原因')}
            </div>
          ) : null}

          {selftest
            ? (() => {
                // 空结果不能刷成绿色「识别成功（空）」：那是在替模型撒谎。
                const text = String(selftest.text || '')
                const t = text ? C.green : C.orange
                const note = text
                  ? ''
                  : selftest.fellBack
                    ? '　（测试音频没识别出文字，已自动改用内置样本）'
                    : '　（连内置样本都没识别出文字——模型或音频通路有问题，看日志）'
                return (
                  <div style={notice(t)}>
                    {text
                      ? '自检结果：「' + text + '」（' + fmtSec(selftest.inferenceSeconds) + 's 推理 / ' + fmtSec(selftest.audioSeconds) + 's 音频）'
                      : '自检结果为空（' + fmtSec(selftest.audioSeconds) + 's 音频）' + note}
                  </div>
                )
              })()
            : null}
        </Card>

        {/* ── 遥控器：多台设备发现与切换 ───────────────────────────────── */}
        <Card
          {...{ key: 'devices' }}
          title="遥控器"
          hint="支持多台 ATVV 语音遥控器（小米蓝牙语音遥控器、Chromecast with Google TV 等）。一条桥同一时刻只连一台，切换后会自动重连。"
          action={<Btn {...{ key: 'scan' }} ghost disabled={scanning} onClick={scanDevices}>{scanning ? '扫描中…' : '扫描设备'}</Btn>}
        >
          <div {...{ key: 'cur' }} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Dot {...{ key: 'd' }} tone={tone} />
            <span {...{ key: 'n' }} style={{ fontSize: FS.lead, fontWeight: 600 }}>{device.name || '未连接设备'}</span>
            {device.id ? (
              <span {...{ key: 'i' }} style={{ fontSize: FS.tiny, color: C.fg4, fontFamily: MONO }}>{String(device.id).slice(0, 8)}</span>
            ) : null}
            {battery !== null && battery !== undefined ? (
              <span {...{ key: 'b' }} style={{ fontSize: FS.tiny, color: C.fg3 }}>{'电量 ' + battery + '%'}</span>
            ) : null}
          </div>
          <div {...{ key: 'model' }} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span {...{ key: 'l' }} style={{ fontSize: FS.micro, color: C.fg4, letterSpacing: '0.08em', fontWeight: 500 }}>{'型号'}</span>
            <span {...{ key: 'v' }} style={{ fontSize: FS.small, color: profile ? C.fg : C.fg3 }}>
              {profile ? profile.label + (profile.vendor ? ' · ' + profile.vendor : '') : '未登记（下面按键映射按通用全量表显示）'}
            </span>
            {profile && profile.voiceHint ? (
              <span {...{ key: 'h' }} style={{ fontSize: FS.small, color: C.fg3 }}>{String(profile.voiceHint)}</span>
            ) : null}
          </div>
          {!profile ? (
            <div {...{ key: 'reg' }} style={{ fontSize: FS.small, color: C.fg4, lineHeight: '17px' }}>
              {'这个型号还没登记，把它的键表加进 ' + devicesDir + '/<型号>.json 就会自动出现。'}
            </div>
          ) : null}
          {listed === null ? (
            <div {...{ key: 'hint' }} style={{ fontSize: FS.small, color: C.fg4 }}>
              {'点「扫描设备」列出系统里已连接和正在广播的遥控器（只读，不影响当前链路，约 4 秒）。'}
            </div>
          ) : listed.length === 0 ? (
            <div {...{ key: 'none' }} style={{ fontSize: FS.small, color: C.fg3 }}>
              {'没发现候选设备：先在 系统设置 ▸ 蓝牙 里把遥控器配对并连接。'}
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
                      {candidate.name || '（未命名设备）'}
                    </span>
                    <span {...{ key: 's' }} style={{ fontSize: FS.tiny, color: C.fg4 }}>{candidate.connected ? '已连接' : '可连接'}</span>
                    {active ? (
                      <span {...{ key: 'on' }} style={{ fontSize: FS.tiny, color: C.green }}>{'使用中'}</span>
                    ) : (
                      <Btn {...{ key: 'u' }} ghost disabled={busy} onClick={() => useDevice(candidate)}>{'切换'}</Btn>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </Card>

        {/* ── 两列：语音落地 / 常用语 ─────────────────────────────────── */}
        <div
          {...{ key: 'row2' }}
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(370px, 1fr))', gap: 14, alignItems: 'stretch' }}
        >
          <Card
            {...{ key: 'voice' }}
            title="语音落地"
            hint="遥控器语音键说话 → 本机 SenseVoice 识别 → 文本进入当前输入框。识别在本机完成，音频不出机器。"
          >
            <Field
              label="识别后"
              hint={values.autoSend ? '草稿为空时直接发送，有草稿则插入' : '只写进输入框，发送仍由你按 Enter'}
            >
              <Toggle
                on={Boolean(values.autoSend)}
                onChange={on => patchConfig({ autoSend: on })}
                labels={['直接发送', '只插入']}
              />
            </Field>
            <Field label="插入方式">
              <Segmented
                value={prefs.insertMode}
                options={[{ value: 'inline', label: '同一行' }, { value: 'block', label: '另起一段' }]}
                onChange={v => savePrefs({ insertMode: v })}
              />
            </Field>
            <Field label="插入后提示">
              <Toggle
                on={Boolean(prefs.notifyTranscript)}
                onChange={on => savePrefs({ notifyTranscript: on })}
                labels={['提示', '不提示']}
              />
            </Field>
            <Field label="自动连接" hint="守护进程启动后立即监听遥控器">
              <Toggle
                on={values.autoStart !== false}
                onChange={on => patchConfig({ autoStart: on })}
              />
            </Field>
            <Field label="断线自动重连" hint="蓝牙掉线后自己重试，不用手动点">
              <Toggle
                on={values.autoRestart !== false}
                onChange={on => patchConfig({ autoRestart: on })}
              />
            </Field>
          </Card>

          <Card
            {...{ key: 'phrases' }}
            title="常用语"
            hint="在「按键映射」里选「常用语」，一句话直接落地。"
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
                      <Empty>{'还没有常用语，在下面加一条。'}</Empty>
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
                        title="删除这条常用语"
                        onClick={() => { const next = { ...phrases }; delete next[name]; patchConfig({ phrases: next }) }}
                        style={delBtn}
                      >
                        {'×'}
                      </button>
                    </div>
                  ))}
            </div>
            <div {...{ key: 'add' }} style={{ display: 'grid', gridTemplateColumns: '96px minmax(0,1fr) auto', gap: 8, alignItems: 'center', marginTop: 'auto' }}>
              <TextInput {...{ key: 'n' }} value={newPhrase.name} placeholder="名称" width="100%" onChange={v => setNewPhrase({ ...newPhrase, name: v })} />
              <TextInput {...{ key: 't' }} value={newPhrase.text} placeholder="插入的文字" width="100%" onChange={v => setNewPhrase({ ...newPhrase, text: v })} />
              <Btn
                {...{ key: 'b' }}
                disabled={!newPhrase.name.trim() || !newPhrase.text.trim()}
                onClick={() => {
                  const name = newPhrase.name.trim()
                  patchConfig({ phrases: { ...phrases, [name]: newPhrase.text.trim() } })
                  setNewPhrase({ name: '', text: '' })
                }}
              >
                {'添加'}
              </Btn>
            </div>
          </Card>
        </div>

        {/* ── 按键映射：一张键位表，而不是一堆下拉框 ───────────────────── */}
        <Card
          {...{ key: 'keys' }}
          title="按键映射"
          action={<Toggle on={Boolean(values.keysEnabled)} onChange={on => patchConfig({ keysEnabled: on })} />}
          hint={profileKeys && profile
            ? profile.label + '：这台遥控器的键。' + (profile.voiceHint ? String(profile.voiceHint) : '')
            : '单击 / 双击 / 长按三种手势。Back、ContextMenu 与媒体键由蓝牙桥直接上报；Enter、Home 等键需要打开下面的「捕获键盘」。这个型号还没登记，把它的键表加进 ' + devicesDir + '/<型号>.json 就会自动出现。'}
        >
          {rowCodes.length === 0
            ? (
                <Empty>
                  {profileKeys
                    ? '这个型号的键还没配任何映射（音量键配了才显示）。在下面选一个键名添加。'
                    : '还没有映射。在下面选一个键名添加。'}
                </Empty>
              )
            : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <div
                    style={{ display: 'grid', gridTemplateColumns: '132px repeat(3, minmax(0,1fr)) 30px', gap: 10, padding: '0 6px 4px' }}
                  >
                    <span {...{ key: 'k' }} style={TH}>{'键'}</span>
                    <span {...{ key: 's' }} style={TH}>{'单击'}</span>
                    <span {...{ key: 'd' }} style={TH}>{'双击'}</span>
                    <span {...{ key: 'l' }} style={TH}>{'长按'}</span>
                    <span {...{ key: 'x' }} />
                  </div>
                  {rowCodes.map(code => {
                    const binding = keyMap[code] || {}
                    const options = actionOptions(phrases)
                    // 型号里没有的键 = 用户手动加的：标「未知」灰显，绝不静默丢掉用户配置。
                    const unknown = Boolean(profileKeys) && profileKeys!.indexOf(code) < 0
                    // defaultKeyMap 只在整键还没有任何映射时当占位（灰字「默认：X」），不写进 keyMap。
                    const hasMapping = Boolean(keyMap[code])
                    const tapCell = (name: TapName, key: string) => {
                      const placeholder = hasMapping ? '' : defaultTapLabel(profile, code, name)
                      return (
                        <Select
                          {...{ key }}
                          value={actionToValue(binding[name])}
                          options={placeholder ? [{ value: '', label: '默认：' + placeholder }].concat(options.slice(1)) : options}
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
                              title="这个键不在当前型号的键表里：是你手动添加的，保留显示"
                              style={{ fontSize: FS.micro, color: C.fg3, border: BORDER, borderRadius: 999, padding: '0 6px', lineHeight: '15px', whiteSpace: 'nowrap' }}
                            >
                              {'未知'}
                            </span>
                          ) : null}
                          {unknown ? (
                            <span {...{ key: 'g' }} style={{ fontSize: FS.micro, color: C.fg4, lineHeight: '12px', width: '100%' }}>{'该型号未上报'}</span>
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
                                title="删除这条映射"
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
              options={[{ value: '', label: '选择键名…' }].concat(
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
                // 型号里没有的键留痕（prefs.userKeys）：这是「用户手动加的」的唯一凭据，
                // 没留痕的 keyMap 条目会被当成历史遗留，在别的型号下隐藏。
                if (userKeys.indexOf(newCode) < 0) savePrefs({ userKeys: userKeys.concat([newCode]) })
                patchConfig({ keyMap: next })
                setNewCode('')
              }}
            >
              {'添加映射'}
            </Btn>
            <span {...{ key: 'dbl' }} style={{ fontSize: FS.tiny, color: C.fg4 }}>
              {'双击窗口 ' + (snap && snap.keys ? snap.keys.doubleMs : 300) + 'ms · 长按 ' + (snap && snap.keys ? snap.keys.longMs : 550) + 'ms'}
            </span>
          </div>
          <Panel style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Field
              {...{ key: 'filter' }}
              label="按键归属"
              hint="默认只有当前生效的那台管事（另一台的按键被忽略并记一条日志），跟语音键走同一台。音量键不在此列，始终归 macOS。"
            >
              <Select
                value={values.keyFilter || 'active'}
                options={[{ value: 'active', label: '只有当前设备' }, { value: 'any', label: '两台都认' }]}
                onChange={v => patchConfig({ keyFilter: v })}
              />
            </Field>
            <Field
              {...{ key: 'cap' }}
              label="捕获键盘按键"
              hint={'只有「桥拿不到的键」才需要它：打开后插件改从键盘事件里认键，普通键盘的 Enter / Home 也会被一起接管。'
                + (profile && Array.isArray(profile.hidKeys) && profile.hidKeys.length
                    ? '这台遥控器上报 ' + profile.hidKeys.join(' + ') + '（桥直通），映射这些键不用开。'
                    : '这台遥控器上报 Back + 音量键（桥直通），映射这些键不用开。')}
            >
              <Toggle
                on={Boolean(prefs.capture)}
                onChange={on => savePrefs({ capture: on })}
              />
            </Field>
          </Panel>
        </Card>

        {/* ── 两列：收音参数 / 语音历史 ───────────────────────────────── */}
        <div
          {...{ key: 'row3' }}
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(370px, 1fr))', gap: 14, alignItems: 'stretch' }}
        >
          <Card
            {...{ key: 'audio' }}
            title="收音参数"
            hint="默认值来自 DSH 那套调好的：350ms 断句、30s 上限、200ms 掐头、100Hz 高通。听不清或吃字时再动。"
          >
            <Field
              label="识别精度"
              hint={values.precision === 'fp32'
                ? 'fp32 权重：更准，推理约 +0.3s；切换后立刻重载模型'
                : 'int8 量化权重：最快、内存最省'}
            >
              <Segmented
                value={values.precision === 'fp32' ? 'fp32' : 'int8'}
                options={[{ value: 'int8', label: 'int8' }, { value: 'fp32', label: 'fp32' }]}
                onChange={v => patchConfig({ precision: v })}
              />
            </Field>
            <Field label="断句静音" hint="静音多久算说完一句">
              <Num value={values.gapMs || 350} min={150} max={2000} step={50} suffix="ms" onCommit={v => patchConfig({ gapMs: v })} />
            </Field>
            <Field label="单次上限" hint="超过就强制断句">
              <Num value={values.maxMs || 30000} min={3000} max={120000} step={1000} suffix="ms" onCommit={v => patchConfig({ maxMs: v })} />
            </Field>
            <Field label="掐头" hint="切掉开头的按键 / 气流噪声">
              <Num value={values.trimMs === undefined ? 200 : values.trimMs} min={0} max={800} step={20} suffix="ms" onCommit={v => patchConfig({ trimMs: v })} />
            </Field>
            <Field label="高通滤波" hint="滤掉低频轰鸣">
              <Num value={values.cutoffHz === undefined ? 100 : values.cutoffHz} min={0} max={400} step={10} suffix="Hz" onCommit={v => patchConfig({ cutoffHz: v })} />
            </Field>
            <Field label="识别语言" hint="zh / en / ja / ko / yue">
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
            title="语音历史"
            hint="仅存本机；打开开关后才写入。"
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
                      toast('读取历史失败：' + errText(error), 'error')
                    }
                  }}
                >
                  {'载入'}
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
                        toast('清空失败：' + errText(error), 'error')
                      }
                    }}
                  >
                    {'清空'}
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
                        ? '还没有落盘记录。'
                        : '历史记录已关闭，识别结果不落盘（上面的开关打开后才会写入）。'}
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

        {/* ── 日志：整行宽度，等宽小字收在凹陷面板里 ──────────────────── */}
        <Card
          {...{ key: 'logs' }}
          title="守护进程日志"
          dense
          action={
            <Btn
              ghost
              onClick={async () => {
                try {
                  const payload = await api<LogsResponse>('/logs?lines=60')
                  setLogs((payload && payload.logs) || [])
                } catch (error) {
                  toast('读取日志失败：' + errText(error), 'error')
                }
              }}
            >
              {'刷新'}
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
            {logs ? logs.join('\n') : (snap && snap.logs ? snap.logs.join('\n') : '（点右上角刷新读取最近 60 行）')}
          </pre>
        </Card>
      </div>
    </div>
  )
}

/* ── 注册 ─────────────────────────────────────────────────────────────── */

export default {
  id: ID,
  name: '指挥',
  description: '蓝牙语音遥控器：说话即插入本地识别的文字，按键可映射为提交/停止/新建会话/常用语，支持多型号',
  register(ctx: PluginContext) {
    CTX = ctx
    REST = (path: string, options?: PluginRestOptions) => ctx.rest(path, options)
    readPrefs()
    applyRuntimeConfig(store.snap)

    ctx.register({ id: 'nav', area: 'sidebar.nav', data: { codicon: 'mic', label: '指挥', path: ROUTE } })

    ctx.register({
      id: 'page',
      area: 'routes',
      title: '指挥',
      data: { path: ROUTE },
      render: () => <RemoteMicPage />
    })

    ctx.register({
      id: 'palette',
      area: 'palette',
      order: 235,
      data: {
        id: 'baton.open',
        label: '指挥',
        keywords: ['mic', 'voice', 'dictation', 'remote', '语音', '麦克风', '遥控器', '听写'],
        run: () => host.navigate(ROUTE)
      }
    })

    ctx.register({ id: 'chip', area: 'statusBar.right', order: 120, render: () => <Chip /> })

    // 两条通路都要在插件加载时立刻生效：不依赖用户是否打开过那一页。
    ctx.addEventListener(window, 'keydown', event => onDomKey(event, true), true)
    ctx.addEventListener(window, 'keyup', event => onDomKey(event, false), true)

    ctx.onDispose(() => {
      timers.forEach(id => clearTimeout(id))
      timers.clear()
      engine.states = {}
    })

    startPolling()
    refreshState()
    // 一行加载标记：桌面日志里能确认这份插件确实被渲染层加载了（只有失败才会自动记日志）。
    try {
      console.info('[baton] plugin loaded')
    } catch {
      /* 控制台不可用不算失败 */
    }
  }
} satisfies HermesPlugin
