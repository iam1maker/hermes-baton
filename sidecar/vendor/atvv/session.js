import { FrameAccumulator } from './accumulator.js';
import { ImaAdpcmDecoder, postProcess } from './adpcm.js';
import { buildMicrophoneClose, buildMicrophoneOpen, parseControl } from './protocol.js';
import { TypedEmitter } from '../util/emitter.js';
/**
 * ATVV session state machine: control notifications in, PCM out.
 *
 * The session does not own the BLE transport. The caller feeds it control and
 * audio notifications, and answers `mic-open-request` by writing the command
 * returned from {@link microphoneOpenCommand} to the transmit characteristic.
 */
export class AtvvSession extends TypedEmitter {
    capabilities = null;
    sessionId = 0;
    streaming = false;
    #decoder;
    #postProcessGainDb;
    #accumulator = null;
    #pendingSync = null;
    stats = {
        controlPackets: 0,
        audioNotifications: 0,
        bytes: 0,
        frames: 0,
        samples: 0,
        sessions: 0,
        implicitStarts: 0,
        startedAt: 0,
        lastFrameAt: 0,
        lastStopAt: 0,
    };
    constructor({ decoderOptions = {}, postProcessGainDb = 0 } = {}) {
        super();
        this.#decoder = new ImaAdpcmDecoder(decoderOptions);
        this.#postProcessGainDb = postProcessGainDb;
    }
    get ready() {
        return this.capabilities !== null;
    }
    get pendingBytes() {
        return this.#accumulator?.pendingBytes ?? 0;
    }
    /** Command answering a remote mic-open request, or null while not ready. */
    microphoneOpenCommand() {
        if (!this.capabilities)
            return null;
        return buildMicrophoneOpen(this.capabilities.version, this.capabilities.selectedCodec);
    }
    /** Command closing the microphone for the current session, or null while not ready. */
    microphoneCloseCommand() {
        if (!this.capabilities)
            return null;
        return buildMicrophoneClose(this.capabilities.version, this.sessionId);
    }
    handleControl(data) {
        const event = parseControl(data);
        if (!event)
            return null;
        this.stats.controlPackets++;
        switch (event.op) {
            case 'capabilities': {
                const { op: _op, ...capabilities } = event;
                this.capabilities = capabilities;
                this.#accumulator = new FrameAccumulator(capabilities.frameSize);
                this.emit('capabilities', capabilities);
                break;
            }
            case 'mic-open-request':
                this.emit('mic-open-request');
                break;
            case 'stream-start': {
                // Firmware answers `0c 00` with an echo start (interaction 0, session 0)
                // and sends the real one only when the voice key is pressed. Restarting
                // the stream on the echo would discard the first frames.
                if (event.interaction === 0 && event.sessionId === 0) {
                    this.emit('open-ack');
                    break;
                }
                if (this.capabilities && (event.codec === 0x01 || event.codec === 0x02)) {
                    this.capabilities = {
                        ...this.capabilities,
                        selectedCodec: event.codec,
                        sampleRate: event.codec === 0x02 ? 16_000 : 8_000,
                    };
                }
                this.sessionId = event.sessionId;
                this.#startStreaming(false);
                break;
            }
            case 'stream-stop':
                this.#stopStreaming('remote');
                break;
            case 'sync': {
                this.#pendingSync = { predictor: event.predictor, stepIndex: event.stepIndex };
                this.#accumulator?.reset();
                this.emit('sync', this.#pendingSync);
                break;
            }
            default:
                this.emit('unknown-control', event);
                break;
        }
        return event;
    }
    handleAudio(data) {
        if (!this.capabilities || !this.#accumulator) {
            this.emit('audio-before-ready', data);
            return;
        }
        this.stats.audioNotifications++;
        this.stats.bytes += data.length;
        if (!this.streaming) {
            // Some firmware starts streaming without an observable start packet.
            this.stats.implicitStarts++;
            this.#startStreaming(true);
        }
        for (const frame of this.#accumulator.append(data)) {
            if (this.#pendingSync) {
                this.#decoder.reset(this.#pendingSync);
                this.#pendingSync = null;
            }
            const decoded = this.#decoder.decode(frame);
            const samples = this.#postProcessGainDb === 0 ? decoded : postProcess(decoded, this.#postProcessGainDb);
            this.stats.frames++;
            this.stats.samples += samples.length;
            this.stats.lastFrameAt = Date.now();
            this.emit('pcm', { samples, frameIndex: this.stats.frames - 1 });
        }
    }
    /** Force-close the stream state (disconnect, timeout, abort). */
    abort(reason = 'abort') {
        if (this.streaming)
            this.#stopStreaming(reason);
        this.#accumulator?.reset();
        this.#pendingSync = null;
    }
    #startStreaming(implicit) {
        this.#accumulator?.reset();
        this.#pendingSync = null;
        this.#decoder.reset();
        this.streaming = true;
        this.stats.sessions++;
        this.stats.startedAt = Date.now();
        this.emit('stream-start', { sessionId: this.sessionId, implicit });
    }
    #stopStreaming(reason) {
        if (!this.streaming)
            return;
        this.streaming = false;
        this.stats.lastStopAt = Date.now();
        this.#accumulator?.reset();
        this.#pendingSync = null;
        this.emit('stream-stop', { reason });
    }
}
/**
 * Collect decoded PCM into utterances.
 *
 * The remote firmware only streams while the voice key is held, so the end of
 * an utterance is the silence gap in the frame flow. No HID access, no
 * keyboard focus, and no permission beyond Bluetooth are required.
 */
