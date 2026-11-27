import { AtvvSession, UtteranceBuffer, type Utterance } from '../atvv/session.js';
import { encodeWav } from '../audio/wav.js';
import { highPass, normalizePeak, trimStart } from '../audio/filter.js';
import type { SidecarTransport } from '../ble/sidecar.js';
import { TypedEmitter } from '../util/emitter.js';

export type RemoteMicState = 'stopped' | 'starting' | 'ready' | 'capturing' | 'transcribing' | 'error';

export interface TranscriptEntry {
  text: string;
  at: number;
  audioSeconds: number;
  inferenceSeconds: number;
  durationMs: number;
}

export type RemoteMicServiceEvents = {
  state: [{ state: RemoteMicState; detail?: string }];
  transcript: [entry: TranscriptEntry];
  error: [{ message: string }];
  device: [{ id: string; name?: string }];
  /** A remote key read straight from HID (the DOM never sees these). */
  key: [{ code: string; down: boolean }];
  /**
   * User-facing hint about an utterance that produced no transcript
   * (too short / not understood). Never carries audio, only the duration.
   */
  notice: [{ kind: 'too-short' | 'empty'; audioMs: number; message: string }];
}

/** Anything that can transcribe a canonical 16 kHz mono WAV. */
export type Transcriber = (audio: Uint8Array, signal: AbortSignal) => Promise<{ text: string; audioSeconds?: number; inferenceSeconds?: number }>;

export interface RemoteMicServiceOptions {
  /** Bridge transport; owned by the caller. */
  transport: SidecarTransport;
  /** Host-side transcription (dsh speechToText, OpenAI-compatible, or a stub). */
  transcribe: Transcriber;
  /** Silence that ends an utterance. */
  gapMs?: number;
  /** Hard cap for one utterance. */
  maxMs?: number;
  /** Leading transient to drop (the voice-key press thump). */
  trimMs?: number;
  /** High-pass cutoff applied before transcription. */
  cutoffHz?: number;
  /** Silence and screenshot-safe logging. */
  log?: (message: string) => void;
  /** Returns an actionable error when the bridge cannot start (bad/missing binary). */
  preflight?: () => string | null;
  /** Restart the bridge when it exits or the link drops. */
  autoRestart?: boolean;
  /** First retry delay, doubled on every consecutive failure. */
  retryBaseMs?: number;
  /** Ceiling for the retry delay. */
  retryMaxMs?: number;
  /** Name of the device the config wants; fallback when the bridge has not reported one. */
  targetDeviceName?: () => string;
  /** 'active' (default): only the currently linked remote's keys count. 'any': both. */
  keyFilter?: () => string;
  /** Key lookup override: the server's device registry wins over the built-in table. */
  resolveCode?: (page: number, usage: number) => string | null;
}

/** Compact link/utterance facts for the status route and bug reports. */
export interface RemoteMicDiagnostics {
  caps: { version: number; codec: number; frameSize: number; sampleRate: number } | null;
  frames: number;
  sessions: number;
  streaming: boolean;
  retries: number;
  lastUtterance: { frames: number; durationMs: number; coverage: number; reason: string } | null;
  /** Last transcription failure; cleared by the next successful transcript. */
  lastError: string | null;
  /** Battery percentage reported by the remote, when it reports one. */
  battery: number | null;
}

/**
 * HID usage → the same `KeyboardEvent.code` the DOM path would use, so one
 * binding serves both paths. Only keys the DOM cannot deliver are listed here;
 * the rest arrive normally when the page has focus.
 */
