import { describe, expect, it, vi } from 'vitest'
import { VisibleReadAcknowledger, visibleEventBottom, type ReadTarget } from '../src/read-acknowledgment'
const target = (eventId = '$one', generation = 1, accountId = 'a'): ReadTarget => ({ accountId, roomId: '!room:x', eventId, generation })
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

describe('visible read acknowledgment coordination', () => {
  it('coalesces repeated checks and deduplicates success across visits', async () => {
    const pending = deferred<boolean>()
    const send = vi.fn(() => pending.promise), success = vi.fn(), failure = vi.fn()
    const reads = new VisibleReadAcknowledger(send, success, failure)
    reads.update(target()); reads.update(target()); reads.update(target())
    expect(send).toHaveBeenCalledTimes(1)
    pending.resolve(true); await flush()
    expect(success).toHaveBeenCalledTimes(1)
    reads.clear(); reads.update(target('$one', 2))
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('cancels an abandoned target and never updates its counters or errors', async () => {
    const pending = deferred<boolean>()
    const send = vi.fn((_target: ReadTarget, _signal: AbortSignal) => pending.promise)
    const success = vi.fn(), failure = vi.fn()
    const reads = new VisibleReadAcknowledger(send, success, failure)
    reads.update(target()); reads.clear()
    expect(send.mock.calls[0][1].aborted).toBe(true)
    pending.resolve(true); await flush()
    expect(success).not.toHaveBeenCalled(); expect(failure).not.toHaveBeenCalled()
  })
  it('bounds failure retries to an explicit new visit', async () => {
    const send = vi.fn(async () => { throw new Error('offline') })
    const failure = vi.fn()
    const reads = new VisibleReadAcknowledger(send, vi.fn(), failure)
    reads.update(target()); await flush()
    reads.clear(); reads.update(target()); await flush()
    expect(send).toHaveBeenCalledTimes(1); expect(failure).toHaveBeenCalledTimes(1)
    reads.update(target('$one', 2)); await flush()
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('a new unseen event does not inherit an older completion', async () => {
    const old = deferred<boolean>(), next = deferred<boolean>()
    const send = vi.fn((value: ReadTarget) => value.eventId === '$one' ? old.promise : next.promise)
    const success = vi.fn()
    const reads = new VisibleReadAcknowledger(send, success, vi.fn())
    reads.update(target()); reads.update(target('$two'))
    next.resolve(true); await flush()
    old.resolve(true); await flush()
    expect(success).toHaveBeenCalledExactlyOnceWith(target('$two'))
    reads.clear(); reads.update(target('$two'))
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('keeps sessions separate and forgets removed account bookkeeping', async () => {
    const send = vi.fn(async () => true)
    const reads = new VisibleReadAcknowledger(send, vi.fn(), vi.fn())
    reads.update(target()); await flush()
    reads.update(target('$one', 1, 'b')); await flush()
    expect(send).toHaveBeenCalledTimes(2)
    reads.forgetAccount('a')
    reads.update(target('$one', 2, 'a')); await flush()
    expect(send).toHaveBeenCalledTimes(3)
  })
  it('does not retry A when snapshot targets go A to B to A in one visit', async () => {
    const send = vi.fn(async () => false)
    const reads = new VisibleReadAcknowledger(send, vi.fn(), vi.fn())
    reads.update(target('$A')); await flush()
    reads.update(target('$B')); await flush()
    reads.update(target('$A')); await flush()
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('bounds pre-dispatch cancellation without creating observer retry loops', async () => {
    const send = vi.fn(async () => false)
    const reads = new VisibleReadAcknowledger(send, vi.fn(), vi.fn())
    reads.update(target()); await flush()
    reads.clear(); reads.update(target()); await flush()
    expect(send).toHaveBeenCalledTimes(1)
    reads.update(target('$one', 2)); await flush()
    expect(send).toHaveBeenCalledTimes(2)
  })
})

describe('visible latest-event geometry', () => {
  const viewport = { top: 100, bottom: 500, left: 0, right: 400 }
  it('requires the event bottom edge inside the visible timeline', () => {
    expect(visibleEventBottom({ top: 350, bottom: 450, left: 10, right: 390 }, viewport)).toBe(true)
    expect(visibleEventBottom({ top: 450, bottom: 550, left: 10, right: 390 }, viewport)).toBe(false)
    expect(visibleEventBottom({ top: 0, bottom: 90, left: 10, right: 390 }, viewport)).toBe(false)
    expect(visibleEventBottom({ top: 300, bottom: 450, left: 410, right: 600 }, viewport)).toBe(false)
  })
  it('accepts the bottom of a tall event and rejects collapsed panes', () => {
    expect(visibleEventBottom({ top: -1000, bottom: 450, left: 10, right: 390 }, viewport)).toBe(true)
    expect(visibleEventBottom({ top: 400, bottom: 400, left: 10, right: 390 }, viewport)).toBe(false)
    expect(visibleEventBottom({ top: 300, bottom: 450, left: 10, right: 390 }, { ...viewport, bottom: 100 })).toBe(false)
  })
})
