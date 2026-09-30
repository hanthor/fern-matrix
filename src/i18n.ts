// Localization foundation (#32): vue-i18n with English plus a German pilot
// catalog. Only catalogued surfaces translate (settings tabs, device lock,
// updater, language switcher); everything else stays English until its
// screen migrates. The key-parity test keeps both catalogs in sync.
import { createI18n } from 'vue-i18n'
import en from './locales/en.json'
import de from './locales/de.json'

export const LOCALES = ['en', 'de'] as const
export type Locale = (typeof LOCALES)[number]
const PREF_KEY = 'fern.locale'

export function resolveLocale(saved: string | null, navigatorLanguage: string | undefined): Locale {
  if (saved === 'en' || saved === 'de') return saved
  return navigatorLanguage?.toLowerCase().startsWith('de') ? 'de' : 'en'
}

export function loadLocalePref(): Locale {
  try {
    return resolveLocale(localStorage.getItem(PREF_KEY), navigator.language)
  } catch { return 'en' }
}

export const i18n = createI18n({
  legacy: false,
  locale: loadLocalePref(),
  fallbackLocale: 'en',
  messages: { en, de },
})

export function setLocale(locale: Locale) {
  ;(i18n.global.locale as { value: Locale }).value = locale
  try { document.documentElement.lang = locale } catch { /* Non-DOM runtimes skip the lang tag. */ }
  try { localStorage.setItem(PREF_KEY, locale) } catch { /* A preference that cannot persist stays default. */ }
}

export function localeNames(t: (key: string) => string): { label: string; value: Locale }[] {
  return [
    { label: `${t('locale.english')} (English)`, value: 'en' },
    { label: `${t('locale.german')} (Deutsch)`, value: 'de' },
  ]
}