export function hidUsageToCode(page: number, usage: number): string | null {
  if (page === 0x0c) {
    switch (usage) {
      case 0x224:
        return 'Back';
      case 0xe9:
        return 'AudioVolumeUp';
      case 0xea:
        return 'AudioVolumeDown';
      case 0xe2:
        return 'AudioVolumeMute';
      // Chromecast with Google TV remote (VID 0x18D1 / PID 0x9450): the primary collection is
      // Consumer Control, and the d-pad / OK use the standard Menu usages. Measured: 0x41=OK (centre),
      // 0x42/0x43/0x44/0x45=up/down/left/right, 0x223=Home (AC Home).
      case 0x41:
        return 'Enter';
      case 0x42:
        return 'ArrowUp';
      case 0x43:
        return 'ArrowDown';
      case 0x44:
        return 'ArrowLeft';
      case 0x45:
        return 'ArrowRight';
      case 0x223:
        return 'Home';
      // Dedicated keys: in Google's keylayout (Vendor_18d1_Product_9451.kl)
      // YouTube=0x0C0077, Netflix=0x0C0078; power and input-source were matched by observed
      // timestamps (pressing power locks macOS instantly = the system consumed the HID event).
      case 0x77:
        return 'YouTube';
      case 0x78:
        return 'Netflix';
      case 0x89:
        return 'InputSource';
      case 0x19e:
        return 'Power';
      default:
        return null;
    }
  }
  if (page !== 0x07) return null;
  switch (usage) {
    case 0x28:
      return 'Enter';
    case 0x29:
      return 'Escape';
    case 0x2a:
      return 'Backspace';
    case 0x35:
      return 'Backquote';
    case 0x3e:
      return 'F5';
    case 0x4a:
      return 'Home';
    // Measured on real hardware (firmware 2671): the Back key reports as keyboard usage 0xF1 and
    // volume as 0x80/0x81; the consumer forms 0xE9/0xEA never appear on this remote. Without these
    // three entries the symptom is "press Back, the log only shows [hid] unmapped, the double-tap binding never fires".
    case 0xf1:
      return 'Back';
    case 0x80:
      return 'AudioVolumeUp';
    case 0x81:
      return 'AudioVolumeDown';
    case 0x4f:
      return 'ArrowLeft';
    case 0x50:
      return 'ArrowRight';
    case 0x51:
      return 'ArrowDown';
    case 0x52:
      return 'ArrowUp';
    case 0x65:
      return 'ContextMenu';
    case 0xe9:
      return 'AudioVolumeUp';
    case 0xea:
      return 'AudioVolumeDown';
    case 0xe2:
      return 'AudioVolumeMute';
    default:
      return null;
  }
}

/**
 * Host-side controller: bridge transport in, transcripts out.
 *
 * Keeps the last transcript until the browser half consumes it, so polling can
 * be lossy without losing dictation.
 */
export class RemoteMicService extends TypedEmitter<RemoteMicServiceEvents> {
  readonly #transport: SidecarTransport;
  readonly #log: (message: string) => void;
  readonly #session: AtvvSession;
  readonly #utterances: UtteranceBuffer;
  readonly #preflight: (() => string | null) | undefined;
  #transcribe: Transcriber;
  #trimMs: number;
  #cutoffHz: number;
  #autoRestart: boolean;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;

  #state: RemoteMicState = 'stopped';
  #pending: TranscriptEntry | null = null;
  #busy = false;
  #abort: AbortController | null = null;
  #wantRunning = false;
  #retries = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #microphoneOpen = false;
  #lastUtterance: RemoteMicDiagnostics['lastUtterance'] = null;
  #lastError: string | null = null;
  #battery: number | null = null;
  /** Device the bridge actually linked to; HID watching is machine-wide. */
  #activeDevice: string | null = null;
  readonly #targetDeviceName: (() => string) | null;
  readonly #keyFilter: (() => string) | null;
  readonly #resolveCode: (page: number, usage: number) => string | null;
  readonly #ignoredDevices = new Set<string>();

  constructor({
    transport,
    transcribe,
    gapMs = 350,
    maxMs = 30_000,
    trimMs = 200,
    cutoffHz = 100,
    log = () => {},
    preflight,
    autoRestart = true,
    retryBaseMs = 500,
    retryMaxMs = 15_000,
    targetDeviceName,
    keyFilter,
    resolveCode,
  }: RemoteMicServiceOptions) {
    super();
    this.#transport = transport;
    this.#transcribe = transcribe;
    this.#log = log;
    this.#trimMs = trimMs;
    this.#cutoffHz = cutoffHz;
    this.#preflight = preflight;
    this.#autoRestart = autoRestart;
    this.#retryBaseMs = retryBaseMs;
    this.#retryMaxMs = retryMaxMs;
    this.#targetDeviceName = typeof targetDeviceName === 'function' ? targetDeviceName : null;
    this.#keyFilter = typeof keyFilter === 'function' ? keyFilter : null;
    // Key lookup is injectable (the server's model registry wins); the built-in hidUsageToCode is the default.
    this.#resolveCode = typeof resolveCode === 'function' ? resolveCode : hidUsageToCode;
    this.#session = new AtvvSession();
    this.#utterances = new UtteranceBuffer({ gapMs, maxMs });
    this.wire();
  }

