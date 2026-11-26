/**
 * ATVV (Audio Transfer over Bluetooth Low Energy) protocol facts for the
 * Xiaomi Bluetooth Remote 2 / 2 Pro (RC003, VID 0x2717 / PID 0x32B8).
 *
 * This is a clean reimplementation from the publicly observable protocol
 * behaviour (GATT layout, control opcodes, frame geometry). No source code is
 * copied from the GPL reference application; see docs/protocol.md for the
 * provenance notes and docs/licensing.md for the interoperability boundary.
 */

export const UUID = {
  service: 'ab5e00015a214f05bc7daf01f617b664',
  transmit: 'ab5e00025a214f05bc7daf01f617b664',
  audio: 'ab5e00035a214f05bc7daf01f617b664',
  control: 'ab5e00045a214f05bc7daf01f617b664',
} as const;

/** Standard Bluetooth SIG HID-over-GATT service and input report characteristic. */
export const HID = {
  service: '0000181200001000800000805f9b34fb',
  report: '00002a4d00001000800000805f9b34fb',
} as const;

export type CharacteristicRole = keyof typeof UUID;

/** Control-characteristic opcodes (first byte of every notification). */
export const CONTROL = {
  STREAM_STOP: 0x00,
  STREAM_START: 0x04,
  MIC_OPEN_REQUEST: 0x08,
  SYNC: 0x0a,
  CAPABILITIES: 0x0b,
} as const;

/** Query capabilities, protocol v1.0 (accepted by RC001/RC003 firmware). */
export const CAPABILITIES_REQUEST = Buffer.from([0x0a, 0x01, 0x00, 0x00, 0x03, 0x03]);

export const SAMPLE_RATE_16K = 16_000;
export const SAMPLE_RATE_8K = 8_000;

/** Fallback when the remote reports frameSize = 0. */
export const DEFAULT_FRAME_SIZE = 120;

/** Native stream geometry once codec 0x02 is selected. */
export interface StreamGeometry {
  sampleRate: number;
  /** Bytes per ATVV audio frame. */
  frameSize: number;
  /** Samples per frame (two per byte). */
  frameSamples: number;
  /** Milliseconds of audio per frame. */
  frameMilliseconds: number;
}

export interface Capabilities {
  version: number;
  codecs: number;
  interaction: number;
  frameSize: number;
  selectedCodec: number;
  sampleRate: number;
}

export type ControlEvent =
  | ({ op: 'capabilities' } & Capabilities)
  | { op: 'mic-open-request' }
  | { op: 'stream-start'; interaction: number; codec: number; sessionId: number }
  | { op: 'stream-stop' }
  | { op: 'sync'; predictor: number; stepIndex: number }
  | { op: 'unknown'; opcode: number; data: Buffer };

/** Normalize a noble UUID (no dashes, lower case) for comparisons. */
export function normalizeUuid(uuid: string): string {
  return uuid.replace(/-/g, '').toLowerCase();
}

/** Short human-readable form of a 128-bit UUID. */
export function shortUuid(uuid: string): string {
  const value = normalizeUuid(uuid);
  return value.length === 32 ? `${value.slice(0, 8)}-${value.slice(8)}` : value;
}

/** Derive stream geometry from parsed capabilities. */
export function geometryOf(capabilities: Capabilities): StreamGeometry {
  const frameSamples = capabilities.frameSize * 2;
  return {
    sampleRate: capabilities.sampleRate,
    frameSize: capabilities.frameSize,
    frameSamples,
    frameMilliseconds: (frameSamples / capabilities.sampleRate) * 1000,
  };
}

/**
 * Parse an ATVV capabilities notification (control opcode 0x0B).
 */
export function parseCapabilities(data: Uint8Array): Capabilities | null {
  if (data.length < 7) return null;
  const bytes = Array.from(data);
  if (bytes[0] !== CONTROL.CAPABILITIES) return null;

  const version = ((bytes[1] ?? 0) << 8) | (bytes[2] ?? 0);
  let codecs: number;
  let interaction: number;

  if (version >= 0x0100) {
    codecs = bytes[3] ?? 0;
    interaction = bytes[4] ?? 0;
    // Some firmware leaves the codec bitmap in byte 4 and signals it through
    // the low interaction bits; the reference behaviour carries the same
    // recovery path for those units.
    if (codecs === 0 && bytes.length >= 9 && ((bytes[4] ?? 0) & 0x03) !== 0) {
      codecs = bytes[4] ?? 0;
      interaction = 0x03;
    }
  } else {
    if (bytes.length < 9) return null;
    codecs = bytes[4] ?? 0;
    interaction = 0;
  }

  const declaredFrameSize = ((bytes[5] ?? 0) << 8) | (bytes[6] ?? 0);
  const selectedCodec = (codecs & 0x02) !== 0 ? 0x02 : 0x01;

  return {
    version,
    codecs,
    interaction,
    frameSize: declaredFrameSize === 0 ? DEFAULT_FRAME_SIZE : declaredFrameSize,
    selectedCodec,
    sampleRate: selectedCodec === 0x02 ? SAMPLE_RATE_16K : SAMPLE_RATE_8K,
  };
}

/** Host -> remote: "open the microphone" (transmit characteristic). */
export function buildMicrophoneOpen(version: number, codec: number): Buffer {
  if (version >= 0x0100) return Buffer.from([0x0c, 0x00]);
  return Buffer.from([0x0c, 0x00, codec & 0xff]);
}

/** Host -> remote: "close the microphone". */
export function buildMicrophoneClose(version: number, sessionId = 0): Buffer {
  if (version >= 0x0100) return Buffer.from([0x0d, sessionId & 0xff]);
  return Buffer.from([0x0d]);
}

/** Host -> remote: "extend the current capture session" (v1.0 only). */
export function buildMicrophoneExtend(version: number, sessionId = 0): Buffer | null {
  if (version < 0x0100) return null;
  return Buffer.from([0x0e, sessionId & 0xff]);
}

/** Decode a control-characteristic notification into a plain event object. */
export function parseControl(data: Uint8Array): ControlEvent | null {
  if (data.length === 0) return null;
  const bytes = Array.from(data);

  switch (bytes[0]) {
    case CONTROL.CAPABILITIES: {
      const caps = parseCapabilities(data);
      return caps ? { op: 'capabilities', ...caps } : null;
    }
    case CONTROL.MIC_OPEN_REQUEST:
      return { op: 'mic-open-request' };
    case CONTROL.STREAM_START:
      return {
        op: 'stream-start',
        interaction: bytes[1] ?? 0,
        codec: bytes[2] ?? 0,
        sessionId: bytes[3] ?? 0,
      };
    case CONTROL.STREAM_STOP:
      return { op: 'stream-stop' };
    case CONTROL.SYNC: {
      if (bytes.length < 7) return null;
      const bits = ((bytes[4] ?? 0) << 8) | (bytes[5] ?? 0);
      // signed 16-bit predictor
      const predictor = (bits << 16) >> 16;
      return { op: 'sync', predictor, stepIndex: bytes[6] ?? 0 };
    }
    default:
      return { op: 'unknown', opcode: bytes[0] ?? 0, data: Buffer.from(bytes) };
  }
}