export class UtteranceBuffer extends TypedEmitter {
    #gapMs;
    #maxMs;
    #chunks = [];
    #sampleCount = 0;
    #startedAt = 0;
    #frames = 0;
    #gapTimer = null;
    #maxTimer = null;
    constructor({ gapMs = 350, maxMs = 30_000 } = {}) {
        super();
        this.#gapMs = gapMs;
        this.#maxMs = maxMs;
    }
    get active() {
        return this.#startedAt !== 0;
    }
    /** Change segmentation while running; the new gap applies to the live utterance. */
    setOptions({ gapMs = this.#gapMs, maxMs = this.#maxMs } = {}) {
        this.#gapMs = gapMs;
        this.#maxMs = maxMs;
        if (this.#gapTimer !== null) {
            clearTimeout(this.#gapTimer);
            this.#gapTimer = setTimeout(() => this.flush('gap'), this.#gapMs);
            this.#gapTimer.unref();
        }
    }
    get sampleCount() {
        return this.#sampleCount;
    }
    push(samples) {
        const now = Date.now();
        if (!this.active) {
            this.#startedAt = now;
            this.#frames = 0;
            this.emit('start', { at: now });
            this.#maxTimer = setTimeout(() => this.flush('max-duration'), this.#maxMs);
            this.#maxTimer.unref();
        }
        this.#chunks.push(samples);
        this.#sampleCount += samples.length;
        this.#frames++;
        if (this.#gapTimer)
            clearTimeout(this.#gapTimer);
        this.#gapTimer = setTimeout(() => this.flush('gap'), this.#gapMs);
        this.#gapTimer.unref();
    }
    /** Finish the current utterance, or return null when nothing is buffered. */
    flush(reason = 'manual') {
        if (!this.active)
            return null;
        if (this.#gapTimer)
            clearTimeout(this.#gapTimer);
        if (this.#maxTimer)
            clearTimeout(this.#maxTimer);
        this.#gapTimer = null;
        this.#maxTimer = null;
        const samples = new Int16Array(this.#sampleCount);
        let offset = 0;
        for (const chunk of this.#chunks) {
            samples.set(chunk, offset);
            offset += chunk.length;
        }
        const utterance = {
            samples,
            startedAt: this.#startedAt,
            endedAt: Date.now(),
            frames: this.#frames,
            reason,
        };
        this.#chunks = [];
        this.#sampleCount = 0;
        this.#startedAt = 0;
        this.#frames = 0;
        this.emit('utterance', utterance);
        return utterance;
    }
    /** Drop buffered audio and pending timers without emitting an utterance. */
    dispose() {
        if (this.#gapTimer)
            clearTimeout(this.#gapTimer);
        if (this.#maxTimer)
            clearTimeout(this.#maxTimer);
        this.#gapTimer = null;
        this.#maxTimer = null;
        this.#chunks = [];
        this.#sampleCount = 0;
        this.#startedAt = 0;
        this.#frames = 0;
    }
}
//# sourceMappingURL=session.js.map