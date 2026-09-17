import { ref, type Ref } from 'vue'
import { fr } from './locales/fr'
import { en } from './locales/en'

export type Locale = 'fr' | 'en'
export type Dictionary = Record<string, string>
export type Params = Record<string, string | number>

export const LOCALES: Locale[] = ['fr', 'en']
export const DICTIONARIES: Record<Locale, Dictionary> = { fr, en }

/**
 * The language every `t()` call reads. French until a loaded config says otherwise, which is
 * what the admin and the dashboard both do as soon as they have one.
 */
export const locale = ref<Locale>('fr')

export function setLocale(next: Locale | undefined): void {
  locale.value = next === 'en' ? 'en' : 'fr'
}

const warned = new Set<string>()

/** French is the reference dictionary: a key only written there still shows its French text. */
export function translate(target: Locale, key: string, params?: Params): string {
  let text: string | undefined = DICTIONARIES[target][key]
  if (text === undefined) {
    if (import.meta.env.DEV && !warned.has(`${target}:${key}`)) {
      warned.add(`${target}:${key}`)
      console.warn(`i18n: missing key "${key}" for locale "${target}"`)
    }
    text = fr[key] ?? key
  }
  return params ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m)) : text
}

/** Reads the reactive locale, so any render that calls it re-runs when the language changes. */
export function t(key: string, params?: Params): string {
  return translate(locale.value, key, params)
}

/**
 * A text a widget manifest wrote: one string, shown as it stands, or a `{ fr, en }` pair. Falls
 * back the way `translate()` does — the asked-for language, then English, then French, then
 * whatever the object holds — so a half-translated manifest still shows words.
 *
 * Reads the reactive locale, so a render that calls it re-runs when the language changes.
 */
export function pick(text: string | Record<string, string> | undefined): string {
  if (text === undefined || text === null) return ''
  if (typeof text === 'string') return text
  return text[locale.value] ?? text.en ?? text.fr ?? Object.values(text)[0] ?? ''
}

export function useI18n(): { t: typeof t; locale: Ref<Locale> } {
  return { t, locale }
}
