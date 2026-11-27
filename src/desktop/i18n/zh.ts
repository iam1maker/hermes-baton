import type { Messages } from './types'

/** Chinese catalogue — the source of truth for wording. */
export const zh: Messages = {
  plugin: {
    name: 'Baton',
    description:
      '蓝牙语音遥控器：说话即插入本地识别的文字，按键可映射为提交/停止/新建会话/常用语，支持多型号'
  },
  nav: {
    title: 'Baton'
  },
  palette: {
    title: 'Baton',
    keywords: ['mic', 'voice', 'dictation', 'remote', '语音', '麦克风', '遥控器', '听写']
  },
  common: {
    unknown: '未知',
    running: '运行中…',
    scanning: '扫描中…',
    separator: '｜',
    dot: ' · ',
    listSeparator: '、',
    fullWidthSpace: '　'
  },
  deviceLabels: {
    'xiaomi-bt-remote-2': '小米蓝牙语音遥控器 2',
    'chromecast-google-tv': 'Chromecast 遥控器'
  },
  states: {
    ready: '就绪',
    capturing: '收音中',
    transcribing: '识别中',
    starting: '连接中',
    stopped: '已停止',
    error: '异常'
  },
  chip: {
    offline: '未连接',
    device: '设备 {device}',
    battery: '电量 {level}%',
    batteryLabel: '电量 {level}%',
    open: '点击打开设置'
  },
  page: {
    subtitle: '{device}　·　SenseVoice 本机识别 · {language} · {model}',
    backendNotConnected: '后端未连接',
    remoteTriggered: '遥控器触发',
    reconnect: '重连',
    reconnectTitle: '重新扫描并连接遥控器',
    startListening: '开始监听',
    stopListening: '停止监听',
    backendDown:
      '后端不可达：{error}　（网关内的 Python 侧会按需拉起 Node 守护进程；若持续失败，看 ~/.hermes/baton/daemon.out）',
    rival:
      '另一个 atvv-link 正在跑（pid {pids}）：它和本插件抢同一台遥控器的连接，表现为「连上就掉」或「收不到音频」。请退出 DSH 的无线麦后再点「重连」。',
    bluetoothTitle: '打开「系统设置 ▸ 隐私与安全性 ▸ 蓝牙」，把 Hermes 勾上，然后点「重连」',
    mockTitle: '走和真实语音相同的通路，验证「转写 → 输入框」，不需要遥控器',
    mockText: '这是一条模拟语音（{stamp}）',
    listenTitle: '开一个 15 秒窗口：期间按一次遥控器语音键说话，只显示文字，不改输入框',
    listenActive: '窗口开着 · {remain}s',
    listenButton: '窗口自检 15 秒',
    noDevice: '未连接设备',
    modelLabel: '型号',
    modelUnregistered: '未登记（下面按键映射按通用全量表显示）',
    registerHint: '这个型号还没登记，把它的键表加进 {dir}/<型号>.json 就会自动出现。',
    scanHint: '点「扫描设备」列出系统里已连接和正在广播的遥控器（只读，不影响当前链路，约 4 秒）。',
    noCandidates: '没发现候选设备：先在 系统设置 ▸ 蓝牙 里把遥控器配对并连接。',
    unnamedDevice: '（未命名设备）',
    connected: '已连接',
    connectable: '可连接',
    inUse: '使用中',
    buttons: {
      bluetooth: '蓝牙授权',
      mock: '模拟一条语音',
      selftest: '识别自检',
      scan: '扫描设备',
      switch: '切换',
      add: '添加',
      load: '载入',
      clear: '清空',
      refresh: '刷新'
    }
  },
  cards: {
    link: '链路',
    devices: '遥控器',
    devicesHint:
      '支持多台 ATVV 语音遥控器（小米蓝牙语音遥控器、Chromecast with Google TV 等）。一条桥同一时刻只连一台，切换后会自动重连。',
    voice: '语音落地',
    voiceHint:
      '遥控器语音键说话 → 本机 SenseVoice 识别 → 文本进入当前输入框。识别在本机完成，音频不出机器。',
    phrases: '常用语',
    phrasesHint: '在「按键映射」里选「常用语」，一句话直接落地。',
    keys: '按键映射',
    audio: '收音参数',
    audioHint:
      '默认值来自 DSH 那套调好的：350ms 断句、30s 上限、200ms 掐头、100Hz 高通。听不清或吃字时再动。',
    history: '语音历史',
    historyHint: '仅存本机；打开开关后才写入。',
    logs: '守护进程日志'
  },
  fields: {
    afterRecognition: '识别后',
    afterRecognitionAuto: '草稿为空时直接发送，有草稿则插入',
    afterRecognitionManual: '只写进输入框，发送仍由你按 Enter',
    insertMode: '插入方式',
    insertInline: '同一行',
    insertBlock: '另起一段',
    notifyAfterInsert: '插入后提示',
    autoConnect: '自动连接',
    autoConnectHint: '守护进程启动后立即监听遥控器',
    autoReconnect: '断线自动重连',
    autoReconnectHint: '蓝牙掉线后自己重试，不用手动点',
    precision: '识别精度',
    precisionFp32: 'fp32 权重：更准，推理约 +0.3s；切换后立刻重载模型',
    precisionInt8: 'int8 量化权重：最快、内存最省',
    gap: '断句静音',
    gapHint: '静音多久算说完一句',
    max: '单次上限',
    maxHint: '超过就强制断句',
    trim: '掐头',
    trimHint: '切掉开头的按键 / 气流噪声',
    cutoff: '高通滤波',
    cutoffHint: '滤掉低频轰鸣',
    language: '识别语言',
    languageHint: 'zh / en / ja / ko / yue',
    keyFilter: '按键归属',
    keyFilterActive: '只有当前设备',
    keyFilterAny: '两台都认',
    keyFilterHint:
      '默认只有当前生效的那台管事（另一台的按键被忽略并记一条日志），跟语音键走同一台。音量键不在此列，始终归 macOS。',
    capture: '捕获键盘按键',
    captureHint:
      '只有「桥拿不到的键」才需要它：打开后插件改从键盘事件里认键，普通键盘的 Enter / Home 也会被一起接管。',
    captureHintHid: '这台遥控器上报 {keys}（桥直通），映射这些键不用开。',
    captureHintDefault: '这台遥控器上报 Back + 音量键（桥直通），映射这些键不用开。'
  },
  toggles: {
    on: '开',
    off: '关',
    directSend: '直接发送',
    insertOnly: '只插入',
    notify: '提示',
    silent: '不提示'
  },
  tiles: {
    linkState: '链路状态',
    live: '实时采集中',
    standby: '蓝牙桥待命',
    battery: '遥控器电量',
    batteryUnknown: '未上报',
    batteryReplace: '该换电池了',
    batteryLow: '电量偏低',
    batteryFull: '电量充足',
    engine: '识别引擎',
    sessions: '语音会话',
    frames: '累计 {frames} 帧音频',
    calls: '次 · 识别 {calls} 次',
    daemon: '守护进程',
    modelLoad: '模型加载 {ms}ms',
    notStarted: '未启动'
  },
  listen: {
    waiting: '按下遥控器语音键，说一句，松手即识别（剩 {remain}s）',
    capturing: '正在采集…松手后开始识别（剩 {remain}s）',
    transcribing: '识别中…',
    done: '窗口内识别：「{text}」（{inference}s 推理 / {audio}s 音频）· 未写入输入框',
    timeout:
      '15 秒内没收到按键：确认遥控器已连接、没被 DSH 抢占，并看下面的守护进程日志有没有 [hid] / [atvv] 行',
    error: '识别失败：{reason}',
    unknownReason: '未知原因'
  },
  selftest: {
    result: '自检结果：「{text}」（{inference}s 推理 / {audio}s 音频）',
    empty: '自检结果为空（{audio}s 音频）',
    fellBack: '　（测试音频没识别出文字，已自动改用内置样本）',
    emptyNote: '　（连内置样本都没识别出文字——模型或音频通路有问题，看日志）'
  },
  keys: {
    tableKey: '键',
    single: '单击',
    double: '双击',
    long: '长按',
    selectPlaceholder: '选择键名…',
    addMapping: '添加映射',
    timing: '双击窗口 {double}ms · 长按 {long}ms',
    defaultPrefix: '默认：{label}',
    unknown: '未知',
    notReported: '该型号未上报',
    unknownTitle: '这个键不在当前型号的键表里：是你手动添加的，保留显示',
    deleteTitle: '删除这条映射',
    emptyProfile: '这个型号的键还没配任何映射（音量键配了才显示）。在下面选一个键名添加。',
    emptyAll: '还没有映射。在下面选一个键名添加。',
    hintProfile: '{label}：这台遥控器的键。{hint}',
    hintGeneric:
      '单击 / 双击 / 长按三种手势。Back、ContextMenu 与媒体键由蓝牙桥直接上报；Enter、Home 等键需要打开下面的「捕获键盘」。这个型号还没登记，把它的键表加进 {dir}/<型号>.json 就会自动出现。'
  },
  actions: {
    submit: '提交',
    stop: '停止',
    newSession: '新会话',
    swallow: '吞掉',
    swallowLong: '吞掉（不做任何事）',
    focus: '聚焦输入框',
    none: '忽略',
    noAction: '（无）',
    stopGenerating: '停止生成',
    createSession: '新建会话',
    phraseQuoted: '常用语「{name}」'
  },
  phrases: {
    deleteTitle: '删除这条常用语',
    namePlaceholder: '名称',
    textPlaceholder: '插入的文字',
    empty: '还没有常用语，在下面加一条。'
  },
  history: {
    emptyEnabled: '还没有落盘记录。',
    emptyDisabled: '历史记录已关闭，识别结果不落盘（上面的开关打开后才会写入）。',
    loadFailed: '读取历史失败：{error}',
    clearFailed: '清空失败：{error}'
  },
  logs: {
    loadFailed: '读取日志失败：{error}',
    empty: '（点右上角刷新读取最近 60 行）'
  },
  stt: {
    card: '语音服务',
    cardHint: '本机 SenseVoice 识别所需的一切都在这里：引擎、模型、VAD，缺什么装什么；也可以改用外部识别服务。',
    kindLocal: '本地 SenseVoice',
    kindExternal: '外部服务',
    kindMissing: '未配置',
    ready: '就绪',
    attention: '待处理',
    engine: '引擎',
    engineInstalled: '已安装（{name}）',
    engineMissing: '未安装',
    installEngine: '安装引擎',
    model: '本地模型',
    modelMissing: '未下载',
    vad: 'VAD 模型',
    vadPresent: '已就绪（{name}）',
    vadMissing: '缺失',
    language: '识别语言',
    download: '下载本地模型',
    downloadFp32: '下载（含 fp32）',
    jobRunning: '安装中…',
    jobOk: '已完成',
    jobFailed: '失败：{error}',
    installFailed: '安装失败：{error}',
    external: '外部识别服务',
    externalHint: '只有这个模式会把音频送出本机；本地识别的音频不出机器。',
    baseUrl: '接口地址',
    baseUrlPlaceholder: 'https://api.openai.com/v1',
    modelField: '模型',
    modelPlaceholder: 'whisper-1',
    apiKey: 'API 密钥',
    apiKeySet: '********（已保存；留空则不修改）',
    apiKeyPlaceholder: 'sk-...',
    save: '保存',
    saved: '语音服务设置已保存'
  },
  notices: {
    backendNotReady: '插件后端未就绪',
    recognitionFailed: '识别失败',
    failed: '识别失败：{detail}',
    empty: '没听清，再说一次？',
    tooShort: '这条太短了（{ms}ms），按住语音键多说两个字'
  },
  toasts: {
    stopNoSession: '没有聚焦的会话，无法停止',
    stopFailed: '停止失败：{error}',
    sent: '🎙 已发送',
    insertedDraft: '语音已插入（草稿非空，未自动发送）',
    noComposer: '语音识别完成，但当前没有可写入的输入框：{text}',
    inserted: '已插入语音',
    insertedWithSeconds: '已插入语音（{secs}）',
    submitNoSession: '没有聚焦的会话，无法提交',
    submitNoAnswer: '提交失败：输入框没有应答',
    submitDraftError: '提交失败：读取草稿出错',
    newChatFailed: '新建会话失败',
    phraseMissing: '常用语「{name}」不存在',
    phraseInsertFailed: '常用语插入失败：没有输入框应答',
    saveFailed: '保存失败：{error}',
    devicesFound: '发现 {count} 台候选遥控器',
    devicesNone: '没发现候选设备：先在 系统设置 ▸ 蓝牙 里配对连接',
    devicesCached: '这是守护进程缓存的 {count} 台设备（实时扫描需重启一次应用），可以直接切换。',
    devicesNeedsRestart: '设备扫描要重启一次 Hermes 应用才可用（网关路由不热更新）。眼下可以直接让我帮你切换。',
    scanFailed: '扫描失败：{error}',
    switched: '已切换到 {name}，桥正在重连',
    settingsOpened: '已打开 系统设置 ▸ 隐私与安全性 ▸ 蓝牙：给 Hermes 勾上，然后点「重连」',
    settingsLaunched: '系统设置已打开：切到 隐私与安全性 ▸ 蓝牙，勾选 Hermes，再回来点「重连」',
    settingsManual: '手动打开：系统设置 ▸ 隐私与安全性 ▸ 蓝牙 → 勾选 Hermes → 回来点「重连」'
  },
  pet: {
    sent: '🎙 已发送'
  },
  rows: {
    link: '链路',
    device: '设备',
    unnamed: '未命名',
    battery: '电量',
    recognition: '识别',
    sessions: '语音会话',
    sessionFrames: '{sessions} 次 / {frames} 帧',
    lastTranscript: '上次转写',
    lastError: '最近错误',
    daemon: '守护进程',
    uptime: 'pid {pid} · 运行 {minutes} 分钟'
  }
}
