/**
 * Small PCM helpers used before transcription.
 *
 * ATVV captures start with a short mechanical/decoder thump when the voice key
 * is pressed (a decaying DC-like transient). A one-pole high-pass removes it
 * without touching speech intelligibility.
 */
/** One-pole high-pass filter. Returns a new array. */
export function highPass(input, sampleRate, { cutoffHz = 100 } = {}) {
    if (input.length === 0)
        return input;
    const dt = 1 / sampleRate;
    const rc = 1 / (2 * Math.PI * cutoffHz);
    const alpha = rc / (rc + dt);
    const out = new Int16Array(input.length);
    let previousInput = input[0];
    let previousOutput = 0;
    for (let index = 0; index < input.length; index++) {
        const current = input[index];
        const filtered = alpha * (previousOutput + current - previousInput);
        previousInput = current;
        previousOutput = filtered;
        out[index] = clamp(Math.round(filtered));
    }
    return out;
}
/** Scale samples so the loudest peak reaches `target` (default 80% full scale). */
export function normalizePeak(input, target = 0.8 * 32_767) {
    let peak = 0;
    for (const sample of input) {
        const magnitude = sample < 0 ? -sample : sample;
        if (magnitude > peak)
            peak = magnitude;
    }
    if (peak === 0 || peak >= target)
        return input;
    const gain = target / peak;
    const out = new Int16Array(input.length);
    for (let index = 0; index < input.length; index++) {
        out[index] = clamp(Math.round(input[index] * gain));
    }
    return out;
}
/** Drop the first `milliseconds` of audio (startup transient guard). */
export function trimStart(input, sampleRate, milliseconds) {
    const samples = Math.min(input.length, Math.round((milliseconds / 1000) * sampleRate));
    return samples <= 0 ? input : input.subarray(samples);
}
function clamp(value) {
    return value < -32_768 ? -32_768 : value > 32_767 ? 32_767 : value;
}
//# sourceMappingURL=filter.js.map