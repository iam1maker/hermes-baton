// Profile render eval: renders the key-mapping table for the "active remote model".
// Feeds the real device table (the /state shape of sidecar/devices/*.json) into render and asserts:
//   1) under xiaomi only Back shows (volume keys only when configured) plus manually added keys
//      (unknown / not-reported-by-this-model, greyed out); legacy Enter / InputSource entries
//      (Chromecast defaults written into settings by older versions) never show;
//   2) under chromecast the union of that model's keys appears (Enter/Back/InputSource/arrows/Home…);
//   3) after switching profileId the same render refreshes to the new rows without re-registering;
//   4) defaultKeyMap only produces grey placeholders ("Default: X") and is never written into keyMap
//      (rendering performs zero /config calls);
//   5) profileId=null degrades to the legacy full key table plus the "not registered" hint (with devicesDir).
//   6) sttSummary() (speech-service card) maps kind / engine.ok / local.model to the expected
//      labels and flags, and every stt.* i18n key exists in both catalogues.
//
// UI copy is never hardcoded here: the built bundle exports the catalogues as `zhMessages` / `enMessages`,
// so every expected string is derived from the same source the renderer uses.
import { copyFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// Repository build product (src/desktop/plugin.tsx → desktop/plugin.js), not the installed copy.
const SOURCE = process.env.PLUGIN_JS || path.resolve(here, '../desktop/plugin.js')
let bootCount = 0

/** Global scratch bag the plugin and this eval both reach through `globalThis`. */
const g = globalThis as unknown as Record<string, unknown>
g['window'] = globalThis
g['document'] = { visibilityState: 'visible' }
g['__focused'] = 'sess-42'

/** Message catalogue tree, as exported by the bundle (shape mirrors `Messages`). */
type Catalog = Record<string, any>

const CHROMECAST_KEYS = ['Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'YouTube', 'Netflix', 'InputSource', 'Power', 'Back', 'AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute']
const XIAOMI_KEYS = ['Back', 'AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute']
const PHRASE_NAME = 'ack'
const REAL_KEYMAP: Record<string, unknown> = {
  Enter: { single: 'submit', double: 'new-session', long: 'swallow' },
  Back: { single: 'stop', double: { action: 'phrase', name: PHRASE_NAME } },
  InputSource: { single: 'new-session' }
}
const DEVICES_DIR = '/Users/1maker/.hermes/baton/devices'

// Backend labels are ASCII now; the renderer maps them through `deviceLabels`.
const chromecast = {
  id: 'chromecast-google-tv',
  label: 'Chromecast Remote',
  vendor: 'Google',
  keys: CHROMECAST_KEYS,
  hidKeys: ['Enter', 'Back', 'Home', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'InputSource', 'Power', 'Netflix', 'YouTube', 'AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute'],
  defaultKeyMap: {
    Enter: { single: 'submit', double: 'new-session', long: 'swallow' },
    Back: { single: 'stop', double: { action: 'phrase', name: PHRASE_NAME } },
    InputSource: { single: 'new-session' }
  },
  voiceHint: 'Hold the voice key (microphone icon), speak, then release.'
}
const xiaomi = {
  id: 'xiaomi-bt-remote-2',
  label: 'Xiaomi BT Remote 2',
  vendor: 'Xiaomi',
  keys: XIAOMI_KEYS,
  hidKeys: ['Back', 'AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute'],
  defaultKeyMap: {
    Back: { single: 'stop', double: { action: 'phrase', name: PHRASE_NAME } }
  },
  voiceHint: 'Hold the centre (voice) key, speak, then release.'
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
    device: { id: 'dev', name: 'Xiaomi BT Remote 2' },
    battery: 80,
    diagnostics: { frames: 0, sessions: 0, battery: 80 },
    transcriber: { kind: 'sensevoice', language: 'zh', model: '/m/model.int8.onnx', ready: true },
    bridge: { exists: true },
    keys: { enabled: true, map: keyMap, doubleMs: 300, longMs: 550, hidKeys: ['Back'] },
    audio: { gapMs: 350, maxMs: 30000, trimMs: 200, cutoffHz: 100 },
    autoSend: false,
    history: { enabled: false, limit: 500, count: 0 },
    phrases: { [PHRASE_NAME]: 'Acknowledged, looking into it.' },
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
  zh: Catalog
  en: Catalog
  sttSummary: (state: unknown) => Record<string, unknown>
}

/** Dynamic import that TS cannot resolve at compile time (the file is a build product). */
const importFresh = new Function('specifier', 'return import(specifier)') as unknown as
  (specifier: string) => Promise<Record<string, unknown>>

// One independent plugin module instance per phase (cache-bust import) + its own state/ctx/pref seed.
// `prefs.locale` is seeded to 'zh' so the assertions read the catalogue the renderer actually picked.
async function boot(seedUserKeys: string[], keyMap: Record<string, unknown>, profileId: string | null): Promise<Booted> {
  bootCount += 1
  copyFileSync(SOURCE, new URL('./plugin.js', import.meta.url))
  const mod = await importFresh(`./plugin.js?t=eval${bootCount}-${Date.now()}`)
  const plugin = mod['default'] as { register(ctx: unknown): void }
  const zh = mod['zhMessages'] as Catalog
  const en = mod['enMessages'] as Catalog
  const state = makeState(keyMap, profileId)
  const configLog: string[] = [] // no /config writes are allowed while rendering
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
      get: (k: string, d: unknown) => (k === 'prefs' ? { ...(d as Record<string, unknown>), capture: true, userKeys: seedUserKeys, locale: 'zh' } : d),
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
    dispose: () => disposers.forEach(fn => { try { fn() } catch {} }),
    zh,
    en,
    sttSummary: mod['sttSummary'] as (state: unknown) => Record<string, unknown>
  }
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const REFRESH = 2200 // the snapshot refreshes every 4th tick (400ms/tick); generous margin

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

/** Fill `{name}` placeholders of a catalogue template (same rule as the renderer's `fmt`). */
const fill = (template: string, vars: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (whole, key) => (key in vars ? vars[key] : whole))

/** Device display label exactly as the renderer resolves it: catalogue first, backend label second. */
const deviceLabel = (L: Catalog, profile: { id: string; label: string }): string =>
  (L.deviceLabels && L.deviceLabels[profile.id]) || profile.label

/** Sorted (key, leaf) paths of a catalogue tree; arrays count as leaves. */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return [prefix]
  if (!value || typeof value !== 'object') return [prefix]
  const out: string[] = []
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out.push(...keyPaths((value as Record<string, unknown>)[key], prefix ? prefix + '.' + key : key))
  }
  return out
}

