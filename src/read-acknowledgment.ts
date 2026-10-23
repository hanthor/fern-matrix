export interface ReadTarget { accountId: string; roomId: string; rootId?: string; eventId: string; generation: number }
const roomKey = (target: ReadTarget) => JSON.stringify([target.accountId, target.roomId, target.rootId ?? ''])
const eventKey = (target: ReadTarget) => JSON.stringify([roomKey(target), target.eventId])
const same = (a?: ReadTarget, b?: ReadTarget) => a === b || Boolean(a && b && eventKey(a) === eventKey(b) && a.generation === b.generation)
type Visit = { generation: number; events: Set<string> }
type PendingRead = { target: ReadTarget; controller: AbortController; visit: Visit }

// Network acknowledgment and its application to the currently visible view
// have different lifetimes. Pending event leases survive navigation until the
// outcome is known, preventing same-event overlap across visits.
export class VisibleReadAcknowledger {
  private current?: ReadTarget
  private pending = new Map<string, PendingRead>()
  private succeeded = new Map<string, Set<string>>()
  private attempted = new Map<string, Visit>()
  constructor(
    private send: (target: ReadTarget, signal: AbortSignal) => Promise<boolean>,
    private success: (target: ReadTarget) => void,
    private failure: (target: ReadTarget, error: unknown) => void,
  ) {}
  update(target?: ReadTarget) {
    this.current = target
    for (const request of this.pending.values()) {
      if (!same(request.target, target)) request.controller.abort()
    }
    if (target) this.attempt(target)
  }
  private attempt(target: ReadTarget) {
    const key = roomKey(target), event = eventKey(target)
    if (this.succeeded.get(key)?.has(target.eventId)) {
      // Fresh geometry may reveal an acknowledged target again or add older
      // loaded content. Refresh owned local state, never resend the receipt.
      this.success(target)
      return
    }
    // An aborted request may still have reached the server. Do not dispatch
    // this event again in any visit until that request has actually settled.
    if (this.pending.has(event)) return
    let visit = this.attempted.get(key)
    if (!visit || visit.generation !== target.generation) {
      visit = { generation: target.generation, events: new Set() }
      this.attempted.set(key, visit)
    }
    if (visit.events.has(target.eventId)) return
    this.remember(visit.events, target.eventId)
    const request: PendingRead = { target, controller: new AbortController(), visit }
    this.pending.set(event, request)
    void this.send(target, request.controller.signal).then(sent => {
      // Account removal deletes the lease; an old completion must not
      // repopulate bookkeeping for a removed or replacement session.
      if (this.pending.get(event) !== request) return
      this.pending.delete(event)
      if (sent) {
        let events = this.succeeded.get(key)
        if (!events) { events = new Set(); this.succeeded.set(key, events) }
        this.remember(events, target.eventId)
        const visible = this.current
        if (visible && eventKey(visible) === event) this.success(visible)
        return
      }
      // Only a canceled, definitely-unsent false result releases a same-visit
      // attempt. Unknown failures remain latched until explicit reopening.
      if (request.controller.signal.aborted && this.attempted.get(key) === visit) visit.events.delete(target.eventId)
      this.resumeCurrent(event, request)
    }, error => {
      if (this.pending.get(event) !== request) return
      this.pending.delete(event)
      if (!request.controller.signal.aborted && same(this.current, target)) this.failure(target, error)
      // A different generation is an explicit reopen, not an observer retry.
      // It may retry an unknown outcome only after the old request settled.
      if (this.current && this.current.generation !== target.generation) this.resumeCurrent(event, request)
    })
  }
  private resumeCurrent(event: string, request: PendingRead) {
    const visible = this.current
    if (!visible || eventKey(visible) !== event) return
    if (request.controller.signal.aborted || visible.generation !== request.target.generation) this.attempt(visible)
  }
  private remember(events: Set<string>, eventId: string) {
    events.add(eventId)
    if (events.size > 256) events.delete(events.values().next().value!)
  }
  clear() { this.update() }
  forgetAccount(accountId: string) {
    if (this.current?.accountId === accountId) this.clear()
    for (const [key, request] of this.pending) if (request.target.accountId === accountId) {
      request.controller.abort(); this.pending.delete(key)
    }
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
