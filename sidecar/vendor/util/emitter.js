import { EventEmitter } from 'node:events';
/**
 * Minimal typed façade over Node's EventEmitter.
 *
 * Composition instead of inheritance keeps the public surface exact: callers
 * get compile-time checked event names and payloads without `any` casts, and
 * the underlying emitter never leaks into a class's public API.
 */
export class TypedEmitter {
    #emitter = new EventEmitter();
    on(event, listener) {
        this.#emitter.on(event, listener);
        return this;
    }
    once(event, listener) {
        this.#emitter.once(event, listener);
        return this;
    }
    off(event, listener) {
        this.#emitter.off(event, listener);
        return this;
    }
    emit(event, ...args) {
        return this.#emitter.emit(event, ...args);
    }
    /** Listener count for one event, mirroring `EventEmitter.listenerCount`. */
    listenerCount(event) {
        return this.#emitter.listenerCount(event);
    }
    removeAllListeners(event) {
        this.#emitter.removeAllListeners(event);
        return this;
    }
}
//# sourceMappingURL=emitter.js.map