import type { Messages } from './types'
import { en } from './en'
import { zh } from './zh'

export type { Messages } from './types'
export { en, zh }

export type Locale = 'zh' | 'en'

export const messages: Record<Locale, Messages> = { zh, en }

/**
 * Explicit preference wins; otherwise the OS language decides. A preference may
 * arrive as `zh`, `zh-CN`, `en-GB`, … so only the leading language tag matters.
 */
export function resolveLocale(pref?: string | null): Locale {
  const explicit = typeof pref === 'string' ? pref.trim().toLowerCase() : ''
  if (explicit.indexOf('zh') === 0) return 'zh'
  if (explicit.indexOf('en') === 0) return 'en'
  try {
    const language = typeof navigator !== 'undefined' && navigator ? String(navigator.language || '') : ''
    if (language.toLowerCase().indexOf('zh') === 0) return 'zh'
  } catch {
    /* no navigator (test harness): fall through to English */
  }
  return 'en'
}

/** Active locale; swapped by `applyLocale()` before the first render. */
export let locale: Locale = resolveLocale()

/** Active catalogue. Read as `L.group.key` at render time so it follows `locale`. */
export let L: Messages = messages[locale]

/** Point the renderer at the locale implied by a stored preference. */
export function applyLocale(pref?: string | null): Locale {
  locale = resolveLocale(pref)
  L = messages[locale]
  return locale
}

/** Fill `{name}` placeholders; unknown keys are left untouched. */
export function fmt(template: string, vars?: Record<string, unknown>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
  )
}
