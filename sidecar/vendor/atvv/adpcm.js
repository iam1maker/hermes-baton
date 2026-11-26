/**
 * IMA / DVI ADPCM decoder for ATVV voice frames.
 *
 * Standard IMA ADPCM (4-bit nibbles, 2 samples per byte) as described in the
 * public IMA ADPCM specification. RC003 firmware sends the high nibble first;
 * some other remotes (ARN9 family) send the low nibble first.
 *
 * Frame geometry observed on RC003: 120 bytes = 240 samples = 15 ms @ 16 kHz.
 */
const STEP_TABLE = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31,
    34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130,
    143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449,
    494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411,
    1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026,
    4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
    11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623,
    27086, 29794, 32767,
];
const INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8];
const MAX_PREDICTOR = 32_767;
const MIN_PREDICTOR = -32_768;
const MAX_STEP_INDEX = STEP_TABLE.length - 1;
function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
}
export class ImaAdpcmDecoder {
    predictor = 0;
    stepIndex = 0;
    lowNibbleFirst;
    constructor({ lowNibbleFirst = false } = {}) {
        this.lowNibbleFirst = lowNibbleFirst;
    }
    /**
     * Reset decoder state. ATVV sync packets carry the predictor and step index
     * that both sides must resume from.
     */
    reset({ predictor = 0, stepIndex = 0 } = {}) {
        this.predictor = clamp(predictor | 0, MIN_PREDICTOR, MAX_PREDICTOR);
        this.stepIndex = clamp(stepIndex | 0, 0, MAX_STEP_INDEX);
    }
    /** Decode a chunk of packed nibbles into PCM samples. */
    decode(bytes) {
        const out = new Int16Array(bytes.length * 2);
        let offset = 0;
        for (const byte of bytes) {
            if (this.lowNibbleFirst) {
                out[offset++] = this.#nibble(byte & 0x0f);
                out[offset++] = this.#nibble((byte >> 4) & 0x0f);
            }
            else {
                out[offset++] = this.#nibble((byte >> 4) & 0x0f);
                out[offset++] = this.#nibble(byte & 0x0f);
            }
        }
        return out;
    }
    #nibble(nibble) {
        const step = STEP_TABLE[this.stepIndex];
        let difference = step >> 3;
        if (nibble & 1)
            difference += step >> 2;
        if (nibble & 2)
            difference += step >> 1;
        if (nibble & 4)
            difference += step;
        this.predictor += nibble & 8 ? -difference : difference;
        this.predictor = clamp(this.predictor, MIN_PREDICTOR, MAX_PREDICTOR);
        this.stepIndex = clamp(this.stepIndex + INDEX_TABLE[nibble & 7], 0, MAX_STEP_INDEX);
        return this.predictor;
    }
}
/**
 * Optional 3-point smoothing + bounded gain, mirroring a comfortable voice
 * chain. Speech recognition does not need it; keep it opt-in.
 */
export function postProcess(input, gainDb = 0) {
    if (input.length === 0)
        return input;
    const filtered = new Int32Array(input.length);
    filtered[0] = input[0];
    filtered[input.length - 1] = input[input.length - 1];
    for (let index = 1; index < input.length - 1; index++) {
        filtered[index] =
            (input[index - 1] + 2 * input[index] + input[index + 1]) >> 2;
    }
    const safeGainDb = Number.isFinite(gainDb) ? clamp(gainDb, -24, 24) : 0;
    const gain = safeGainDb === 0 ? 1 : 10 ** (safeGainDb / 20);
    const out = new Int16Array(input.length);
    for (let index = 0; index < filtered.length; index++) {
        out[index] = clamp(Math.round(filtered[index] * gain), MIN_PREDICTOR, MAX_PREDICTOR);
    }
    return out;
}
export const ADPCM_STEP_TABLE = STEP_TABLE;
//# sourceMappingURL=adpcm.js.map