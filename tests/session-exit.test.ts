import { afterEach, describe, expect, it, vi } from 'vitest'
import { canResetRecovery, createSessionExit, unknownExitRecovery, type ExitRecoveryStatus, type ExitTarget } from '../src/session-exit'

const a: ExitTarget = { id: 'session-a', userId: '@same:example.org', name: 'First device', mode: 'signout' }
const b: ExitTarget = { ...a, id: 'session-b', name: 'Second device', mode: 'remove' }
const enabled: ExitRecoveryStatus = { recovery: 'Enabled', backupExists: true, lastDevice: false }
async function flush() { for (let i = 0; i < 5; i++) await Promise.resolve() }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function harness(inspect = vi.fn(async (_id: string, _signal: AbortSignal) => enabled)) {
  const exists = vi.fn(() => true)
  const execute = vi.fn(async (_target: ExitTarget) => true)
  const flow = createSessionExit({ exists, inspect, execute }, 50)
  return { flow, exists, inspect, execute }
}
afterEach(() => vi.useRealTimers())

describe('session exit confirmation', () => {
  it('requires explicit acknowledgement even when recovery is enabled', async () => {
    const { flow, execute } = harness()
    flow.request(a)
    expect(await flow.confirm()).toBe(false)
    await flush()
    expect(flow.state.status).toEqual(enabled)
    expect(await flow.confirm()).toBe(false)
    expect(execute).not.toHaveBeenCalled()
    flow.state.acknowledged = true
    expect(await flow.confirm()).toBe(true)
    expect(execute).toHaveBeenCalledWith(a)
    expect(flow.state.target).toBeNull()
  })

  it('captures the session UUID and operation instead of an active-account lookup', async () => {
    const { flow, execute } = harness()
    const mutable = { ...a }
    flow.request(mutable)
    mutable.id = b.id; mutable.mode = b.mode
    await flush()
    flow.state.acknowledged = true
    await flow.confirm()
    expect(execute).toHaveBeenCalledWith(a)
  })

  it('cancel aborts checks and late results cannot replace a new target', async () => {
    const first = deferred<ExitRecoveryStatus>()
    const inspect = vi.fn(async (id: string, _signal: AbortSignal) => id === a.id ? first.promise : enabled)
    const { flow, execute } = harness(inspect)
    flow.request(a); await flush()
    const signal = inspect.mock.calls[0]![1]
    expect(flow.cancel()).toBe(true)
    expect(signal.aborted).toBe(true)
    flow.request(b); await flush()
    first.resolve({ recovery: 'Disabled', backupExists: false, lastDevice: true })
    await flush()
    expect(flow.state.target).toEqual(b)
    expect(flow.state.status).toEqual(enabled)
    expect(execute).not.toHaveBeenCalled()
    flow.cancel()
  })

  it('bounds a hanging read and retains unknown rather than implying safety', async () => {
    vi.useFakeTimers()
    const inspect = vi.fn((_id: string, _signal: AbortSignal) => new Promise<ExitRecoveryStatus>(() => {}))
    const { flow, execute } = harness(inspect)
    flow.request(a); await flush()
    await vi.advanceTimersByTimeAsync(50)
    expect(flow.state.checking).toBe(false)
    expect(flow.state.status).toEqual(unknownExitRecovery())
    expect(inspect.mock.calls[0]![1].aborted).toBe(true)
    expect(execute).not.toHaveBeenCalled()
    flow.state.acknowledged = true
    expect(await flow.confirm()).toBe(true)
  })

  it('failed checks stay unknown and do not erase the account', async () => {
    const { flow, execute } = harness(vi.fn(async () => { throw new Error('offline') }))
    flow.request(a); await flush()
    expect(flow.state.status).toEqual(unknownExitRecovery())
    expect(flow.state.checking).toBe(false)
    expect(execute).not.toHaveBeenCalled()
    flow.cancel()
  })

  it('review cancels the destructive intent and needs a fresh confirmation', async () => {
    const { flow, execute } = harness()
    flow.request(b); await flush()
    flow.state.acknowledged = true
    expect(flow.review()).toEqual(b)
    expect(flow.state.target).toBeNull()
    expect(await flow.confirm()).toBe(false)
    expect(execute).not.toHaveBeenCalled()
    flow.request(b)
    expect(flow.state.acknowledged).toBe(false)
    flow.cancel()
  })

  it('never operates on a session which disappeared while confirmation was open', async () => {
    const { flow, exists, execute } = harness()
    flow.request(a); await flush()
    exists.mockReturnValue(false)
    flow.state.acknowledged = true
    expect(await flow.confirm()).toBe(false)
    expect(flow.state.error).toBe('missing')
    expect(execute).not.toHaveBeenCalled()
    flow.cancel()
  })

  it('blocks duplicate submission, target replacement and cancellation while executing', async () => {
    const pending = deferred<boolean>()
    const { flow, execute } = harness()
    execute.mockImplementation(() => pending.promise)
    flow.request(a); await flush(); flow.state.acknowledged = true
    const first = flow.confirm()
    expect(flow.state.busy).toBe(true)
    expect(await flow.confirm()).toBe(false)
    expect(flow.request(b)).toBe(false)
    expect(flow.cancel()).toBe(false)
    expect(flow.review()).toBeNull()
    expect(execute).toHaveBeenCalledTimes(1)
    pending.resolve(true); await first
    expect(flow.state.target).toBeNull()
  })

  it('retains failed operation feedback instead of closing as success', async () => {
    const { flow, execute } = harness()
    execute.mockResolvedValue(false)
    flow.request(a); await flush(); flow.state.acknowledged = true
    expect(await flow.confirm()).toBe(false)
    expect(flow.state.error).toBe('failed')
    expect(flow.state.target).toEqual(a)
    expect(flow.state.busy).toBe(false)
    flow.cancel()
  })
})

describe('recovery reset presentation', () => {
  it('never exposes reset for loading, unknown, demo or disabled recovery', () => {
    for (const state of [undefined, 'Unknown', 'Demo only', 'Disabled', 'future-state']) expect(canResetRecovery(state)).toBe(false)
    expect(canResetRecovery('Enabled')).toBe(true)
    expect(canResetRecovery('Incomplete')).toBe(true)
  })
})

describe('app lock interruption', () => {
  it('refuses new intent, review and confirmation while locked', async () => {
    let locked = false
    const execute = vi.fn(async () => true)
    const flow = createSessionExit({ locked: () => locked, exists: () => true, inspect: async () => enabled, execute })
    flow.request(a); await flush(); flow.state.acknowledged = true
    locked = true
    expect(await flow.confirm()).toBe(false)
    expect(flow.review()).toBeNull()
    expect(flow.request(b)).toBe(false)
    flow.cancel()
    expect(flow.state.target).toBeNull()
    expect(execute).not.toHaveBeenCalled()
  })
})
