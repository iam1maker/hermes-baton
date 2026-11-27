import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

import { TypedEmitter } from '../util/emitter.js';

export type SidecarEvents = {
  state: [{ state: string }];
  device: [{ id: string; name: string; rssi: number }];
  connecting: [{ name: string; id: string }];
  connected: [{ name: string; id: string }];
  services: [{ uuids: string[] }];
  ready: [{ name: string; id: string }];
  control: [{ data: Buffer }];
  audio: [{ data: Buffer }];
  hid: [{ data: Buffer; uuid: string }];
  /** Raw HID usage from the non-exclusive keyboard reader (page/usage). */
  hidkey: [{
    page: number;
    usage: number;
    value: number;
    /** Source device name as the bridge prints it; HID watching is machine-wide. */
    device?: string;
    vid?: number | null;
    pid?: number | null;
  }];
  /** Battery percentage reported by the remote. */
  battery: [{ percent: number }];
  disconnect: [{ reason: string }];
  error: [{ message: string }];
  log: [{ message: string }];
  exit: [{ code: number | null }];
};

export interface SidecarOptions {
  /** Path to the compiled `atvv-link` binary. */
  binaryPath: string;
  /** Extra CLI arguments (e.g. `--device <uuid>`, `--hid`). */
  args?: string[];
  onLog?: (message: string) => void;
}

interface RawEvent {
  event?: string;
  message?: string;
  b64?: string;
  uuid?: string;
  name?: string;
  id?: string;
  rssi?: number;
  uuids?: string[];
  /** Polymorphic: a string for `state`, a number for `hidkey`. */
  value?: string | number;
  page?: number;
  usage?: number;
  device?: string;
  vid?: number;
  pid?: number;
  percent?: number;
  reason?: string;
}

/**
 * Transport for the Swift `atvv-link` bridge.
 *
 * The bridge owns CoreBluetooth because macOS only exposes a peripheral that
 * the system already holds through `retrieveConnectedPeripherals`, which noble
 * cannot call. Binary payloads travel as base64 JSON lines.
 */
export class SidecarTransport extends TypedEmitter<SidecarEvents> {
  readonly #binaryPath: string;
  readonly #args: string[];
  readonly #onLog: (message: string) => void;

  #child: ChildProcessWithoutNullStreams | null = null;
  #lines: Interface | null = null;
  #stderr: Interface | null = null;

  constructor({ binaryPath, args = [], onLog = () => {} }: SidecarOptions) {
    super();
    this.#binaryPath = binaryPath;
    this.#args = args;
    this.#onLog = onLog;
  }

  get running(): boolean {
    return this.#child !== null;
  }

  async start(): Promise<void> {
    if (this.#child) return;
    const child = spawn(this.#binaryPath, this.#args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child = child;

    this.#lines = createInterface({ input: child.stdout });
    this.#lines.on('line', (line) => this.#onLine(line));

    this.#stderr = createInterface({ input: child.stderr });
    this.#stderr.on('line', (line) => {
      if (line.trim().length > 0) this.#onLog(`[bridge stderr] ${line}`);
    });

    child.on('error', (error) => this.emit('error', { message: error.message }));
    child.on('exit', (code) => {
      this.#child = null;
      this.emit('exit', { code });
    });
  }

  /** Write a raw command to the ATVV transmit characteristic. */
  write(hex: string): void {
    this.#send({ cmd: 'write', hex });
  }

  /** Ask the bridge to subscribe to HID-over-GATT input reports. */
  watchHid(): void {
    this.#send({ cmd: 'hid-watch' });
  }

  /** Re-scan for the remote. */
  scan(): void {
    this.#send({ cmd: 'scan' });
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#send({ cmd: 'quit' });
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        // Hermes-side change: a plain SIGTERM does not always make the old bridge exit (the Swift side
        // may still be waiting on a CoreBluetooth callback), and a leftover process fights the new bridge for the same remote.
        child.kill('SIGTERM');
        const hard = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
          resolve();
        }, 600);
        if (typeof hard.unref === 'function') hard.unref();
      }, 1_000);
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
    });
    this.#lines?.close();
    this.#stderr?.close();
    this.#child = null;
  }

  #send(command: Record<string, unknown>): void {
    const child = this.#child;
    if (!child || child.killed) return;
    child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  #onLine(line: string): void {
    if (line.trim().length === 0) return;
    let raw: RawEvent;
    try {
      raw = JSON.parse(line) as RawEvent;
    } catch {
      this.emit('log', { message: `unparseable bridge line: ${line}` });
      return;
    }

    switch (raw.event) {
      case 'state':
        this.emit('state', { state: typeof raw.value === 'string' ? raw.value : 'unknown' });
        break;
      case 'device':
        this.emit('device', { id: raw.id ?? '', name: raw.name ?? '', rssi: raw.rssi ?? 0 });
        break;
      case 'connecting':
        this.emit('connecting', { name: raw.name ?? '', id: raw.id ?? '' });
        break;
      case 'connected':
        this.emit('connected', { name: raw.name ?? '', id: raw.id ?? '' });
        break;
      case 'services':
        this.emit('services', { uuids: raw.uuids ?? [] });
        break;
      case 'ready':
        this.emit('ready', { name: raw.name ?? '', id: raw.id ?? '' });
        break;
      case 'control':
        this.emit('control', { data: Buffer.from(raw.b64 ?? '', 'base64') });
        break;
      case 'audio':
        this.emit('audio', { data: Buffer.from(raw.b64 ?? '', 'base64') });
        break;
      case 'hid':
        this.emit('hid', { data: Buffer.from(raw.b64 ?? '', 'base64'), uuid: raw.uuid ?? '' });
        break;
      case 'hidkey': {
        const parsed = typeof raw.value === 'number' ? raw.value : Number(raw.value ?? 1);
        this.emit('hidkey', {
          page: raw.page ?? 0,
          usage: raw.usage ?? 0,
          value: Number.isFinite(parsed) ? parsed : 1,
          device: raw.device ?? '',
          vid: raw.vid ?? null,
          pid: raw.pid ?? null,
        });
        break;
      }
      case 'battery':
        this.emit('battery', { percent: Math.max(0, Math.min(100, raw.percent ?? 0)) });
        break;
      case 'disconnect':
        this.emit('disconnect', { reason: raw.reason ?? 'link lost' });
        break;
      case 'error':
        this.emit('error', { message: raw.message ?? 'unknown bridge error' });
        break;
      case 'bye':
        this.emit('log', { message: `bridge exited: ${raw.reason ?? ''}` });
        break;
      case 'log':
        this.emit('log', { message: raw.message ?? '' });
        break;
      default:
        this.emit('log', { message: line });
        break;
    }
  }
}
