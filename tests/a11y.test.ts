import { describe, expect, it } from 'vitest'
import { MIN_TARGET_SIZE, keyboardCoversComposer } from '../src/a11y'

describe('keyboard overlap policy', () => {
  it('ignores full-height viewports and unfocused composers', () => {
    expect(keyboardCoversComposer(800, 800, true)).toBe(false)
    expect(keyboardCoversComposer(790, 800, true)).toBe(false)
    expect(keyboardCoversComposer(400, 800, false)).toBe(false)
  })
  it('detects a covering keyboard only when the composer is focused', () => {
    expect(keyboardCoversComposer(400, 800, true)).toBe(true)
    expect(keyboardCoversComposer(599, 800, true)).toBe(true)
    expect(keyboardCoversComposer(600, 800, true)).toBe(false)
  })
  it('rejects degenerate viewports', () => {
    expect(keyboardCoversComposer(0, 800, true)).toBe(false)
    expect(keyboardCoversComposer(400, 0, true)).toBe(false)
  })
  it('keeps the enforced target size at the WCAG minimum', () => {
    expect(MIN_TARGET_SIZE).toBe(24)
  })
})
