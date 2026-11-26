// Engine harness: loads the real desktop bundle against stubbed SDK/react and drives
// register() + the poll path, asserting the composer hand-off and key actions.
import { copyFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// Copy the freshly built desktop bundle next to the stubs so `@hermes/plugin-sdk`
// and `react` resolve here, then import that copy (cache-busted: the file changes
// on every build). The repo build product — not the installed copy — is under test.
const SOURCE = process.env.PLUGIN_JS || path.resolve(here, '../desktop/plugin.js')
copyFileSync(SOURCE, new URL('./plugin.js', import.meta.url))

/** Dynamic import that TS cannot resolve at compile time (the file is a build product). */
const importFresh = new Function('specifier', 'return import(specifier)') as unknown as
  (specifier: string) => Promise<Record<string, unknown>>
const pluginModule = await importFresh(`./plugin.js?t=${Date.now()}`)
const plugin = pluginModule['default'] as { register(ctx: unknown): void }

/** Global scratch bag the plugin and this harness both reach through `globalThis`. */
const g = globalThis as unknown as Record<string, unknown>
g['window'] = globalThis
g['document'] = { visibilityState: 'visible' }
g['__focused'] = 'sess-42'

interface Contribution {
  area: string
  id: string
}

interface HarnessConfig {
  autoSend: boolean
  autoStart: boolean
  autoRestart: boolean
  keysEnabled: boolean
  history: boolean
  language: string
  gapMs: number
}

interface HarnessState {
  now: number
  pid: number
  uptimeMs: number
  state: string
  detail: null
  device: { id: string; name: string }
  battery: number
  diagnostics: Record<string, unknown>
  transcriber: Record<string, unknown>
  bridge: { exists: boolean }
  keys: {
    enabled: boolean
    map: Record<string, unknown>
    doubleMs: number
    longMs: number
    hidKeys: string[]
  }
  audio: { gapMs: number; maxMs: number; trimMs: number; cutoffHz: number }
  autoSend: boolean
  history: { enabled: boolean; limit: number; count: number }
  phrases: Record<string, string>
  config: HarnessConfig
  head: number
  bootAt: number
  logs: string[]
}

interface HarnessEvent {
  seq: number
  type: string
  at: number
  payload: Record<string, unknown>
}

interface FakeKeyEvent {
  code: string
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat: boolean
  preventDefault(): void
  stopPropagation(): void
}

const registered: Contribution[] = []
const disposers: Array<() => void> = []
const pending = new Map<string, (event: FakeKeyEvent) => void>()

/** Append one action to the shared `globalThis.__calls` bag (creates it on first use). */
const record = (...entry: unknown[]): void => {
  const existing = g['__calls']
  if (Array.isArray(existing)) (existing as unknown[][]).push(entry)
  else g['__calls'] = [entry]
}

const state: HarnessState = {
  now: Date.now(),
  pid: 1,
  uptimeMs: 1000,
  state: 'ready',
  detail: null,
  device: { id: 'dev', name: '遥控器' },
  battery: 80,
  diagnostics: { frames: 3, sessions: 1, retries: 0, battery: 80, lastUtterance: { text: '上一次' } },
  transcriber: { kind: 'sensevoice', language: 'zh', model: '/m/model.int8.onnx', ready: true },
  bridge: { exists: true },
  keys: {
    enabled: true,
    map: {
      Back: { single: 'stop', double: { action: 'phrase', name: '收到' } },
      ContextMenu: { single: 'submit' },
      Enter: { single: 'submit', double: 'new-session' },
      Home: { single: 'new-session' },
      // Chromecast 的输入源键：系统不认这个 usage，是唯一干净的「第二功能键」。
      InputSource: { single: 'new-session' }
    },
    doubleMs: 300,
    longMs: 550,
    hidKeys: ['Back', 'ContextMenu']
  },
  audio: { gapMs: 350, maxMs: 30000, trimMs: 200, cutoffHz: 100 },
  autoSend: false,
  history: { enabled: true, limit: 500, count: 0 },
  phrases: { 收到: '收到，我看一下。' },
  config: { autoSend: false, autoStart: true, autoRestart: true, keysEnabled: true, history: true, language: 'zh', gapMs: 350 },
  head: 0,
  bootAt: 1,
  logs: []
}

const queue: HarnessEvent[] = []
const ctx = {
  register: (c: Contribution) => { registered.push(c); return () => {} },
  registerMany: () => () => {},
  rest: async (path: string, _opts?: unknown): Promise<unknown> => {
    if (path.startsWith('/state')) return state
    if (path.startsWith('/events')) {
      const since = String(path.split('since=')[1])
      if (since === 'head') return { cursor: 0, head: 0, events: [] }
      const events = queue.filter(e => e.seq > Number(since))
      return {
        cursor: queue.length ? queue[queue.length - 1].seq : Number(since),
        head: queue.length,
        events,
        bootAt: state.bootAt
      }
    }
    if (path.startsWith('/history')) return { entries: [{ text: '历史一', at: Date.now() }] }
    if (path.startsWith('/logs')) return { logs: ['line'] }
    if (path === '/config') return { config: state.config }
    if (path === '/selftest') return { transcript: { text: '自检文本', audioSeconds: 1, inferenceSeconds: 0.1, selftest: true } }
    if (path === '/mock/transcript') return { transcript: { text: '模拟', at: Date.now() } }
    return { ok: true }
  },
  onDispose: (fn: () => void) => disposers.push(fn),
  onEvent: () => () => {},
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  addEventListener: (_target: unknown, type: string, listener: (event: FakeKeyEvent) => void) => {
    pending.set(type, listener)
    return () => {}
  },
  // prefs 里的 capture 提高到 true：DOM 通路只有在显式捕获时才动作，这里要能测到它。
  // 真实的默认值是 false（不抢键），对应插件里 `if (!prefs.capture) return` 那一行。
  storage: {
    get: (k: string, d: unknown) => (k === 'prefs' ? { ...(d as Record<string, unknown>), capture: true } : d),
    set: () => {},
    remove: () => {}
  },
  os: { openExternal: async () => true },
  pet: { say: (text: string) => { record('pet', text); return () => {} } },
  i18n: {},
  runAction: () => ({ ok: false }),
  files: {}
}

/** Read one property off an unknown value without asserting it exists. */
const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const calls = (): unknown[][] => (g['__calls'] as unknown[][] | undefined) ?? []
const clear = () => { g['__calls'] = [] }

plugin.register(ctx)
console.log('registered contributions:', registered.map(c => c.area + ':' + c.id).join(', '))
console.log('AREA CHECK', registered.length === 4 && registered.some(c => c.area === 'routes') ? 'PASS' : 'FAIL')

// 1) transcript 事件 → 插入草稿（inline）
queue.push({ seq: 1, type: 'transcript', at: Date.now(), payload: { text: '把这段话插进去', audioSeconds: 2.2 } })
await wait(900)
let c = calls()
const inserted = c.find(x => x[0] === 'insertText')
console.log('TRANSCRIPT INSERT', inserted && inserted[2] === '把这段话插进去' && field(inserted[3], 'mode') === 'inline' ? 'PASS' : 'FAIL', JSON.stringify(c))

// 2) Back 单击 → stop（session.interrupt）
clear()
queue.push({ seq: 2, type: 'key', at: Date.now(), payload: { code: 'Back', down: true } })
queue.push({ seq: 3, type: 'key', at: Date.now() + 80, payload: { code: 'Back', down: false } })
await wait(1200)
c = calls()
const stop = c.find(x => x[0] === 'request' && x[1] === 'session.interrupt')
console.log('SINGLE TAP STOP', stop ? 'PASS' : 'FAIL', JSON.stringify(c))

// 3) Back 双击 → 常用语插入
clear()
const t0 = Date.now()
queue.push({ seq: 4, type: 'key', at: t0, payload: { code: 'Back', down: true } })
queue.push({ seq: 5, type: 'key', at: t0 + 60, payload: { code: 'Back', down: false } })
queue.push({ seq: 6, type: 'key', at: t0 + 160, payload: { code: 'Back', down: true } })
queue.push({ seq: 7, type: 'key', at: t0 + 220, payload: { code: 'Back', down: false } })
await wait(1400)
c = calls()
const phrase = c.find(x => x[0] === 'insertText' && typeof x[2] === 'string' && x[2].includes('我看一下'))
const noStop = !c.some(x => x[0] === 'request')
console.log('DOUBLE TAP PHRASE', phrase && noStop ? 'PASS' : 'FAIL', JSON.stringify(c))

// 4) ContextMenu 单击 → 提交草稿
clear()
g['__draft'] = '正在写的内容'
queue.push({ seq: 8, type: 'key', at: Date.now(), payload: { code: 'ContextMenu', down: true } })
queue.push({ seq: 9, type: 'key', at: Date.now() + 40, payload: { code: 'ContextMenu', down: false } })
await wait(800)
c = calls()
console.log('SUBMIT ACTION', c.some(x => x[0] === 'submit' && x[2] === '正在写的内容') ? 'PASS' : 'FAIL', JSON.stringify(c))

// 5) selftest 转写不写进输入框
clear()
queue.push({ seq: 10, type: 'transcript', at: Date.now(), payload: { text: '自检文本', selftest: true } })
await wait(900)
console.log('SELFTEST SKIPPED', calls().length === 0 ? 'PASS' : 'FAIL', JSON.stringify(calls()))

// 6) DOM 通路：未设映射的键不动作（捕获开着也一样），已映射的 Enter 接管，Shift+Enter 放行
clear()
g['__draft'] = ''
const dom = (forType: string) => pending.get(forType)
let prevented = 0
const fakeEvent: FakeKeyEvent = { code: 'Space', key: ' ', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, preventDefault: () => prevented++, stopPropagation: () => {} }
dom('keydown')!(fakeEvent)
await wait(300)
console.log('DOM UNMAPPED KEY', calls().length === 0 && prevented === 0 ? 'PASS' : 'FAIL', JSON.stringify(calls()))

// 7) 物理键盘 Enter 在捕获开启时被接管（preventDefault + 映射动作）
clear()
g['__draft'] = '物理键盘草稿'
let pEnter = 0
const enter: FakeKeyEvent = { code: 'Enter', key: 'Enter', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, preventDefault: () => pEnter++, stopPropagation: () => {} }
dom('keydown')!(enter)
await wait(40)
dom('keyup')!(enter)
await wait(1000)
console.log('DOM ENTER CAPTURED', pEnter > 0 && calls().some(x => x[0] === 'submit') ? 'PASS' : 'FAIL', JSON.stringify(calls()))

// 8) Shift+Enter 必须原样放行（输入框里的换行不能被插件吞掉）
clear()
g['__draft'] = '换行不该被吞'
let pShift = 0
const shiftEnter: FakeKeyEvent = { ...enter, shiftKey: true, preventDefault: () => pShift++, stopPropagation: () => {} }
dom('keydown')!(shiftEnter)
await wait(1000)
console.log('SHIFT ENTER PASSTHROUGH', pShift === 0 && calls().length === 0 ? 'PASS' : 'FAIL', JSON.stringify(calls()))

// 7) 未知键不触发
clear()
queue.push({ seq: 11, type: 'key', at: Date.now(), payload: { code: 'AudioVolumeUp', down: true } })
await wait(700)
console.log('UNMAPPED KEY IGNORED', calls().length === 0 ? 'PASS' : 'FAIL', JSON.stringify(calls()))

// 8) autoSend=true 且草稿为空 → 直接发送
clear()
state.autoSend = true
state.config.autoSend = true
// 注意：引擎每 4 拍才刷新一次快照，等它拿到新配置
await wait(2200)
g['__draft'] = ''
queue.push({ seq: 12, type: 'transcript', at: Date.now(), payload: { text: '直接发送这句' } })
await wait(1200)
c = calls()
console.log('AUTOSEND', c.some(x => x[0] === 'submit' && x[2] === '直接发送这句') ? 'PASS' : 'FAIL', JSON.stringify(c))

// 9) InputSource 单击 → 新建会话（Chromecast 的第二功能键）
clear()
queue.push({ seq: 13, type: 'key', at: Date.now(), payload: { code: 'InputSource', down: true } })
queue.push({ seq: 14, type: 'key', at: Date.now() + 70, payload: { code: 'InputSource', down: false } })
await wait(1000)
c = calls()
console.log('INPUTSOURCE NEW SESSION', c.some(x => x[0] === 'newChat') ? 'PASS' : 'FAIL', JSON.stringify(c))

// 10) 守护进程重启（seq 回绕）后游标必须自愈，否则 since=旧cursor > head 会把事件全丢
//     （真实事故：daemon 重启后 cursor 停在 37，head 只有 34，按遥控器完全没反应）
clear()
state.bootAt = 2
queue.length = 0          // 新进程：seq 从 0 开始，head 归零
await wait(1200)          // 先让一拍轮询发现 bootAt 变了并把游标拉回 0
queue.push({ seq: 1, type: 'transcript', at: Date.now(), payload: { text: '重启后的第一句', audioSeconds: 1 } })
await wait(1400)
c = calls()
// 上一条 autoSend 测试把开关打开了，这里只断言「事件被处理了」：插入或提交都算。
console.log('CURSOR RESET ON REBOOT', c.some(x => (x[0] === 'insertText' || x[0] === 'submit') && x[2] === '重启后的第一句') ? 'PASS' : 'FAIL', JSON.stringify(c))

disposers.forEach(fn => { try { fn() } catch (e) { console.log('dispose error', e) } })
process.exit(0)
