import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ACCENT_KEY, DEFAULT_ACCENT, accent, initAccent, setAccent } from '../src/accent'

// Accent themes: persisted preference, validated ids, and the data-accent
// attribute that the stylesheet overrides key off.
function fakeLocalStorage() {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  })
  return values
}

describe('accent themes', () => {
  beforeEach(() => {
    fakeLocalStorage()
    const attributes = new Map<string, string>()
    vi.stubGlobal('document', {
      documentElement: {
        setAttribute: (key: string, value: string) => { attributes.set(key, value) },
        getAttribute: (key: string) => attributes.get(key) ?? null,
        removeAttribute: (key: string) => { attributes.delete(key) },
        hasAttribute: (key: string) => attributes.has(key),
      },
    })
    accent.value = DEFAULT_ACCENT
  })

  it('starts on the Fern default with no attribute', () => {
    expect(initAccent()).toBe('fern')
    expect(accent.value).toBe('fern')
    expect(document.documentElement.hasAttribute('data-accent')).toBe(false)
  })

  it('persists the choice and sets the attribute', () => {
    setAccent('ocean')
    expect(accent.value).toBe('ocean')
    expect(localStorage.getItem(ACCENT_KEY)).toBe('ocean')
    expect(document.documentElement.getAttribute('data-accent')).toBe('ocean')
  })

  it('restores a persisted accent on init', () => {
    localStorage.setItem(ACCENT_KEY, 'clay')
    expect(initAccent()).toBe('clay')
    expect(document.documentElement.getAttribute('data-accent')).toBe('clay')
  })

  it('falls back to Fern for unknown stored values', () => {
    localStorage.setItem(ACCENT_KEY, 'ultraviolet')
    expect(initAccent()).toBe('fern')
    expect(document.documentElement.hasAttribute('data-accent')).toBe(false)
  })

  it('clearing back to Fern removes the attribute', () => {
    setAccent('ochre')
    setAccent('fern')
    expect(document.documentElement.hasAttribute('data-accent')).toBe(false)
  })
})
