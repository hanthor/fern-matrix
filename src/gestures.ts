// Touch gesture intents, kept DOM-free for unit testing (#44). One Pointer
// Events path serves mouse and touch; vertical scrolling is never hijacked
// (rows declare touch-action: pan-y) and activation needs deliberate
// displacement, optionally with fling velocity.

/** Leftward travel that always counts as a reply, however slow. */
export const SWIPE_REPLY_FAR_DX = 96
/** Leftward travel that counts as a reply only with fling velocity. */
export const SWIPE_REPLY_NEAR_DX = 48
/** Minimum leftward velocity for a short swipe to count (px per ms). */
export const SWIPE_FLING_VELOCITY = 0.5
/** Vertical slack: |dy| must stay under half of |dx| plus this (px). */
export const SWIPE_DY_SLACK = 8
/** Finger must start this close to the left screen edge for back navigation. */
export const EDGE_BACK_ZONE = 24
/** Minimum rightward travel for back navigation (px). */
export const EDGE_BACK_MIN_DX = 80
/** 1:1 tracking depth before rubber-band resistance (px). */
export const SWIPE_TRACK = 56
/** Damping applied past the tracking depth (rubber-band). */
export const SWIPE_RESISTANCE = 0.35
/** Stationary hold that counts as a long-press (ms). */
export const HOLD_MS = 500
/** Finger drift allowed during a long-press (px). */
export const HOLD_SLOP = 10

/**
 * Decide whether a leftward drag on a message row means "reply". dx/dy are
 * pointer travel in px (dx negative leftwards), durationMs the gesture time.
 */
export function swipeReplyIntent(dx: number, dy: number, durationMs: number): boolean {
  if (dx > -SWIPE_REPLY_NEAR_DX) return false
  if (Math.abs(dy) > Math.abs(dx) / 2 + SWIPE_DY_SLACK) return false
  if (dx <= -SWIPE_REPLY_FAR_DX) return true
  if (durationMs <= 0) return false
  return -dx / durationMs >= SWIPE_FLING_VELOCITY
}

/**
 * Decide whether a rightward drag from the left screen edge means "back to
 * the room list". Only offered on the phone layout, where the conversation
 * covers the list.
 */
export function edgeBackIntent(startX: number, dx: number, dy: number, phoneLayout: boolean): boolean {
  if (!phoneLayout || startX > EDGE_BACK_ZONE) return false
  if (dx < EDGE_BACK_MIN_DX) return false
  return Math.abs(dy) < dx
}

/**
 * Decide whether a stationary press counts as a long-press. elapsedMs is the
 * hold time, movedPx the finger drift since press. Mouse is excluded by the
 * callers (right-click covers desktop via contextmenu); this stays a pure
 * time-plus-slop predicate for unit testing.
 */
export function holdIntent(elapsedMs: number, movedPx: number): boolean {
  return elapsedMs >= HOLD_MS && movedPx <= HOLD_SLOP
}
