import { ref } from 'vue'

export const ACCENT_KEY = 'fern.accent'

export const ACCENT_OPTIONS = [
  { label: 'Fern', value: 'fern' },
  { label: 'Ocean', value: 'ocean' },
  { label: 'Clay', value: 'clay' },
  { label: 'Ochre', value: 'ochre' },
] as const

export type AccentId = (typeof ACCENT_OPTIONS)[number]['value']

export const DEFAULT_ACCENT: AccentId = 'fern'

export const accent = ref<AccentId>(DEFAULT_ACCENT)

function resolveAccent(value: unknown): AccentId {
  return ACCENT_OPTIONS.some(option => option.value === value) ? (value as AccentId) : DEFAULT_ACCENT
}

function applyAccent(id: AccentId) {
  try {
    if (id === DEFAULT_ACCENT) document.documentElement.removeAttribute('data-accent')
    else document.documentElement.setAttribute('data-accent', id)
  } catch {
    /* Non-DOM runtimes skip the accent attribute. */
  }
}

export function setAccent(id: unknown) {
  const next = resolveAccent(id)
  accent.value = next
  try {
    localStorage.setItem(ACCENT_KEY, next)
  } catch {
    /* A preference that cannot persist stays default. */
  }
  applyAccent(next)
}

export function initAccent() {
  let stored: string | null = null
  try {
    stored = localStorage.getItem(ACCENT_KEY)
  } catch {
    stored = null
  }
  const next = resolveAccent(stored)
  accent.value = next
  applyAccent(next)
  return next
}
