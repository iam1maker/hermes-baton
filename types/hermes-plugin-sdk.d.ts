/**
 * Local mirror of the `@hermes/plugin-sdk` surface the baton renderer uses.
 *
 * The runtime resolves the REAL module — `@hermes/plugin-sdk` stays external in
 * `desktop/plugin.js`. This file exists only so `node dev/typecheck.mjs` can type
 * the TSX source without dragging in the app's `@/…` internals.
 *
 * Kept in step by hand with:
 *   apps/desktop/src/contrib/plugin.ts   (PluginContext / PluginContribution / HermesPlugin)
 *   apps/desktop/src/sdk/composer.ts     (composerHost)
 *   apps/desktop/src/sdk/index.ts        (host.state / notify / navigate / request / newChat)
 *
 * Deliberately narrower than the real SDK: a typo in our own call still fails the
 * build, which is the whole point of typing a runtime-resolved module.
 */
import type { ReactNode } from 'react'

/** `insertText` modes, from sdk/composer.ts. */
export type ComposerInsertMode = 'block' | 'inline' | 'prefix'

export type ToastKind = 'info' | 'success' | 'warning' | 'error'

/** nanostore-shaped readonly atom: `.get()` or `subscribe`. */
export interface ReadableAtom<T> {
  get(): T
  subscribe(listener: (value: T) => void): () => void
}

export interface PluginRestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
  /** Client-side abort window; the gateway keeps its own ceiling. */
  timeoutMs?: number
}

/** Plugin-scoped persistence (`ctx.storage`). */
export interface PluginStorage {
  get<T>(key: string, fallback: T): T
  set<T>(key: string, value: T): void
  remove(key: string): void
}

/** A registration as an author writes it (source/id scoping is the host's job). */
export interface PluginContribution {
  id: string
  area: string
  title?: string
  order?: number
  when?: () => boolean
  enabled?: boolean
  render?: () => ReactNode
  data?: unknown
}

export interface PluginPet {
  say(text: string, opts?: { ttlMs?: number }): void
}

export interface PluginContext {
  readonly source: string
  register(c: PluginContribution): () => void
  registerMany(cs: PluginContribution[]): () => void
  onDispose(fn: () => void): void
  onEvent(type: string, listener: (event: unknown) => void): () => void
  setTimeout(fn: () => void, ms: number): () => void
  setInterval(fn: () => void, ms: number): () => void
  addEventListener(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean
  ): () => void
  /** REST to this plugin's own backend namespace (`/api/plugins/<id>`). */
  rest<T>(path: string, opts?: PluginRestOptions): Promise<T>
  socket(path: string, onMessage: (data: unknown) => void): () => void
  storage: PluginStorage
  pet: PluginPet
}

export interface PluginComposerHost {
  getDraft(sessionId?: null | string): Promise<null | string>
  setDraft(sessionId: null | string, text: string): Promise<boolean>
  insertText(sessionId: null | string, text: string, opts?: { mode?: ComposerInsertMode }): Promise<boolean>
  submit(sessionId: null | string, text: string): boolean
  focus(sessionId?: null | string): void
}

export interface PluginHost {
  /** Read-only app state (nanostore atoms). */
  state: {
    focusedSessionId: ReadableAtom<string | null>
    activeSessionId: ReadableAtom<string | null>
    focusedStoredSessionId: ReadableAtom<string | null>
  }
  notify(input: { kind?: ToastKind; message: string }): void
  navigate(path: string): void
  newChat(): void
  /** Gateway JSON-RPC door. */
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  composer: PluginComposerHost
}

export interface HermesPlugin {
  id: string
  name?: string
  description?: string
  defaultEnabled?: boolean
  capabilities?: readonly string[]
  register(ctx: PluginContext): void
}

export declare const host: PluginHost
