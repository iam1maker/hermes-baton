import { EventEmitter } from 'node:events';

/** Event payload tuples keyed by event name. Use a type alias, not an interface. */
export type EventMap = { [event: string]: unknown[] };

/**
 * Minimal typed façade over Node's EventEmitter.
 *
 * Composition instead of inheritance keeps the public surface exact: callers
 * get compile-time checked event names and payloads without `any` casts, and
 * the underlying emitter never leaks into a class's public API.
 */
export class TypedEmitter<Events extends EventMap> {
  readonly #emitter = new EventEmitter();

  on<K extends keyof Events & string>(event: K, listener: (...args: Events[K]) => void): this {
    this.#emitter.on(event, listener);
    return this;
  }

  once<K extends keyof Events & string>(event: K, listener: (...args: Events[K]) => void): this {
    this.#emitter.once(event, listener);
    return this;
  }

  off<K extends keyof Events & string>(event: K, listener: (...args: Events[K]) => void): this {
    this.#emitter.off(event, listener);
    return this;
  }

  protected emit<K extends keyof Events & string>(event: K, ...args: Events[K]): boolean {
    return this.#emitter.emit(event, ...args);
  }

  /** Listener count for one event, mirroring `EventEmitter.listenerCount`. */
  listenerCount(event: keyof Events & string): number {
    return this.#emitter.listenerCount(event);
  }

  protected removeAllListeners(event?: keyof Events & string): this {
    this.#emitter.removeAllListeners(event);
    return this;
  }
}
