/**
 * Reassemble raw ADPCM notifications into fixed-size ATVV frames.
 *
 * The audio characteristic delivers a byte stream, not one notification per
 * frame: a notification may carry half a frame or several frames.
 */
export class FrameAccumulator {
    frameSize;
    #pending = new Uint8Array(0);
    constructor(frameSize) {
        this.frameSize = frameSize;
        if (!Number.isInteger(frameSize) || frameSize <= 0) {
            throw new Error(`invalid ATVV frame size: ${frameSize}`);
        }
    }
    get pendingBytes() {
        return this.#pending.length;
    }
    /** Append one notification and return every complete frame it produced. */
    append(chunk) {
        if (chunk.length === 0)
            return [];
        const merged = new Uint8Array(this.#pending.length + chunk.length);
        merged.set(this.#pending, 0);
        merged.set(chunk, this.#pending.length);
        const frames = [];
        let offset = 0;
        while (merged.length - offset >= this.frameSize) {
            frames.push(merged.subarray(offset, offset + this.frameSize));
            offset += this.frameSize;
        }
        this.#pending = merged.subarray(offset);
        return frames;
    }
    /** Drop any partial frame (stream start/stop or sync). */
    reset() {
        this.#pending = new Uint8Array(0);
    }
}
//# sourceMappingURL=accumulator.js.map