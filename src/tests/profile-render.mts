// Profile render eval: 按「当前生效的遥控器型号」渲染按键映射表。
// 用真实设备表（sidecar/devices/*.json 的 /state 形态）喂 render，断言：
//   1) xiaomi 下键行只有 Back（音量键配了才显示）+ 手动加过的键（未知/该型号未上报，灰显），
//      历史遗留的 Enter / InputSource（旧版本写进 settings 的 Chromecast 默认）一律不显示；
//   2) chromecast 下出现该型号 keys 的并集（Enter/Back/InputSource/方向/Home 等）；
//   3) 切换 profileId 后同一个 render 刷新出新键行，不需要重新注册；
//   4) defaultKeyMap 只做灰字占位（「默认：X」），绝不写进 keyMap（渲染零 /config 调用）；
//   5) profileId=null 降级：老的全量按键表 + 「还没登记」提示（含 devicesDir）。
import { copyFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// 仓库构建产物（src/desktop/plugin.tsx → desktop/plugin.js），不是已安装副本。
const SOURCE = process.env.PLUGIN_JS || path.resolve(here, '../desktop/plugin.js')
let bootCount = 0

/** Global scratch bag the plugin and this eval both reach through `globalThis`. */
const g = globalThis as unknown as Record<string, unknown>
g['window'] = globalThis
g['document'] = { visibilityState: 'visible' }
g['__focused'] = 'sess-42'

const CHROMECAST_KEYS = ['Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'YouTube', 'Netflix', 'InputSource', 'Power', 'Back', 'AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute']
const XIAOMI_KEYS = ['Back', 'AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute']
const REAL_KEYMAP: Record<string, unknown> = {
  Enter: { single: 'submit', double: 'new-session', long: 'swallow' },
  Back: { single: 'stop', double: { action: 'phrase', name: '收到' } },
  InputSource: { single: 'new-session' }
}
const DEVICES_DIR = '/Users/1maker/.hermes/baton/devices'

const chromecast = {
  id: 'chromecast-google-tv',
  label: 'Chromecast with Google TV 遥控器',
  vendor: 'Google',
  keys: CHROMECAST_KEYS,
  hidKeys: ['Enter', 'Back', 'Home', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'InputSource', 'Power', 'Netflix', 'YouTube', 'AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute'],
  defaultKeyMap: {
    Enter: { single: 'submit', double: 'new-session', long: 'swallow' },
    Back: { single: 'stop', double: { action: 'phrase', name: '收到' } },
    InputSource: { single: 'new-session' }
  },
  voiceHint: '按住语音键（麦克风图标）说话，松手出字'
}
const xiaomi = {
  id: 'xiaomi-bt-remote-2',
  label: '小米蓝牙语音遥控器 2 / 2 Pro',
  vendor: 'Xiaomi',
  keys: XIAOMI_KEYS,
  hidKeys: ['Back', 'AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute'],
  defaultKeyMap: {
    Back: { single: 'stop', double: { action: 'phrase', name: '收到' } }
  },
  voiceHint: '按住中键（语音键）说话，松手出字'
}

interface RenderState {
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
  config: Record<string, unknown>
  head: number
  bootAt: number
  logs: string[]
  profileId: string | null
  profiles: unknown[]
  devicesDir: string
}

function makeState(keyMap: Record<string, unknown>, profileId: string | null): RenderState {
  return {
    now: Date.now(),
    pid: 1,
    uptimeMs: 1000,
    state: 'ready',
    detail: null,
    device: { id: 'dev', name: '小米蓝牙语音遥控器' },
    battery: 80,
    diagnostics: { frames: 0, sessions: 0, battery: 80 },
    transcriber: { kind: 'sensevoice', language: 'zh', model: '/m/model.int8.onnx', ready: true },
    bridge: { exists: true },
    keys: { enabled: true, map: keyMap, doubleMs: 300, longMs: 550, hidKeys: ['Back'] },
    audio: { gapMs: 350, maxMs: 30000, trimMs: 200, cutoffHz: 100 },
    autoSend: false,
    history: { enabled: false, limit: 500, count: 0 },
    phrases: { 收到: '收到，我看一下。' },
    config: { autoSend: false, autoStart: true, autoRestart: true, keysEnabled: true, history: false, language: 'zh', gapMs: 350 },
    head: 0,
    bootAt: 1,
    logs: [],
    profileId,
    profiles: [chromecast, xiaomi],
    devicesDir: DEVICES_DIR
  }
}

/** Contributions the plugin registers (only `routes` is rendered here). */
interface Contribution {
  area: string
  render?: () => unknown
}

interface Booted {
  state: RenderState
  configLog: string[]
  storageLog: Array<{ k: string; v: unknown }>
  render: () => unknown
  dispose: () => void
}

/** Dynamic import that TS cannot resolve at compile time (the file is a build product). */
const importFresh = new Function('specifier', 'return import(specifier)') as unknown as
  (specifier: string) => Promise<Record<string, unknown>>

// 每个 phase 一个独立的插件模块实例（cache-bust import）+ 自己的 state/ctx/偏好种子。
async function boot(seedUserKeys: string[], keyMap: Record<string, unknown>, profileId: string | null): Promise<Booted> {
  bootCount += 1
  copyFileSync(SOURCE, new URL('./plugin.js', import.meta.url))
  const mod = await importFresh(`./plugin.js?t=eval${bootCount}-${Date.now()}`)
  const plugin = mod['default'] as { register(ctx: unknown): void }
  const state = makeState(keyMap, profileId)
  const configLog: string[] = [] // 渲染期间绝不允许出现 /config 写入
  const storageLog: Array<{ k: string; v: unknown }> = []
  const registered: Contribution[] = []
  const disposers: Array<() => void> = []
  const ctx = {
    register: (c: Contribution) => { registered.push(c); return () => {} },
    registerMany: () => () => {},
    rest: async (path: string): Promise<unknown> => {
      if (path.startsWith('/state')) return state
      if (path.startsWith('/events')) return { cursor: 0, head: 0, events: [], bootAt: state.bootAt }
      if (path === '/config') { configLog.push('config'); return { config: state.config } }
      return { ok: true }
    },
    onDispose: (fn: () => void) => disposers.push(fn),
    onEvent: () => () => {},
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    addEventListener: () => () => {},
    storage: {
      get: (k: string, d: unknown) => (k === 'prefs' ? { ...(d as Record<string, unknown>), capture: true, userKeys: seedUserKeys } : d),
      set: (k: string, v: unknown) => { storageLog.push({ k, v }) },
      remove: () => {}
    },
    os: { openExternal: async () => true },
    pet: { say: () => () => {} },
    i18n: {},
    runAction: () => ({ ok: false }),
    files: {}
  }
  plugin.register(ctx)
  const render = (): unknown => {
    const routes = registered.find(c => c.area === 'routes')!
    return routes.render ? routes.render() : null
  }
  return {
    state,
    configLog,
    storageLog,
    render,
    dispose: () => disposers.forEach(fn => { try { fn() } catch {} })
  }
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const REFRESH = 2200 // 快照每 4 拍（400ms/拍）刷新一次，留足余量

/** A rendered element: anything with `props` (and optionally a function `type`). */
type Node = Record<string, unknown>

const propsOf = (node: unknown): Record<string, unknown> | null => {
  if (typeof node !== 'object' || node === null) return null
  const props = (node as Node)['props']
  return typeof props === 'object' && props !== null ? (props as Record<string, unknown>) : null
}

/** Read one property off an unknown value (no assumption that it exists). */
const prop = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined

function walk(node: unknown, visit: (n: Node) => void): void {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const n of node) walk(n, visit); return }
  const n = node as Node
  if (typeof n['type'] === 'function') {
    visit(n)
    walk((n['type'] as (p: Record<string, unknown>) => unknown)(propsOf(n) || {}), visit)
    return
  }
  if (n['props']) { visit(n); walk(propsOf(n)?.children, visit) }
}

function rowCodes(tree: unknown): string[] {
  const out: string[] = []
  walk(tree, n => {
    const k = propsOf(n)?.['key']
    if (typeof k === 'string' && k.slice(0, 4) === 'map-') out.push(k.slice(4))
  })
  return out
}

function findRow(tree: unknown, code: string): Node | null {
  let found: Node | null = null
  walk(tree, n => { if (!found && propsOf(n)?.['key'] === 'map-' + code) found = n })
  return found
}

function findKeyed(tree: unknown, key: string): Node | null {
  let found: Node | null = null
  walk(tree, n => { if (!found && propsOf(n)?.['key'] === key) found = n })
  return found
}

function texts(tree: unknown): string[] {
  const out: string[] = []
  const push = (v: unknown) => { if (typeof v === 'string') out.push(v) }
  walk(tree, n => {
    const kids = propsOf(n)?.['children']
    if (Array.isArray(kids)) kids.forEach(push)
    else push(kids)
  })
  return out
}

/** `props.children` of a row, as an array (a single child counts as one cell). */
const cellsOf = (node: Node | null): unknown[] => {
  const kids = node ? propsOf(node)?.['children'] : undefined
  return Array.isArray(kids) ? kids : []
}

/** `props` of the i-th cell in a row, or null when the row/index is missing. */
const cellProps = (node: Node | null, index: number): Record<string, unknown> | null => propsOf(cellsOf(node)[index])

/** `props.options` of a cell, as an array. */
const optionsOf = (p: Record<string, unknown> | null): unknown[] => {
  const options = p ? p['options'] : undefined
  return Array.isArray(options) ? options : []
}

/** `label` of the first option of a cell (`select` placeholder / default). */
const firstOptionLabel = (p: Record<string, unknown> | null): unknown => prop(optionsOf(p)[0], 'label')

/** `style.opacity` of a row (grayed-out manual keys use 0.72). */
const opacityOf = (node: Node | null): unknown => prop(prop(propsOf(node), 'style'), 'opacity')

let fails = 0
let checks = 0
function check(name: string, ok: boolean, detail?: unknown) {
  checks += 1
  if (!ok) fails += 1
  console.log(name, ok ? 'PASS' : 'FAIL', ok ? '' : JSON.stringify(detail))
}

/* ── Phase A：真实 settings 的 keyMap（Enter/Back/InputSource），偏好里没有手动键 ── */
{
  const app = await boot([], { ...REAL_KEYMAP }, 'chromecast-google-tv')
  await wait(120)
  let tree = app.render()

  // A1) chromecast：该型号 keys 的并集（未配的音量键按「若用户配了」不显示）
  const wantCC = ['Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'YouTube', 'Netflix', 'InputSource', 'Power', 'Back']
  check('A1 CHROMECAST ROWS', JSON.stringify(rowCodes(tree)) === JSON.stringify(wantCC), rowCodes(tree))

  // A2) 设备卡型号 label + voiceHint；按键映射 hint 含型号名 +「这台遥控器的键」
  const t = texts(tree)
  check('A2 MODEL LABEL', t.some(x => x.includes('Chromecast with Google TV 遥控器')), t.filter(x => x.includes('Chromecast')))
  check('A2 VOICE HINT', t.some(x => x.includes('按住语音键（麦克风图标）说话')), t.filter(x => x.includes('语音')))
  check('A2 KEYS HINT', t.some(x => x.includes('这台遥控器的键')), null)

  // A3) 切到小米（同一 render 刷新）：只剩 Back；Enter / InputSource 一律不出现
  app.state.profileId = 'xiaomi-bt-remote-2'
  await wait(REFRESH)
  tree = app.render()
  const xmRows = rowCodes(tree)
  check('A3 XIAOMI ROWS ONLY BACK', JSON.stringify(xmRows) === JSON.stringify(['Back']), xmRows)
  check('A3 NO ENTER/SOURCE', !xmRows.includes('Enter') && !xmRows.includes('InputSource'), xmRows)

  // A4) 音量键「若用户配了」：配上 AudioVolumeUp 才出行
  app.state.keys.map = { ...REAL_KEYMAP, AudioVolumeUp: { single: 'focus' } }
  await wait(REFRESH)
  tree = app.render()
  check('A4 VOLUME WHEN CONFIGURED', JSON.stringify(rowCodes(tree)) === JSON.stringify(['Back', 'AudioVolumeUp']), rowCodes(tree))

  // A5) profileId=null 降级：老的全量表 + 「还没登记」提示（含 devicesDir）
  app.state.profileId = null
  await wait(REFRESH)
  tree = app.render()
  check('A5 LEGACY FULL TABLE', JSON.stringify(rowCodes(tree)) === JSON.stringify(['AudioVolumeUp', 'Back', 'Enter', 'InputSource']), rowCodes(tree))
  const t5 = texts(tree)
  check('A5 REGISTER HINT', t5.some(x => x.includes('还没登记') && x.includes(DEVICES_DIR)), t5.filter(x => x.includes('登记')))

  // A6) defaultKeyMap 灰字占位（默认：X），不写进 keyMap
  app.state.profileId = 'chromecast-google-tv'
  app.state.keys.map = {}
  await wait(REFRESH)
  tree = app.render()
  const enterRow = findRow(tree, 'Enter')
  const sel = (i: number) => cellProps(enterRow, i)
  check('A6 PLACEHOLDER SINGLE', firstOptionLabel(sel(1)) === '默认：提交', optionsOf(sel(1))[0])
  check('A6 PLACEHOLDER DOUBLE', firstOptionLabel(sel(2)) === '默认：新会话', optionsOf(sel(2))[0])
  check('A6 PLACEHOLDER LONG', firstOptionLabel(sel(3)) === '默认：吞掉', optionsOf(sel(3))[0])
  check('A6 PLACEHOLDER GRAY', prop(prop(sel(1), 'style'), 'color') === 'var(--ui-text-quaternary)', prop(sel(1), 'style'))
  const backRow = findRow(tree, 'Back')
  check('A6 PHRASE PLACEHOLDER', firstOptionLabel(cellProps(backRow, 2)) === '默认：常用语「收到」', optionsOf(cellProps(backRow, 2))[0])

  // A7) 「添加映射」下拉 = 当前型号 keys 里还没映射的那些
  const addSel = findKeyed(tree, 'sel')
  const addValues = [''].concat(CHROMECAST_KEYS)
  check('A7 ADD OPTIONS', addSel !== null && JSON.stringify(optionsOf(propsOf(addSel)).map(o => prop(o, 'value'))) === JSON.stringify(addValues), optionsOf(propsOf(addSel)).map(o => prop(o, 'value')))

  // A8) 渲染零写入：defaultKeyMap 没被写进 keyMap
  check('A8 NO CONFIG WRITES', app.configLog.length === 0, app.configLog)
  check('A8 KEYMAP UNTOUCHED', JSON.stringify(app.state.keys.map) === '{}', app.state.keys.map)

  app.dispose()
}

/* ── Phase B：手动加过的键（prefs.userKeys 留痕）→ 未知/该型号未上报，灰显 ───── */
{
  const app = await boot(['Menu'], { ...REAL_KEYMAP, Menu: { single: 'focus' } }, 'chromecast-google-tv')
  await wait(120)
  let tree = app.render()

  // B1) chromecast：型号键 + 尾部手动键 Menu
  const want = CHROMECAST_KEYS.slice(0, 11).concat(['Menu'])
  check('B1 CC ROWS WITH MANUAL KEY', JSON.stringify(rowCodes(tree)) === JSON.stringify(want), rowCodes(tree))
  const menuRow = findRow(tree, 'Menu')
  const menuTexts = menuRow ? texts(menuRow) : []
  check('B1 UNKNOWN TAG', menuTexts.includes('未知') && menuTexts.includes('该型号未上报'), menuTexts)
  check('B1 GRAYED', opacityOf(menuRow) === 0.72, prop(propsOf(menuRow), 'style'))

  // B2) 小米下：Back + 手动键 Menu；Enter/InputSource（历史遗留）仍隐藏
  app.state.profileId = 'xiaomi-bt-remote-2'
  await wait(REFRESH)
  tree = app.render()
  const xmRows = rowCodes(tree)
  check('B2 XIAOMI ROWS', JSON.stringify(xmRows) === JSON.stringify(['Back', 'Menu']), xmRows)

  // B3) 删行清留痕：× → /config 写入（用户动作，允许）且 prefs.userKeys 移除
  const menuRow2 = findRow(tree, 'Menu')
  const delBtn = menuRow2 ? cellsOf(menuRow2)[4] : undefined
  const onClick = prop(propsOf(delBtn), 'onClick')
  if (typeof onClick === 'function') (onClick as () => void)()
  await wait(300)
  check('B3 DELETE HITS CONFIG', app.configLog.length === 1, app.configLog)
  const lastSet = app.storageLog.filter(s => s.k === 'prefs').pop()
  check('B3 PROVENANCE CLEARED', lastSet !== undefined && JSON.stringify(prop(lastSet.v, 'userKeys')) === '[]', lastSet)

  app.dispose()
}

console.log('PROFILE RENDER EVAL', fails === 0 ? 'ALL PASS (' + checks + ' checks)' : fails + '/' + checks + ' FAILED')
process.exit(fails === 0 ? 0 : 1)
