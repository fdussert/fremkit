import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { DICTIONARIES, locale, setLocale, t, translate } from '../src/shared/i18n'
import { fr } from '../src/shared/locales/fr'
import { en } from '../src/shared/locales/en'

afterEach(() => { setLocale('fr'); vi.restoreAllMocks() })

describe('dictionaries', () => {
  it('carry exactly the same keys in both languages', () => {
    const frKeys = Object.keys(fr).sort()
    const enKeys = Object.keys(en).sort()
    expect({ missingInEn: frKeys.filter((k) => !(k in en)), missingInFr: enKeys.filter((k) => !(k in fr)) })
      .toEqual({ missingInEn: [], missingInFr: [] })
  })

  it('leaves no entry empty', () => {
    for (const [name, dict] of Object.entries(DICTIONARIES)) {
      for (const [key, text] of Object.entries(dict)) expect(text, `${name}:${key}`).not.toBe('')
    }
  })

  it('uses the same placeholders on both sides of a key', () => {
    const holders = (text: string): string[] => (text.match(/\{\w+\}/g) ?? []).sort()
    for (const key of Object.keys(fr)) expect(holders(en[key]), key).toEqual(holders(fr[key]))
  })
})

describe('translate', () => {
  it('returns the text of the asked-for language', () => {
    expect(translate('fr', 'admin.tabs.screen')).toBe('Écran')
    expect(translate('en', 'admin.tabs.screen')).toBe('Screen')
  })

  it('interpolates {name} parameters', () => {
    expect(translate('en', 'admin.market.installedAt', { version: '1.2.0' })).toBe('installed v1.2.0')
    expect(translate('fr', 'admin.inspector.widget.minSize', { w: 8, h: 4 })).toBe('Minimum 8×4 cellules.')
  })

  it('leaves a placeholder alone when no value is given for it', () => {
    expect(translate('en', 'admin.store.unknownWidget', { other: 'x' })).toBe('Unknown widget: {id}')
  })

  it('falls back to the French text when only French has the key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    DICTIONARIES.fr['test.onlyFrench'] = 'Seulement en français'
    try {
      expect(translate('en', 'test.onlyFrench')).toBe('Seulement en français')
    } finally {
      delete DICTIONARIES.fr['test.onlyFrench']
      warn.mockRestore()
    }
  })

  it('falls back to the key itself when no dictionary has it, and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(translate('en', 'test.nowhere.at.all')).toBe('test.nowhere.at.all')
    expect(translate('en', 'test.nowhere.at.all')).toBe('test.nowhere.at.all')
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('locale', () => {
  it('drives t() and takes French for anything that is not English', () => {
    expect(t('admin.tabs.screen')).toBe('Écran')
    setLocale('en')
    expect(locale.value).toBe('en')
    expect(t('admin.tabs.screen')).toBe('Screen')
    setLocale(undefined)
    expect(locale.value).toBe('fr')
  })
})

describe('the document language', () => {
  // These tests run without a DOM, so one is put in place for this block only: the point is that
  // setLocale writes the attribute, not that a browser exists.
  const element = { lang: '' }
  beforeEach(() => { (globalThis as { document?: unknown }).document = { documentElement: element } })
  afterEach(() => { delete (globalThis as { document?: unknown }).document })

  it('follows setLocale, so the page agrees with what is on screen', () => {
    // The HTML files ship a placeholder; this is where the real value comes from.
    setLocale('en')
    expect(element.lang).toBe('en')
    setLocale('fr')
    expect(element.lang).toBe('fr')
    setLocale(undefined)
    expect(element.lang).toBe('fr')
  })

  it('does nothing at all where there is no document', () => {
    delete (globalThis as { document?: unknown }).document
    expect(() => setLocale('en')).not.toThrow()
  })
})