  get state(): RemoteMicState {
    return this.#state;
  }

  get session(): AtvvSession {
    return this.#session;
  }

  get pending(): TranscriptEntry | null {
    return this.#pending;
  }

  async start(): Promise<void> {
    if (this.#wantRunning) return;
    this.#wantRunning = true;
    await this.#attemptStart();
  }

  async stop(): Promise<void> {
    this.#wantRunning = false;
    this.#clearRetry();
    this.#abort?.abort();
    this.#abort = null;
    this.#utterances.dispose();
    await this.#transport.stop().catch(() => undefined);
    this.setState('stopped');
  }

  /** Swap the recogniser without restarting the link (settings page). */
  setTranscriber(transcribe: Transcriber): void {
    this.#transcribe = transcribe;
  }

  /** Apply segmentation/front-end changes; the live utterance uses the new gap. */
  setAudioOptions(options: { gapMs?: number; maxMs?: number; trimMs?: number; cutoffHz?: number }): void {
    if (options.gapMs !== undefined || options.maxMs !== undefined) {
      this.#utterances.setOptions({ gapMs: options.gapMs, maxMs: options.maxMs });
    }
    if (options.trimMs !== undefined) this.#trimMs = options.trimMs;
    if (options.cutoffHz !== undefined) this.#cutoffHz = options.cutoffHz;
  }

  /** Toggle reconnect-on-drop without touching the running link. */
  setAutoRestart(enabled: boolean): void {
    this.#autoRestart = enabled;
    if (!enabled) this.#clearRetry();
  }

  async restart(): Promise<void> {
    await this.stop();
    this.#utterances.dispose();
    this.setState('stopped');
    await this.start();
  }

  /** Link and utterance facts; cheap enough to serve on every poll. */
  get diagnostics(): RemoteMicDiagnostics {
    const caps = this.#session.capabilities;
    return {
      caps: caps === null
        ? null
        : { version: caps.version, codec: caps.selectedCodec, frameSize: caps.frameSize, sampleRate: caps.sampleRate },
      frames: this.#session.stats.frames,
      sessions: this.#session.stats.sessions,
      streaming: this.#session.streaming,
      retries: this.#retries,
      lastUtterance: this.#lastUtterance,
      lastError: this.#lastError,
      battery: this.#battery,
    };
  }

  async #attemptStart(): Promise<void> {
    if (!this.#wantRunning) return;
    const blocked = this.#preflight?.() ?? null;
    if (blocked !== null) {
      this.#log(blocked);
      this.#wantRunning = false;
      this.setState('error', blocked);
      return;
    }
    this.setState('starting', this.#retries > 0 ? `reconnecting (attempt ${this.#retries})` : undefined);
    try {
      await this.#transport.start();
      // stop()/restart() may have landed while the spawn was in flight.
      if (!this.#wantRunning) await this.#transport.stop().catch(() => undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#log(`[ble] start failed: ${message}`);
      this.setState('error', message);
      this.#scheduleRetry();
    }
  }

  #scheduleRetry(): void {
    if (!this.#autoRestart || !this.#wantRunning || this.#retryTimer !== null) return;
    this.#retries++;
    const delay = Math.min(this.#retryBaseMs * 2 ** (this.#retries - 1), this.#retryMaxMs);
    this.#log(`[ble] retrying in ${delay}ms (attempt ${this.#retries})`);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (!this.#wantRunning) return;
      void this.#attemptStart();
    }, delay);
  }

  #clearRetry(): void {
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  /** Return the pending transcript exactly once. */
  consume(): TranscriptEntry | null {
    const entry = this.#pending;
    this.#pending = null;
    return entry;
  }

  /** Answer a remote mic-open request (also used by tests). */
  openMicrophone(): void {
    const command = this.#session.microphoneOpenCommand();
    if (!command) return;
    this.#microphoneOpen = true;
    this.#transport.write(command.toString('hex'));
  }

  private setState(state: RemoteMicState, detail?: string): void {
    this.#state = state;
    this.emit('state', { state, detail });
  }

  private wire(): void {
    const transport = this.#transport;
    const session = this.#session;

    transport.on('state', ({ state }) => this.#log(`[ble] state=${state}`));
    transport.on('ready', () => {
      this.#log('[ble] ready');
      this.#retries = 0;
      this.#microphoneOpen = false;
      this.setState('ready');
    });
    transport.on('device', (device) => {
      // Remember which one the bridge really connected to: HID listening is machine-wide and both
      // remotes are normally connected to the system, so without this a key cannot be attributed.
      this.#activeDevice = device && device.name ? String(device.name) : null;
      this.#ignoredDevices.clear();
      this.emit('device', device);
    });
    transport.on('control', ({ data }) => {
      const event = session.handleControl(data);
      if (event?.op === 'mic-open-request') {
        this.openMicrophone();
      } else if (event?.op === 'stream-start' && !this.#microphoneOpen) {
        // Firmware 2671 can skip mic-open-request: pressing the voice key may
        // produce a bare stream-start, and audio only flows after `0c 00`.
        this.openMicrophone();
      }
    });
    transport.on('audio', ({ data }) => session.handleAudio(data));
    const seenUsages = new Set<string>();
    transport.on('hidkey', ({ page, usage, value, device }) => {
      // Key ownership is decided by config (keyFilter):
      //   'active' —— only "the remote currently in effect" counts (default). The voice key already
      //               follows only the linked remote, and keys should follow it too, otherwise the
      //               other remote getting knocked about in a bag fires them. expected prefers the
      //               device the bridge really linked to, falls back to the configured target device
      //               before the bridge reports, and filters nothing when neither is known (the name may be nil).
      //   'any'    —— both count. For people who want either remote to work.
      const mode = this.#keyFilter ? String(this.#keyFilter() || 'active') : 'active';
      if (mode === 'active') {
        const expected = this.#activeDevice
          || (this.#targetDeviceName ? String(this.#targetDeviceName() || '') : '');
        if (expected && device && String(device) !== expected) {
          if (!this.#ignoredDevices.has(String(device))) {
            this.#ignoredDevices.add(String(device));
            this.#log(`[hid] ignoring key from a non-current device device=${device} (current=${expected})`);
          }
          return;
        }
      }
      const code = this.#resolveCode(page, usage);
      if (code) {
        this.emit('key', { code, down: value !== 0 });
        return;
      }
      // One line per unknown usage so a physical press during acceptance tells
      // us exactly which bit the firmware uses (Back lives on 0xFF00).
      const key = `${page}/${usage}`;
      if (!seenUsages.has(key)) {
        seenUsages.add(key);
        const who = device ? ` device=${device}` : '';
        this.#log(`[hid] unmapped page=0x${page.toString(16)} usage=0x${usage.toString(16)} value=${value}${who}`);
      }
    });
    transport.on('battery', ({ percent }) => {
      this.#battery = percent;
      this.#log(`[ble] battery=${percent}%`);
    });
    transport.on('disconnect', ({ reason }) => {
      this.#microphoneOpen = false;
      session.abort('disconnect');
      this.#utterances.flush('disconnect');
      this.setState('error', reason);
      this.#scheduleRetry();
    });
    transport.on('error', ({ message }) => {
      this.#microphoneOpen = false;
      this.#log(`[ble] error: ${message}`);
      this.setState('error', message);
      this.#scheduleRetry();
    });
    transport.on('exit', ({ code }) => {
      this.#microphoneOpen = false;
      if (!this.#wantRunning) return;
      this.setState('error', `bridge exited with code ${code ?? 'null'}`);
      this.#scheduleRetry();
    });

    session.on('pcm', ({ samples }) => this.#utterances.push(samples));

    session.on('stream-start', () => this.setState('capturing'));
    session.on('stream-stop', ({ reason }) => {
      this.#microphoneOpen = false;
      const command = session.microphoneCloseCommand();
      if (command) transport.write(command.toString('hex'));
      if (this.#state === 'capturing') this.setState('ready', reason);
    });

    this.#utterances.on('utterance', (utterance) => {
      void this.handleUtterance(utterance).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.#log(`[stt] handler failed: ${message}`);
      });
    });
  }

  private async handleUtterance(utterance: Utterance): Promise<void> {
    if (this.#busy) {
      this.#log('[stt] dropping overlapping utterance');
      return;
    }
    this.#busy = true;
    this.#abort = new AbortController();
    const signal = this.#abort.signal;

    const startedAt = Date.now();
    const durationMs = Math.round((utterance.endedAt - utterance.startedAt) * 1000) / 1000;
    this.#lastUtterance = {
      frames: utterance.frames,
      durationMs,
      coverage: durationMs > 0 ? Math.min(1, (utterance.frames * 15) / durationMs) : 0,
      reason: utterance.reason,
    };
    try {
      // Codec 0x02 means 16 kHz; older codecs report 8 kHz, which every filter
      // and the WAV header must follow instead of assuming 16 kHz.
      const sampleRate = this.#session.capabilities?.sampleRate ?? 16_000;
      // Hermes-side change: a fixed 200ms trim eats short utterances (a 1s "hey" has only 350ms left
      // after trimming, so recognition always comes back empty), so the trim shrinks with the utterance; the cap is still the configured trimMs.
      const effectiveTrim = Math.min(this.#trimMs, Math.max(40, durationMs * 0.12));
      const prepared = prepareForTranscription(utterance.samples, {
        trimMs: effectiveTrim,
        cutoffHz: this.#cutoffHz,
        sampleRate,
      });
      const preparedMs = Math.round((prepared.length / sampleRate) * 1000);
      if (preparedMs < 120) {
        this.#log(`[stt] audio too short (${preparedMs}ms), skipping recognition`);
        this.emit('notice', {
          kind: 'too-short',
          audioMs: preparedMs,
          message: `utterance too short (${preparedMs}ms)`,
        });
        this.setState('ready');
        return;
      }
      const wav = encodeWav(prepared, sampleRate);
      this.setState('transcribing');

      const result = await this.#transcribe(new Uint8Array(wav), signal);
      const text = result.text.trim();
      if (text.length === 0) {
        this.#log('[stt] empty transcript');
        this.emit('notice', {
          kind: 'empty',
          audioMs: preparedMs,
          message: `no speech recognised (${preparedMs}ms of audio)`,
        });
        this.setState('ready');
        return;
      }

      const entry: TranscriptEntry = {
        text,
        at: Date.now(),
        audioSeconds: result.audioSeconds ?? prepared.length / sampleRate,
        inferenceSeconds: result.inferenceSeconds ?? (Date.now() - startedAt) / 1000,
        durationMs,
      };
      this.#pending = entry;
      this.#lastError = null;
      this.emit('transcript', entry);
      this.setState('ready');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#log(`[stt] failed: ${message}`);
      // A bare 'error' event with no listener throws ERR_UNHANDLED_ERROR, which
      // reaches the Host as a fatal error (it crashed a desktop app once).
      if (this.listenerCount('error') > 0) this.emit('error', { message });
      // The bridge is still healthy when only transcription failed; park the
      // message in diagnostics instead of pinning the badge to "error".
      this.#lastError = message;
      if (this.#state === 'transcribing') this.setState('ready');
    } finally {
      this.#busy = false;
      this.#abort = null;
    }
  }
}

export interface PrepareOptions {
  trimMs: number;
  cutoffHz: number;
  /** Device sample rate; the ATVV caps decide it (16 kHz codec 0x02, else 8 kHz). */
  sampleRate?: number;
}

/** Drop the key-press thump, remove DC, and normalise the peak for the recogniser. */
export function prepareForTranscription(samples: Int16Array, { trimMs, cutoffHz, sampleRate = 16_000 }: PrepareOptions): Int16Array {
  const trimmed = trimStart(samples, sampleRate, trimMs);
  const filtered = highPass(trimmed, sampleRate, { cutoffHz });
  return normalizePeak(filtered);
}
