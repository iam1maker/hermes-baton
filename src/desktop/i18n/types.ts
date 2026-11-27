/**
 * Message catalogue shape for the desktop half.
 *
 * One entry per user-facing string. Leaves are plain strings; `{name}` marks a
 * placeholder filled by `fmt()`. Adding a locale means implementing this whole
 * interface, so a missing translation is a type error rather than a blank label.
 */
export interface Messages {
  /* ── identity ────────────────────────────────────────────────────────── */
  plugin: {
    name: string
    description: string
  }
  nav: {
    title: string
  }
  palette: {
    title: string
    keywords: string[]
  }

  /* ── shared atoms ────────────────────────────────────────────────────── */
  common: {
    unknown: string
    running: string
    scanning: string
    /** Joins the segments of the status-chip tooltip. */
    separator: string
    /** Joins a value to its unit/annotation inside a line. */
    dot: string
    /** Joins a list of ids. */
    listSeparator: string
    /** Full-width space used as a visual gap in dense lines. */
    fullWidthSpace: string
  }

  /** Model ids → display names. Backend labels are ASCII; these are localised. */
  deviceLabels: Record<string, string>

  /** Daemon states used by the chip, the page badge and the legacy rows. */
  states: {
    ready: string
    capturing: string
    transcribing: string
    starting: string
    stopped: string
    error: string
  }

  /* ── status-bar chip ─────────────────────────────────────────────────── */
  chip: {
    offline: string
    device: string
    battery: string
    batteryLabel: string
    open: string
  }

  /* ── page header and page-level notices ──────────────────────────────── */
  page: {
    subtitle: string
    backendNotConnected: string
    remoteTriggered: string
    reconnect: string
    reconnectTitle: string
    startListening: string
    stopListening: string
    backendDown: string
    rival: string
    bluetoothTitle: string
    mockTitle: string
    mockText: string
    listenTitle: string
    listenActive: string
    listenButton: string
    noDevice: string
    modelLabel: string
    modelUnregistered: string
    registerHint: string
    scanHint: string
    noCandidates: string
    unnamedDevice: string
    connected: string
    connectable: string
    inUse: string
    buttons: {
      bluetooth: string
      mock: string
      selftest: string
      scan: string
      switch: string
      add: string
      load: string
      clear: string
      refresh: string
    }
  }

  /* ── cards ───────────────────────────────────────────────────────────── */
  cards: {
    link: string
    devices: string
    devicesHint: string
    voice: string
    voiceHint: string
    phrases: string
    phrasesHint: string
    keys: string
    audio: string
    audioHint: string
    history: string
    historyHint: string
    logs: string
  }

  /* ── settings fields ─────────────────────────────────────────────────── */
  fields: {
    afterRecognition: string
    afterRecognitionAuto: string
    afterRecognitionManual: string
    insertMode: string
    insertInline: string
    insertBlock: string
    notifyAfterInsert: string
    autoConnect: string
    autoConnectHint: string
    autoReconnect: string
    autoReconnectHint: string
    precision: string
    precisionFp32: string
    precisionInt8: string
    gap: string
    gapHint: string
    max: string
    maxHint: string
    trim: string
    trimHint: string
    cutoff: string
    cutoffHint: string
    language: string
    languageHint: string
    keyFilter: string
    keyFilterActive: string
    keyFilterAny: string
    keyFilterHint: string
    capture: string
    captureHint: string
    captureHintHid: string
    captureHintDefault: string
  }

  toggles: {
    on: string
    off: string
    directSend: string
    insertOnly: string
    notify: string
    silent: string
  }

  /* ── metric tiles ────────────────────────────────────────────────────── */
  tiles: {
    linkState: string
    live: string
    standby: string
    battery: string
    batteryUnknown: string
    batteryReplace: string
    batteryLow: string
    batteryFull: string
    engine: string
    sessions: string
    frames: string
    calls: string
    daemon: string
    modelLoad: string
    notStarted: string
  }

  /* ── 15s listen window ───────────────────────────────────────────────── */
  listen: {
    waiting: string
    capturing: string
    transcribing: string
    done: string
    timeout: string
    error: string
    unknownReason: string
  }

  selftest: {
    result: string
    empty: string
    fellBack: string
    emptyNote: string
  }

  /* ── key-map table ───────────────────────────────────────────────────── */
  keys: {
    tableKey: string
    single: string
    double: string
    long: string
    selectPlaceholder: string
    addMapping: string
    timing: string
    defaultPrefix: string
    unknown: string
    notReported: string
    unknownTitle: string
    deleteTitle: string
    emptyProfile: string
    emptyAll: string
    hintProfile: string
    hintGeneric: string
  }

  /* ── action names ────────────────────────────────────────────────────── */
  actions: {
    submit: string
    stop: string
    newSession: string
    swallow: string
    swallowLong: string
    focus: string
    none: string
    noAction: string
    stopGenerating: string
    createSession: string
    phraseQuoted: string
  }

  phrases: {
    deleteTitle: string
    namePlaceholder: string
    textPlaceholder: string
    empty: string
  }

  history: {
    emptyEnabled: string
    emptyDisabled: string
    loadFailed: string
    clearFailed: string
  }

  logs: {
    loadFailed: string
    empty: string
  }

  /* ── speech service card (local SenseVoice install + external STT) ───── */
  stt: {
    card: string
    cardHint: string
    /** Header badge: which service answers / how it is doing. */
    kindLocal: string
    kindExternal: string
    kindMissing: string
    ready: string
    attention: string
    /** Status rows. */
    engine: string
    engineInstalled: string
    engineMissing: string
    installEngine: string
    model: string
    modelMissing: string
    vad: string
    vadPresent: string
    vadMissing: string
    language: string
    /** Download buttons and the install job display. */
    download: string
    downloadFp32: string
    jobRunning: string
    jobOk: string
    jobFailed: string
    installFailed: string
    /** External STT section. */
    external: string
    externalHint: string
    baseUrl: string
    baseUrlPlaceholder: string
    modelField: string
    modelPlaceholder: string
    apiKey: string
    /** Status lines for the credential the store owns; there is no key field on the page. */
    keyFromStore: string
    keyMissing: string
    keyLegacy: string
    save: string
    saved: string
  }

  /* ── daemon notices (structured kinds + fallback) ────────────────────── */
  notices: {
    backendNotReady: string
    recognitionFailed: string
    failed: string
    empty: string
    tooShort: string
  }

  /* ── toasts ──────────────────────────────────────────────────────────── */
  toasts: {
    stopNoSession: string
    stopFailed: string
    sent: string
    insertedDraft: string
    noComposer: string
    inserted: string
    insertedWithSeconds: string
    submitNoSession: string
    submitNoAnswer: string
    submitDraftError: string
    newChatFailed: string
    phraseMissing: string
    phraseInsertFailed: string
    saveFailed: string
    devicesFound: string
    devicesNone: string
    devicesCached: string
    devicesNeedsRestart: string
    scanFailed: string
    switched: string
    settingsOpened: string
    settingsLaunched: string
    settingsManual: string
  }

  /** Pet bubble lines. */
  pet: {
    sent: string
  }

  /** Legacy status rows (kept for parity; no call site renders them). */
  rows: {
    link: string
    device: string
    unnamed: string
    battery: string
    recognition: string
    sessions: string
    sessionFrames: string
    lastTranscript: string
    lastError: string
    daemon: string
    uptime: string
  }
}
