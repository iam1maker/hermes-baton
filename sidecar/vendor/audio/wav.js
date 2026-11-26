/** 16-bit little-endian mono PCM -> canonical WAV container. */
export const DEFAULT_SAMPLE_RATE = 16_000;
/** Encode mono PCM samples as a complete RIFF/WAVE file. */
export function encodeWav(samples, sampleRate = DEFAULT_SAMPLE_RATE) {
    const dataBytes = samples.length * 2;
    const buffer = Buffer.alloc(44 + dataBytes);
    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(36 + dataBytes, 4);
    buffer.write('WAVE', 8, 'ascii');
    buffer.write('fmt ', 12, 'ascii');
    buffer.writeUInt32LE(16, 16); // fmt chunk size
    buffer.writeUInt16LE(1, 20); // PCM
    buffer.writeUInt16LE(1, 22); // mono
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
    buffer.writeUInt16LE(2, 32); // block align
    buffer.writeUInt16LE(16, 34); // bits per sample
    buffer.write('data', 36, 'ascii');
    buffer.writeUInt32LE(dataBytes, 40);
    for (let index = 0; index < samples.length; index++) {
        buffer.writeInt16LE(samples[index], 44 + index * 2);
    }
    return buffer;
}
/** Peak absolute amplitude, 0..32767. */
export function peakOf(samples) {
    let peak = 0;
    for (const sample of samples) {
        const magnitude = sample < 0 ? -sample : sample;
        if (magnitude > peak)
            peak = magnitude;
    }
    return peak;
}
/** Root-mean-square amplitude, 0..32767. */
export function rmsOf(samples) {
    if (samples.length === 0)
        return 0;
    let sum = 0;
    for (const sample of samples)
        sum += sample * sample;
    return Math.sqrt(sum / samples.length);
}
//# sourceMappingURL=wav.js.map