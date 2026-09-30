import { describe, expect, it } from 'vitest'
import { HOLD_MS, HOLD_SLOP, edgeBackIntent, holdIntent, swipeReplyIntent } from '../src/gestures'

// Swipe gesture intents (#44): deliberate horizontal motion activates,
// vertical scrolling and hesitant drifts never do.
describe('swipeReplyIntent', () => {
  it('accepts a far deliberate leftward drag at any speed', () => {
    expect(swipeReplyIntent(-120, 0, 2000)).toBe(true)
    expect(swipeReplyIntent(-96, -10, 5000)).toBe(true)
  })

  it('accepts a short fast fling', () => {
    expect(swipeReplyIntent(-60, 5, 100)).toBe(true)
    expect(swipeReplyIntent(-48, 0, 80)).toBe(true)
  })

  it('rejects short slow drifts', () => {
    expect(swipeReplyIntent(-60, 5, 500)).toBe(false)
    expect(swipeReplyIntent(-48, 0, 200)).toBe(false)
    expect(swipeReplyIntent(-20, 0, 10)).toBe(false)
  })

  it('rejects vertical scrolling and rightward motion', () => {
    expect(swipeReplyIntent(-120, 100, 300)).toBe(false)
    expect(swipeReplyIntent(-50, 60, 50)).toBe(false)
    expect(swipeReplyIntent(120, 0, 100)).toBe(false)
    expect(swipeReplyIntent(0, -200, 300)).toBe(false)
  })

  it('rejects degenerate input', () => {
    expect(swipeReplyIntent(-60, 0, 0)).toBe(false)
    expect(swipeReplyIntent(0, 0, 100)).toBe(false)
  })
})

describe('edgeBackIntent', () => {
  it('accepts a rightward drag from the left edge on the phone layout', () => {
    expect(edgeBackIntent(10, 120, 5, true)).toBe(true)
    expect(edgeBackIntent(0, 80, -20, true)).toBe(true)
  })

  it('rejects drags away from the edge, short drags and desktop layout', () => {
    expect(edgeBackIntent(60, 200, 0, true)).toBe(false)
    expect(edgeBackIntent(10, 40, 0, true)).toBe(false)
    expect(edgeBackIntent(10, 120, 5, false)).toBe(false)
  })

  it('rejects diagonal drags that read as scrolling', () => {
    expect(edgeBackIntent(10, 100, 120, true)).toBe(false)
  })
})

describe('holdIntent', () => {
  it('accepts a stationary hold past the threshold', () => {
    expect(holdIntent(HOLD_MS, 0)).toBe(true)
    expect(holdIntent(HOLD_MS + 400, HOLD_SLOP)).toBe(true)
  })

  it('rejects quick taps and drifting touches', () => {
    expect(holdIntent(HOLD_MS - 1, 0)).toBe(false)
    expect(holdIntent(0, 0)).toBe(false)
    expect(holdIntent(HOLD_MS + 400, HOLD_SLOP + 1)).toBe(false)
  })
})
