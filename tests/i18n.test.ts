import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import { resolveLocale } from '../src/i18n'
import en from '../src/locales/en.json'
import de from '../src/locales/de.json'

// Localization foundation (#32): resolver matrix plus a key-parity guard so
// the German pilot catalog can never drift from English.
function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => keys(nested, prefix ? `${prefix}.${key}` : key))
}

describe('resolveLocale', () => {
  it('prefers an explicit saved locale', () => {
    expect(resolveLocale('de', 'en-US')).toBe('de')
    expect(resolveLocale('en', 'de-DE')).toBe('en')
  })
  it('falls back to the browser language, defaulting to English', () => {
    expect(resolveLocale(null, 'de-AT')).toBe('de')
    expect(resolveLocale(null, 'DE')).toBe('de')
    expect(resolveLocale(null, 'fr-FR')).toBe('en')
    expect(resolveLocale(null, undefined)).toBe('en')
    expect(resolveLocale('xx', 'en-US')).toBe('en')
  })
})

describe('pilot catalogs', () => {
  it('keeps German keys identical to English', () => {
    expect(keys(de).sort()).toEqual(keys(en).sort())
  })

  it('translates pilot strings with English fallback', () => {
    const i18n = createI18n({ legacy: false, locale: 'de', fallbackLocale: 'en', messages: { en, de } })
    const { t } = i18n.global
    expect(t('lock.title')).toBe('Willkommen zurück')
    expect(t('tabs.security')).toBe('Sicherheit')
    expect(t('updates.install', { version: '0.2.0' })).toBe('0.2.0 installieren')
    expect(t('lock.delays.five')).toBe('Nach 5 Minuten')
  })

  it('falls back to English for untranslated screens', () => {
    const i18n = createI18n({ legacy: false, locale: 'de', fallbackLocale: 'en', messages: { en, de } })
    // No catalog entry anywhere: vue-i18n returns the key, never blank copy.
    expect(i18n.global.t('rooms.notMigratedYet')).toBe('rooms.notMigratedYet')
  })
})
