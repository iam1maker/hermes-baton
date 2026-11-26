import { AtvvSession, UtteranceBuffer } from '../atvv/session.js';
import { encodeWav } from '../audio/wav.js';
import { highPass, normalizePeak, trimStart } from '../audio/filter.js';
import { TypedEmitter } from '../util/emitter.js';
/**
 * HID usage → the same `KeyboardEvent.code` the DOM path would use, so one
 * binding serves both paths. Only keys the DOM cannot deliver are listed here;
 * the rest arrive normally when the page has focus.
 */
export function hidUsageToCode(page, usage) {
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
            // Chromecast with Google TV 遥控器（VID 0x18D1 / PID 0x9450）的主集合是
            // Consumer Control，方向与确认走标准 Menu 用法。实测：0x41=中键确认、
            // 0x42/0x43/0x44/0x45=上/下/左/右、0x223=Home（AC Home）。
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
            // 专用键：Google keylayout（Vendor_18d1_Product_9451.kl）里
            // YouTube=0x0C0077、Netflix=0x0C0078；电源与输入源由实测时间戳对上
            // （按电源键 macOS 立即锁屏 = 系统层级消费了这次 HID 事件）。
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
    if (page !== 0x07)
        return null;
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
        // 真机实测（固件 2671）：Back 键以键盘 usage 0xF1 上报、音量以 0x80/0x81 上报，
        // 0xE9/0xEA 那种 consumer 形式在这台遥控器上从不出现。少了这三条就表现为
        // 「按 Back 日志只有 [hid] unmapped，双击映射完全不触发」。
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
export class RemoteMicService extends TypedEmitter {
    #transport;
    #log;
    #session;
    #utterances;
    #preflight;
    #transcribe;
    #trimMs;
    #cutoffHz;
    #autoRestart;
    #retryBaseMs;
    #retryMaxMs;
    #state = 'stopped';
    #pending = null;
    #busy = false;
    #abort = null;
    #wantRunning = false;
    #retries = 0;
    #retryTimer = null;
    #microphoneOpen = false;
    #lastUtterance = null;
    #lastError = null;
    #battery = null;
    #activeDevice = null;
    #targetDeviceName;
    #keyFilter;
    #resolveCode;
    #ignoredDevices = new Set();
    constructor({ transport, transcribe, gapMs = 350, maxMs = 30_000, trimMs = 200, cutoffHz = 100, log = () => { }, preflight, autoRestart = true, retryBaseMs = 500, retryMaxMs = 15_000, targetDeviceName, keyFilter, resolveCode, }) {
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
        // 按键查表可注入（服务端的型号注册表优先），不传就用内置 hidUsageToCode。
        this.#resolveCode = typeof resolveCode === 'function' ? resolveCode : hidUsageToCode;
        this.#session = new AtvvSession();
        this.#utterances = new UtteranceBuffer({ gapMs, maxMs });
        this.wire();
    }
    get state() {
        return this.#state;
    }
    get session() {
        return this.#session;
    }
    get pending() {
        return this.#pending;
    }
    async start() {
        if (this.#wantRunning)
            return;
        this.#wantRunning = true;
        await this.#attemptStart();
    }
    async stop() {
        this.#wantRunning = false;
        this.#clearRetry();
        this.#abort?.abort();
        this.#abort = null;
        this.#utterances.dispose();
        await this.#transport.stop().catch(() => undefined);
        this.setState('stopped');
    }
    /** Swap the recogniser without restarting the link (settings page). */
    setTranscriber(transcribe) {
        this.#transcribe = transcribe;
    }
    /** Apply segmentation/front-end changes; the live utterance uses the new gap. */
    setAudioOptions(options) {
        if (options.gapMs !== undefined || options.maxMs !== undefined) {
            this.#utterances.setOptions({ gapMs: options.gapMs, maxMs: options.maxMs });
        }
        if (options.trimMs !== undefined)
            this.#trimMs = options.trimMs;
        if (options.cutoffHz !== undefined)
            this.#cutoffHz = options.cutoffHz;
    }
    /** Toggle reconnect-on-drop without touching the running link. */
    setAutoRestart(enabled) {
        this.#autoRestart = enabled;
        if (!enabled)
            this.#clearRetry();
    }
    async restart() {
        await this.stop();
        this.#utterances.dispose();
        this.setState('stopped');
        await this.start();
    }
    /** Link and utterance facts; cheap enough to serve on every poll. */
    get diagnostics() {
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
    async #attemptStart() {
        if (!this.#wantRunning)
            return;
        const blocked = this.#preflight?.() ?? null;
        if (blocked !== null) {
            this.#log(blocked);
            this.#wantRunning = false;
            this.setState('error', blocked);
            return;
        }
        this.setState('starting', this.#retries > 0 ? `重连中（第 ${this.#retries} 次）` : undefined);
        try {
            await this.#transport.start();
            // stop()/restart() may have landed while the spawn was in flight.
            if (!this.#wantRunning)
                await this.#transport.stop().catch(() => undefined);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.#log(`[ble] start failed: ${message}`);
            this.setState('error', message);
            this.#scheduleRetry();
        }
    }
    #scheduleRetry() {
        if (!this.#autoRestart || !this.#wantRunning || this.#retryTimer !== null)
            return;
        this.#retries++;
        const delay = Math.min(this.#retryBaseMs * 2 ** (this.#retries - 1), this.#retryMaxMs);
        this.#log(`[ble] retrying in ${delay}ms (attempt ${this.#retries})`);
        this.#retryTimer = setTimeout(() => {
            this.#retryTimer = null;
            if (!this.#wantRunning)
                return;
            void this.#attemptStart();
        }, delay);
    }
    #clearRetry() {
        if (this.#retryTimer !== null)
            clearTimeout(this.#retryTimer);
        this.#retryTimer = null;
    }
    /** Return the pending transcript exactly once. */
    consume() {
        const entry = this.#pending;
        this.#pending = null;
        return entry;
    }
    /** Answer a remote mic-open request (also used by tests). */
    openMicrophone() {
        const command = this.#session.microphoneOpenCommand();
        if (!command)
            return;
        this.#microphoneOpen = true;
        this.#transport.write(command.toString('hex'));
    }
    setState(state, detail) {
        this.#state = state;
        this.emit('state', { state, detail });
    }
    wire() {
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
            // 记住桥真正连上的那台：HID 旁听是全机的，两台遥控器平时都连着系统，
            // 不记下来就没法判断这个按键该不该管。
            this.#activeDevice = device && device.name ? String(device.name) : null;
            this.#ignoredDevices.clear();
            this.emit('device', device);
        });
        transport.on('control', ({ data }) => {
            const event = session.handleControl(data);
            if (event?.op === 'mic-open-request') {
                this.openMicrophone();
            }
            else if (event?.op === 'stream-start' && !this.#microphoneOpen) {
                // Firmware 2671 can skip mic-open-request: pressing the voice key may
                // produce a bare stream-start, and audio only flows after `0c 00`.
                this.openMicrophone();
            }
        });
        transport.on('audio', ({ data }) => session.handleAudio(data));
        const seenUsages = new Set();
        transport.on('hidkey', ({ page, usage, value, device }) => {
            // 按键归属由配置决定（keyFilter）：
            //   'active' —— 只有「当前生效的那台遥控器」管事（默认）。语音键本来就只走
            //               连上的那台，按键也应跟着它，否则另一台在包里被压到就会误触。
            //               expected 优先用桥真实连上的那台，桥还没上报时退回配置里的
            //               目标设备；两者都拿不到就不过滤（设备名可能为 nil）。
            //   'any'    —— 两台都认。留给「想拿哪台都能用」的人。
            const mode = this.#keyFilter ? String(this.#keyFilter() || 'active') : 'active';
            if (mode === 'active') {
                const expected = this.#activeDevice
                    || (this.#targetDeviceName ? String(this.#targetDeviceName() || '') : '');
                if (expected && device && String(device) !== expected) {
                    if (!this.#ignoredDevices.has(String(device))) {
                        this.#ignoredDevices.add(String(device));
                        this.#log(`[hid] 忽略非当前设备的按键 device=${device}（当前=${expected}）`);
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
            if (!this.#wantRunning)
                return;
            this.setState('error', `bridge exited with code ${code ?? 'null'}`);
            this.#scheduleRetry();
        });
        session.on('pcm', ({ samples }) => this.#utterances.push(samples));
        session.on('stream-start', () => this.setState('capturing'));
        session.on('stream-stop', ({ reason }) => {
            this.#microphoneOpen = false;
            const command = session.microphoneCloseCommand();
            if (command)
                transport.write(command.toString('hex'));
            if (this.#state === 'capturing')
                this.setState('ready', reason);
        });
        this.#utterances.on('utterance', (utterance) => {
            void this.handleUtterance(utterance).catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                this.#log(`[stt] handler failed: ${message}`);
            });
        });
    }
    async handleUtterance(utterance) {
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
            // Hermes 侧改动：固定的 200ms 切头会把短句吃光（1 秒的"喂"切完只剩 350ms，
            // 识别必空），所以切头量随语句长度收缩，上限仍是用户配置的 trimMs。
            const effectiveTrim = Math.min(this.#trimMs, Math.max(40, durationMs * 0.12));
            const prepared = prepareForTranscription(utterance.samples, {
                trimMs: effectiveTrim,
                cutoffHz: this.#cutoffHz,
                sampleRate,
            });
            const preparedMs = Math.round((prepared.length / sampleRate) * 1000);
            if (preparedMs < 120) {
                this.#log(`[stt] 音频过短（${preparedMs}ms），跳过识别`);
                this.emit('notice', { kind: 'too-short', audioMs: preparedMs, message: `这条太短了（${preparedMs}ms），按住语音键多说两个字` });
                this.setState('ready');
                return;
            }
            const wav = encodeWav(prepared, sampleRate);
            this.setState('transcribing');
            const result = await this.#transcribe(new Uint8Array(wav), signal);
            const text = result.text.trim();
            if (text.length === 0) {
                this.#log('[stt] empty transcript');
                this.emit('notice', { kind: 'empty', audioMs: preparedMs, message: `没听清（${preparedMs}ms 音频），再说一次？` });
                this.setState('ready');
                return;
            }
            const entry = {
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
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.#log(`[stt] failed: ${message}`);
            // A bare 'error' event with no listener throws ERR_UNHANDLED_ERROR, which
            // reaches the Host as a fatal error (it crashed a desktop app once).
            if (this.listenerCount('error') > 0)
                this.emit('error', { message });
            // The bridge is still healthy when only transcription failed; park the
            // message in diagnostics instead of pinning the badge to "error".
            this.#lastError = message;
            if (this.#state === 'transcribing')
                this.setState('ready');
        }
        finally {
            this.#busy = false;
            this.#abort = null;
        }
    }
}
/** Drop the key-press thump, remove DC, and normalise the peak for the recogniser. */
export function prepareForTranscription(samples, { trimMs, cutoffHz, sampleRate = 16_000 }) {
    const trimmed = trimStart(samples, sampleRate, trimMs);
    const filtered = highPass(trimmed, sampleRate, { cutoffHz });
    return normalizePeak(filtered);
}
//# sourceMappingURL=service.js.map