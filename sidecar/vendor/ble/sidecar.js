import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { TypedEmitter } from '../util/emitter.js';
/**
 * Transport for the Swift `atvv-link` bridge.
 *
 * The bridge owns CoreBluetooth because macOS only exposes a peripheral that
 * the system already holds through `retrieveConnectedPeripherals`, which noble
 * cannot call. Binary payloads travel as base64 JSON lines.
 */
export class SidecarTransport extends TypedEmitter {
    #binaryPath;
    #args;
    #onLog;
    #child = null;
    #lines = null;
    #stderr = null;
    constructor({ binaryPath, args = [], onLog = () => { } }) {
        super();
        this.#binaryPath = binaryPath;
        this.#args = args;
        this.#onLog = onLog;
    }
    get running() {
        return this.#child !== null;
    }
    async start() {
        if (this.#child)
            return;
        const child = spawn(this.#binaryPath, this.#args, { stdio: ['pipe', 'pipe', 'pipe'] });
        this.#child = child;
        this.#lines = createInterface({ input: child.stdout });
        this.#lines.on('line', (line) => this.#onLine(line));
        this.#stderr = createInterface({ input: child.stderr });
        this.#stderr.on('line', (line) => {
            if (line.trim().length > 0)
                this.#onLog(`[bridge stderr] ${line}`);
        });
        child.on('error', (error) => this.emit('error', { message: error.message }));
        child.on('exit', (code) => {
            this.#child = null;
            this.emit('exit', { code });
        });
    }
    /** Write a raw command to the ATVV transmit characteristic. */
    write(hex) {
        this.#send({ cmd: 'write', hex });
    }
    /** Ask the bridge to subscribe to HID-over-GATT input reports. */
    watchHid() {
        this.#send({ cmd: 'hid-watch' });
    }
    /** Re-scan for the remote. */
    scan() {
        this.#send({ cmd: 'scan' });
    }
    async stop() {
        const child = this.#child;
        if (!child)
            return;
        this.#send({ cmd: 'quit' });
        await new Promise((resolve) => {
            const force = setTimeout(() => {
                // Hermes 侧改动：旧的桥只是 SIGTERM 不一定会退（Swift 侧可能仍在等
                // CoreBluetooth 回调），残留进程会和新的桥抢同一台遥控器的连接。
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
    #send(command) {
        const child = this.#child;
        if (!child || child.killed)
            return;
        child.stdin.write(`${JSON.stringify(command)}\n`);
    }
    #onLine(line) {
        if (line.trim().length === 0)
            return;
        let raw;
        try {
            raw = JSON.parse(line);
        }
        catch {
            this.emit('log', { message: `unparseable bridge line: ${line}` });
            return;
        }
        switch (raw.event) {
            case 'state':
                this.emit('state', { state: raw.value ?? 'unknown' });
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
            case 'hidkey':
                this.emit('hidkey', {
                    page: raw.page ?? 0,
                    usage: raw.usage ?? 0,
                    value: raw.value ?? 1,
                    device: raw.device ?? '',
                    vid: raw.vid ?? null,
                    pid: raw.pid ?? null,
                });
                break;
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
//# sourceMappingURL=sidecar.js.map