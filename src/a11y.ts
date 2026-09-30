// Accessibility helpers kept DOM-free for unit testing. The App wires the
// visual-viewport listener; the policy below decides when it should act.

/** Minimum interactive target size enforced by the browser suite (px). */
export const MIN_TARGET_SIZE = 24

/**
 * Decide whether a shrunken visual viewport is a covering on-screen keyboard
 * rather than split-screen or desktop resizing. Only scrolls the composer
 * into view when it is focused, so room-list scrolling is never hijacked.
 */
export function keyboardCoversComposer(viewportHeight: number, windowHeight: number, composerFocused: boolean): boolean {
  if (!composerFocused || windowHeight <= 0 || viewportHeight <= 0) return false
  return viewportHeight < windowHeight * 0.75
}
