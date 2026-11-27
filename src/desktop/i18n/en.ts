import type { Messages } from './types'

/** English catalogue — written for meaning, not word-for-word. */
export const en: Messages = {
  plugin: {
    name: 'Baton',
    description:
      'Voice remote for Hermes: hold the mic key to insert locally transcribed text, map keys to submit / stop / new session / canned phrases, and switch between remote models.'
  },
  nav: {
    title: 'Baton'
  },
  palette: {
    title: 'Baton',
    keywords: ['mic', 'voice', 'dictation', 'remote', 'speech', 'microphone', 'transcribe', 'remote control']
  },
  common: {
    unknown: 'unknown',
    running: 'Working…',
    scanning: 'Scanning…',
    separator: ' | ',
    dot: ' · ',
    listSeparator: ', ',
    fullWidthSpace: ' '
  },
  deviceLabels: {
    'xiaomi-bt-remote-2': 'Xiaomi BT Remote 2',
    'chromecast-google-tv': 'Chromecast Remote'
  },
  states: {
    ready: 'Ready',
    capturing: 'Recording',
    transcribing: 'Transcribing',
    starting: 'Connecting',
    stopped: 'Stopped',
    error: 'Error'
  },
  chip: {
    offline: 'Offline',
    device: 'Device {device}',
    battery: 'Battery {level}%',
    batteryLabel: 'Battery {level}%',
    open: 'Click to open settings'
  },
  page: {
    subtitle: '{device} · On-device SenseVoice · {language} · {model}',
    backendNotConnected: 'Backend offline',
    remoteTriggered: 'triggered by remote',
    reconnect: 'Reconnect',
    reconnectTitle: 'Rescan and reconnect the remote',
    startListening: 'Start listening',
    stopListening: 'Stop listening',
    backendDown:
      'Backend unreachable: {error} (the gateway starts the Node daemon on demand; if this keeps happening, check ~/.hermes/baton/daemon.out)',
    rival:
      'Another atvv-link is running (pid {pids}). It competes for the same remote, which shows up as "connects then drops" or "no audio". Quit the DSH wireless mic, then click Reconnect.',
    bluetoothTitle: 'Open System Settings ▸ Privacy & Security ▸ Bluetooth, enable Hermes, then click Reconnect',
    mockTitle: 'Runs the same path as real speech to verify transcript → composer; no remote needed',
    mockText: 'This is a simulated utterance ({stamp})',
    listenTitle: 'Opens a 15-second window: press the voice key once and speak. Text is shown only, never inserted.',
    listenActive: 'Window open · {remain}s',
    listenButton: '15s self-test',
    noDevice: 'No device connected',
    modelLabel: 'Model',
    modelUnregistered: 'Not registered (the key map below uses the full generic table)',
    registerHint: 'This model is not registered yet. Add its key table to {dir}/<model>.json and it shows up automatically.',
    scanHint: 'Click Scan to list remotes already connected or advertising (read-only, ~4s, does not disturb the current link).',
    noCandidates: 'No candidates found. Pair and connect the remote in System Settings ▸ Bluetooth first.',
    unnamedDevice: '(unnamed device)',
    connected: 'Connected',
    connectable: 'Available',
    inUse: 'In use',
    buttons: {
      bluetooth: 'Bluetooth access',
      mock: 'Simulate speech',
      selftest: 'Recognition self-test',
      scan: 'Scan devices',
      switch: 'Switch',
      add: 'Add',
      load: 'Load',
      clear: 'Clear',
      refresh: 'Refresh'
    }
  },
  cards: {
    link: 'Link',
    devices: 'Remotes',
    devicesHint:
      'Supports multiple ATVV voice remotes (Xiaomi BT Remote, Chromecast with Google TV and others). One bridge connects to one remote at a time and reconnects automatically after a switch.',
    voice: 'Voice delivery',
    voiceHint:
      'Speak into the remote → SenseVoice transcribes on this machine → text goes into the composer. Recognition is local; audio never leaves the machine.',
    phrases: 'Canned phrases',
    phrasesHint: 'Pick "Canned phrase" in the key map to insert one with a single press.',
    keys: 'Key mapping',
    audio: 'Audio capture',
    audioHint:
      'Defaults come from the tuned DSH set: 350ms silence gap, 30s cap, 200ms trim, 100Hz high-pass. Adjust only when speech gets cut off.',
    history: 'Transcript history',
    historyHint: 'Stored on this machine only, and only while the toggle is on.',
    logs: 'Daemon log'
  },
  fields: {
    afterRecognition: 'After recognition',
    afterRecognitionAuto: 'Send directly when the draft is empty, otherwise insert',
    afterRecognitionManual: 'Insert into the composer; you still press Enter to send',
    insertMode: 'Insert mode',
    insertInline: 'Same line',
    insertBlock: 'New paragraph',
    notifyAfterInsert: 'Notify after insert',
    autoConnect: 'Auto-connect',
    autoConnectHint: 'Start listening to the remote as soon as the daemon boots',
    autoReconnect: 'Auto-reconnect',
    autoReconnectHint: 'Retry by itself after a Bluetooth drop; no manual click needed',
    precision: 'Precision',
    precisionFp32: 'fp32 weights: more accurate, ~0.3s slower; reloads the model immediately',
    precisionInt8: 'int8 quantised weights: fastest, lowest memory',
    gap: 'Silence gap',
    gapHint: 'How much silence ends an utterance',
    max: 'Max length',
    maxHint: 'Force a cut past this length',
    trim: 'Trim start',
    trimHint: 'Cut the initial key click / breath noise',
    cutoff: 'High-pass',
    cutoffHint: 'Filter out low-frequency rumble',
    language: 'Language',
    languageHint: 'zh / en / ja / ko / yue',
    keyFilter: 'Key ownership',
    keyFilterActive: 'Active device only',
    keyFilterAny: 'Both remotes',
    keyFilterHint:
      'By default only the active remote acts (the other one is ignored and logged), matching the voice key. Volume keys are exempt and always stay with macOS.',
    capture: 'Capture keyboard keys',
    captureHint:
      'Only needed for keys the bridge cannot see: when on, the plugin reads key events from the keyboard, which also captures Enter / Home on a normal keyboard.',
    captureHintHid: 'This remote reports {keys} through the bridge, so mapping those keys needs no capture.',
    captureHintDefault: 'This remote reports Back + volume keys through the bridge, so mapping those needs no capture.'
  },
  toggles: {
    on: 'On',
    off: 'Off',
    directSend: 'Send',
    insertOnly: 'Insert',
    notify: 'Notify',
    silent: 'Silent'
  },
  tiles: {
    linkState: 'Link state',
    live: 'Capturing live',
    standby: 'Bridge standby',
    battery: 'Remote battery',
    batteryUnknown: 'Not reported',
    batteryReplace: 'Replace the battery',
    batteryLow: 'Running low',
    batteryFull: 'Plenty left',
    engine: 'Recognition',
    sessions: 'Utterances',
    frames: '{frames} frames captured',
    calls: 'total · {calls} recognitions',
    daemon: 'Daemon',
    modelLoad: 'Model load {ms}ms',
    notStarted: 'Not running'
  },
  listen: {
    waiting: 'Press the voice key, say one sentence, release to transcribe ({remain}s left)',
    capturing: 'Recording… release to transcribe ({remain}s left)',
    transcribing: 'Transcribing…',
    done: 'Recognised in window: "{text}" ({inference}s inference / {audio}s audio) · not inserted',
    timeout:
      'No key press within 15s: check the remote is connected and not taken over by DSH, then look for [hid] / [atvv] lines in the daemon log below',
    error: 'Recognition failed: {reason}',
    unknownReason: 'unknown reason'
  },
  selftest: {
    result: 'Self-test: "{text}" ({inference}s inference / {audio}s audio)',
    empty: 'Self-test returned no text ({audio}s audio)',
    fellBack: ' (the test clip produced no text, so the built-in sample was used)',
    emptyNote: ' (even the built-in sample produced no text — the model or audio path is broken, check the log)'
  },
  keys: {
    tableKey: 'Key',
    single: 'Single',
    double: 'Double',
    long: 'Long',
    selectPlaceholder: 'Pick a key…',
    addMapping: 'Add mapping',
    timing: 'Double-tap window {double}ms · Long press {long}ms',
    defaultPrefix: 'Default: {label}',
    unknown: 'Unknown',
    notReported: 'not reported by this model',
    unknownTitle: 'This key is not in the current model key table: you added it manually, so it stays visible',
    deleteTitle: 'Delete this mapping',
    emptyProfile: 'No mapping yet for this model (volume keys show only when configured). Pick a key below to add one.',
    emptyAll: 'No mappings yet. Pick a key below to add one.',
    hintProfile: '{label}: the keys of this remote. {hint}',
    hintGeneric:
      'Single / double / long press. Back, ContextMenu and media keys come straight from the Bluetooth bridge; Enter, Home and friends need "Capture keyboard keys" below. This model is not registered yet — add its key table to {dir}/<model>.json and it shows up automatically.'
  },
  actions: {
    submit: 'Submit',
    stop: 'Stop',
    newSession: 'New session',
    swallow: 'Swallow',
    swallowLong: 'Swallow (do nothing)',
    focus: 'Focus composer',
    none: 'Ignore',
    noAction: '(none)',
    stopGenerating: 'Stop generating',
    createSession: 'New session',
    phraseQuoted: 'Phrase "{name}"'
  },
  phrases: {
    deleteTitle: 'Delete this phrase',
    namePlaceholder: 'Name',
    textPlaceholder: 'Text to insert',
    empty: 'No phrases yet. Add one below.'
  },
  history: {
    emptyEnabled: 'Nothing stored yet.',
    emptyDisabled: 'History is off, so transcripts are not stored (turn the toggle on to record them).',
    loadFailed: 'Could not load history: {error}',
    clearFailed: 'Could not clear history: {error}'
  },
  logs: {
    loadFailed: 'Could not load the log: {error}',
    empty: '(click Refresh to read the last 60 lines)'
  },
  notices: {
    backendNotReady: 'plugin backend is not ready',
    recognitionFailed: 'Recognition failed',
    failed: 'Recognition failed: {detail}',
    empty: "Didn't catch that — try again?",
    tooShort: 'Too short ({ms}ms). Hold the voice key and say a few more words.'
  },
  toasts: {
    stopNoSession: 'No focused session — nothing to stop',
    stopFailed: 'Stop failed: {error}',
    sent: '🎙 Sent',
    insertedDraft: 'Voice inserted (draft was not empty, so it was not sent)',
    noComposer: 'Transcription finished but there is no composer to write into: {text}',
    inserted: 'Voice inserted',
    insertedWithSeconds: 'Voice inserted ({secs})',
    submitNoSession: 'No focused session — nothing to submit',
    submitNoAnswer: 'Submit failed: the composer did not respond',
    submitDraftError: 'Submit failed: could not read the draft',
    newChatFailed: 'Could not start a new session',
    phraseMissing: 'Phrase "{name}" does not exist',
    phraseInsertFailed: 'Could not insert the phrase: the composer did not respond',
    saveFailed: 'Save failed: {error}',
    devicesFound: 'Found {count} candidate remote(s)',
    devicesNone: 'No candidates found: pair and connect in System Settings ▸ Bluetooth first',
    devicesCached: 'These {count} device(s) are cached by the daemon (live scanning needs one app restart); you can switch right away.',
    devicesNeedsRestart: 'Device scanning needs one Hermes app restart (gateway routes are not hot-reloaded). You can still switch right now.',
    scanFailed: 'Scan failed: {error}',
    switched: 'Switched to {name}; the bridge is reconnecting',
    settingsOpened: 'Opened System Settings ▸ Privacy & Security ▸ Bluetooth: enable Hermes, then click Reconnect',
    settingsLaunched: 'System Settings opened: go to Privacy & Security ▸ Bluetooth, tick Hermes, then come back and click Reconnect',
    settingsManual: 'Open it manually: System Settings ▸ Privacy & Security ▸ Bluetooth → tick Hermes → come back and click Reconnect'
  },
  pet: {
    sent: '🎙 Sent'
  },
  rows: {
    link: 'Link',
    device: 'Device',
    unnamed: 'unnamed',
    battery: 'Battery',
    recognition: 'Recognition',
    sessions: 'Utterances',
    sessionFrames: '{sessions} sessions / {frames} frames',
    lastTranscript: 'Last transcript',
    lastError: 'Last error',
    daemon: 'Daemon',
    uptime: 'pid {pid} · up {minutes} min'
  }
}