let fails = 0
let checks = 0
function check(name: string, ok: boolean, detail?: unknown) {
  checks += 1
  if (!ok) fails += 1
  console.log(name, ok ? 'PASS' : 'FAIL', ok ? '' : JSON.stringify(detail))
}

/* ── Phase A: the real settings keyMap (Enter/Back/InputSource), no manual keys in prefs ── */
{
  const app = await boot([], { ...REAL_KEYMAP }, 'chromecast-google-tv')
  const L = app.zh
  const ccLabel = deviceLabel(L, chromecast)
  await wait(120)
  let tree = app.render()

  // A0) the en bundle must mirror the zh key shape exactly (same groups, same leaf paths)
  const zhPaths = keyPaths(app.zh)
  const enPaths = keyPaths(app.en)
  check('A0 EN/ZH KEY SHAPE', JSON.stringify(zhPaths) === JSON.stringify(enPaths),
    { onlyZh: zhPaths.filter(p => !enPaths.includes(p)), onlyEn: enPaths.filter(p => !zhPaths.includes(p)) })

  // A1) chromecast: the union of that model's keys (unconfigured volume keys stay hidden)
  const wantCC = ['Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'YouTube', 'Netflix', 'InputSource', 'Power', 'Back']
  check('A1 CHROMECAST ROWS', JSON.stringify(rowCodes(tree)) === JSON.stringify(wantCC), rowCodes(tree))

  // A2) device card model label + voiceHint; key-mapping hint carries the model name and its voiceHint
  const t = texts(tree)
  check('A2 MODEL LABEL', t.some(x => x.includes(ccLabel)), t.filter(x => x.includes('Chromecast')))
  check('A2 VOICE HINT', t.some(x => x.includes(chromecast.voiceHint)), t.filter(x => x.includes('voice key')))
  const keysHint = fill(L.keys.hintProfile, { label: ccLabel, hint: chromecast.voiceHint })
  check('A2 KEYS HINT', t.some(x => x.includes(keysHint)), null)

  // A3) switch to xiaomi (same render refreshes): only Back remains; Enter / InputSource never appear
  app.state.profileId = 'xiaomi-bt-remote-2'
  await wait(REFRESH)
  tree = app.render()
  const xmRows = rowCodes(tree)
  check('A3 XIAOMI ROWS ONLY BACK', JSON.stringify(xmRows) === JSON.stringify(['Back']), xmRows)
  check('A3 NO ENTER/SOURCE', !xmRows.includes('Enter') && !xmRows.includes('InputSource'), xmRows)

  // A4) volume keys are "shown when configured": only after AudioVolumeUp is mapped
  app.state.keys.map = { ...REAL_KEYMAP, AudioVolumeUp: { single: 'focus' } }
  await wait(REFRESH)
  tree = app.render()
  check('A4 VOLUME WHEN CONFIGURED', JSON.stringify(rowCodes(tree)) === JSON.stringify(['Back', 'AudioVolumeUp']), rowCodes(tree))

  // A5) profileId=null degrades to the legacy full table plus the "not registered" hint (with devicesDir)
  app.state.profileId = null
  await wait(REFRESH)
  tree = app.render()
  check('A5 LEGACY FULL TABLE', JSON.stringify(rowCodes(tree)) === JSON.stringify(['AudioVolumeUp', 'Back', 'Enter', 'InputSource']), rowCodes(tree))
  const t5 = texts(tree)
  const registerHint = fill(L.page.registerHint, { dir: DEVICES_DIR })
  check('A5 REGISTER HINT', t5.some(x => x.includes(registerHint)), t5.filter(x => x.includes(DEVICES_DIR)))

  // A6) defaultKeyMap only yields grey placeholders ("Default: X"); keyMap stays empty
  app.state.profileId = 'chromecast-google-tv'
  app.state.keys.map = {}
  await wait(REFRESH)
  tree = app.render()
  const enterRow = findRow(tree, 'Enter')
  const sel = (i: number) => cellProps(enterRow, i)
  check('A6 PLACEHOLDER SINGLE', firstOptionLabel(sel(1)) === fill(L.keys.defaultPrefix, { label: L.actions.submit }), optionsOf(sel(1))[0])
  check('A6 PLACEHOLDER DOUBLE', firstOptionLabel(sel(2)) === fill(L.keys.defaultPrefix, { label: L.actions.newSession }), optionsOf(sel(2))[0])
  check('A6 PLACEHOLDER LONG', firstOptionLabel(sel(3)) === fill(L.keys.defaultPrefix, { label: L.actions.swallow }), optionsOf(sel(3))[0])
  check('A6 PLACEHOLDER GRAY', prop(prop(sel(1), 'style'), 'color') === 'var(--ui-text-quaternary)', prop(sel(1), 'style'))
  const backRow = findRow(tree, 'Back')
  check('A6 PHRASE PLACEHOLDER', firstOptionLabel(cellProps(backRow, 2)) === fill(L.keys.defaultPrefix, { label: fill(L.actions.phraseQuoted, { name: PHRASE_NAME }) }), optionsOf(cellProps(backRow, 2))[0])

  // A7) "add mapping" select lists the keys of the current model that are not mapped yet
  const addSel = findKeyed(tree, 'sel')
  const addValues = [''].concat(CHROMECAST_KEYS)
  check('A7 ADD OPTIONS', addSel !== null && JSON.stringify(optionsOf(propsOf(addSel)).map(o => prop(o, 'value'))) === JSON.stringify(addValues), optionsOf(propsOf(addSel)).map(o => prop(o, 'value')))

  // A8) rendering writes nothing: defaultKeyMap never lands in keyMap
  check('A8 NO CONFIG WRITES', app.configLog.length === 0, app.configLog)
  check('A8 KEYMAP UNTOUCHED', JSON.stringify(app.state.keys.map) === '{}', app.state.keys.map)

  app.dispose()
}

/* ── Phase B: manually added keys (traced in prefs.userKeys) → unknown / not reported, greyed ── */
{
  const app = await boot(['Menu'], { ...REAL_KEYMAP, Menu: { single: 'focus' } }, 'chromecast-google-tv')
  const L = app.zh
  await wait(120)
  let tree = app.render()

  // B1) chromecast: model keys plus the manual key Menu at the tail
  const want = CHROMECAST_KEYS.slice(0, 11).concat(['Menu'])
  check('B1 CC ROWS WITH MANUAL KEY', JSON.stringify(rowCodes(tree)) === JSON.stringify(want), rowCodes(tree))
  const menuRow = findRow(tree, 'Menu')
  const menuTexts = menuRow ? texts(menuRow) : []
  check('B1 UNKNOWN TAG', menuTexts.includes(L.keys.unknown) && menuTexts.includes(L.keys.notReported), menuTexts)
  check('B1 GRAYED', opacityOf(menuRow) === 0.72, prop(propsOf(menuRow), 'style'))

  // B2) under xiaomi: Back plus the manual key Menu; legacy Enter/InputSource stay hidden
  app.state.profileId = 'xiaomi-bt-remote-2'
  await wait(REFRESH)
  tree = app.render()
  const xmRows = rowCodes(tree)
  check('B2 XIAOMI ROWS', JSON.stringify(xmRows) === JSON.stringify(['Back', 'Menu']), xmRows)

  // B3) deleting a row clears its trace: × → /config write (a user action, allowed) and prefs.userKeys loses it
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

/* ── Phase C: sttSummary (speech-service card) and its i18n keys ───────── */
{
  const app = await boot([], { ...REAL_KEYMAP }, 'chromecast-google-tv')
  const L = app.zh
  await wait(120)

  // C1) the four combinations of kind / engine.ok / local.model map to the expected labels and flags
  const READY_DOT = 'var(--ui-green)'
  const WAIT_DOT = 'var(--ui-orange)'
  const fixtures: unknown[] = [
    // local, engine installed, model downloaded
    { kind: 'sensevoice', ready: true, language: 'zh', local: { model: '/m/models/sensevoice.int8.onnx', precision: 'int8', problems: [] }, engine: { ok: true, path: '/s/sherpa/node_modules/sherpa-onnx-node' } },
    // local, engine installed, model missing (problems tell why)
    { kind: 'sensevoice', ready: false, language: 'zh', local: { model: null, precision: null, problems: ['model file missing', 'vad model missing'] }, engine: { ok: true, path: '/s/sherpa/node_modules/sherpa-onnx-node' } },
    // external service answers even though nothing is installed locally
    { kind: 'openai', ready: true, language: 'zh', local: { model: null, problems: [] }, engine: { ok: false, path: null }, external: { baseUrl: 'https://api.openai.com/v1', model: 'whisper-1', hasKey: true } },
    // not configured at all
    { kind: 'missing', ready: false, language: 'zh', local: { model: null, problems: [] }, engine: { ok: false, path: null } }
  ]
  const expected: unknown[] = [
    { kindLabel: L.stt.kindLocal, readyDot: READY_DOT, engineLabel: fill(L.stt.engineInstalled, { name: 'sherpa-onnx-node' }), modelLabel: 'sensevoice.int8.onnx' + L.common.dot + 'int8', engineMissing: false, needsInstall: false },
    { kindLabel: L.stt.kindLocal, readyDot: WAIT_DOT, engineLabel: fill(L.stt.engineInstalled, { name: 'sherpa-onnx-node' }), modelLabel: ['model file missing', 'vad model missing'].join(L.common.listSeparator), engineMissing: false, needsInstall: true },
    { kindLabel: L.stt.kindExternal, readyDot: READY_DOT, engineLabel: L.stt.engineMissing, modelLabel: L.stt.modelMissing, engineMissing: true, needsInstall: false },
    { kindLabel: L.stt.kindMissing, readyDot: WAIT_DOT, engineLabel: L.stt.engineMissing, modelLabel: L.stt.modelMissing, engineMissing: true, needsInstall: true }
  ]
  const actual = fixtures.map(f => app.sttSummary(f))
  check('C1 STTSUMMARY MAPPING', JSON.stringify(actual) === JSON.stringify(expected), actual)

  // C2) every stt.* key exists in both bundles as a non-empty string (A0 keeps the leaf shapes equal)
  const required = [
    'stt.card', 'stt.cardHint', 'stt.kindLocal', 'stt.kindExternal', 'stt.kindMissing', 'stt.ready', 'stt.attention',
    'stt.engine', 'stt.engineInstalled', 'stt.engineMissing', 'stt.installEngine', 'stt.model', 'stt.modelMissing',
    'stt.vad', 'stt.vadPresent', 'stt.vadMissing', 'stt.language', 'stt.download', 'stt.downloadFp32',
    'stt.jobRunning', 'stt.jobOk', 'stt.jobFailed', 'stt.installFailed', 'stt.external', 'stt.externalHint',
    'stt.baseUrl', 'stt.baseUrlPlaceholder', 'stt.modelField', 'stt.modelPlaceholder', 'stt.apiKey', 'stt.apiKeySet',
    'stt.apiKeyPlaceholder', 'stt.save', 'stt.saved'
  ]
  const leaf = (tree: unknown, dotted: string): unknown =>
    dotted.split('.').reduce((acc: unknown, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), tree)
  const bad = required.filter(p => {
    const zhLeaf = leaf(app.zh, p)
    const enLeaf = leaf(app.en, p)
    return typeof zhLeaf !== 'string' || !zhLeaf || typeof enLeaf !== 'string' || !enLeaf
  })
  check('C2 STT I18N KEYS', bad.length === 0, bad)

  app.dispose()
}

console.log('PROFILE RENDER EVAL', fails === 0 ? 'ALL PASS (' + checks + ' checks)' : fails + '/' + checks + ' FAILED')
process.exit(fails === 0 ? 0 : 1)
