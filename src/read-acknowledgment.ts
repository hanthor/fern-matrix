export interface ReadTarget { accountId: string; roomId: string; eventId: string; generation: number }
const roomKey = (target: ReadTarget) => JSON.stringify([target.accountId, target.roomId])
const visitKey = (target: ReadTarget) => JSON.stringify([target.generation, target.eventId])
const same = (a?: ReadTarget, b?: ReadTarget) => a === b || Boolean(a && b && roomKey(a) === roomKey(b) && visitKey(a) === visitKey(b))

// Geometry observers may report the same target many times. One attempt per
// recent event/visit bounds both failures and cancellations; explicit room reopening
// permits retry. Successful receipts remain deduplicated across visits.
export class VisibleReadAcknowledger {
  private current?: ReadTarget
  private pending?: { target: ReadTarget; controller: AbortController }
  private succeeded = new Map<string, string>()
  private attempted = new Map<string, { generation: number; events: Set<string>; latestEvent: string }>()
  constructor(
    private send: (target: ReadTarget, signal: AbortSignal) => Promise<boolean>,
    private success: (target: ReadTarget) => void,
    private failure: (target: ReadTarget, error: unknown) => void,
  ) {}
  update(target?: ReadTarget) {
    if (same(this.current, target)) return
    this.current = target
    this.pending?.controller.abort()
    if (!target) return
    const key = roomKey(target)
    let visit = this.attempted.get(key)
    if (!visit || visit.generation !== target.generation) {
      visit = { generation: target.generation, events: new Set(), latestEvent: '' }
      this.attempted.set(key, visit)
    }
    if (this.succeeded.get(key) === target.eventId || visit.events.has(target.eventId)) return
    visit.events.add(target.eventId)
    // Bound memory without letting ordinary A → B → A snapshot changes retry A.
    if (visit.events.size > 256) visit.events.delete(visit.events.values().next().value!)
    visit.latestEvent = target.eventId
    const request = { target, controller: new AbortController() }
    this.pending = request
    void this.send(target, request.controller.signal).then(sent => {
      // A completed dispatch is still deduplicated if navigation changed while
      // it was in flight, but it must never update the new view's counters.
      if (sent && this.attempted.get(key) === visit && visit.latestEvent === target.eventId) this.succeeded.set(key, target.eventId)
      if (sent && !request.controller.signal.aborted && same(this.current, target)) this.success(target)
    }).catch(error => {
      if (!request.controller.signal.aborted && same(this.current, target)) this.failure(target, error)
    }).finally(() => { if (this.pending === request) this.pending = undefined })
  }
  clear() { this.update() }
  forgetAccount(accountId: string) {
    if (this.current?.accountId === accountId) this.clear()
    for (const key of this.attempted.keys()) if (JSON.parse(key)[0] === accountId) this.attempted.delete(key)
    for (const key of this.succeeded.keys()) if (JSON.parse(key)[0] === accountId) this.succeeded.delete(key)
  }
}

export interface Rectangle { top: number; bottom: number; left: number; right: number }
// The last event's bottom edge must actually be in the visible timeline. A
// distance-from-bottom heuristic can acknowledge a row hidden below the pane.
export function visibleEventBottom(row: Rectangle, viewport: Rectangle): boolean {
  return row.bottom > row.top && row.right > row.left && viewport.bottom > viewport.top
    && viewport.right > viewport.left && row.bottom > viewport.top
    && row.bottom <= viewport.bottom + 1 && row.right > viewport.left && row.left < viewport.right
}
