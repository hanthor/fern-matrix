import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeQueueRecovery, SendQueueRecovery, type QueueReachability } from '../src/sdk/send-queue-recovery'
import type { RoomSendQueueUpdate } from '../src/sdk/generated/matrix_sdk_ffi'

afterEach(() => { vi.unstubAllGlobals() })

const failure = (id = 'tx', recoverable = true) => ({
  tag: 'SendError', inner: { transactionId: id, isRecoverable: recoverable },
}) as unknown as RoomSendQueueUpdate
const ended = (tag: 'SentEvent' | 'CancelledLocalEvent' | 'RetryEvent', id = 'tx') => ({
  tag, inner: { transactionId: id },
}) as unknown as RoomSendQueueUpdate
const current = () => true
const authenticated = async (): Promise<QueueReachability> => 'authenticated'
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('recoverable room queue policy', () => {
  it('does not probe without a recoverable failure', async () => {
    const policy = new SendQueueRecovery()
    const probe = vi.fn(authenticated), resume = vi.fn()
    await policy.recover(probe, resume, current)
    policy.update('room', failure('permanent', false))
    await policy.recover(probe, resume, current)
    expect(probe).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  })

  it('keeps a network failure until authenticated recovery and resumes its room once', async () => {
    const policy = new SendQueueRecovery(), resume = vi.fn()
    policy.update('room', failure())
    await policy.recover(async () => 'unavailable', resume, current)
    expect(resume).not.toHaveBeenCalled()
    await policy.recover(authenticated, resume, current)
    await policy.recover(authenticated, resume, current)
    expect(resume.mock.calls).toEqual([['room']])
  })

  it('never resumes a room with a permanent failure or another account', async () => {
    const a = new SendQueueRecovery(), b = new SendQueueRecovery(), resume = vi.fn(), other = vi.fn()
    a.update('safe', failure())
    a.update('blocked', failure('transient'))
    a.update('blocked', failure('permanent', false))
    b.update('other-account', failure())
    await a.recover(authenticated, resume, current)
    expect(resume.mock.calls).toEqual([['safe']])
    expect(other).not.toHaveBeenCalled()
    await b.recover(authenticated, other, current)
    expect(other.mock.calls).toEqual([['other-account']])
  })

  it.each(['SentEvent', 'CancelledLocalEvent', 'RetryEvent'] as const)(
    'does not resume an echo after %s during the probe', async tag => {
      const policy = new SendQueueRecovery(), resume = vi.fn(), probe = deferred<QueueReachability>()
      policy.update('room', failure())
      const pending = policy.recover(() => probe.promise, resume, current)
      policy.update('room', ended(tag))
      probe.resolve('authenticated')
      await pending
      expect(resume).not.toHaveBeenCalled()
    },
  )

  it('requires a fresh probe when a newer failure arrives during one', async () => {
    const policy = new SendQueueRecovery(), resume = vi.fn(), probe = deferred<QueueReachability>()
    policy.update('room', failure())
    const pending = policy.recover(() => probe.promise, resume, current)
    policy.update('room', failure())
    probe.resolve('authenticated')
    await pending
    expect(resume).not.toHaveBeenCalled()
    await policy.recover(authenticated, resume, current)
    expect(resume).toHaveBeenCalledOnce()
  })

  it('does not overwrite a new failure emitted synchronously while re-enabling', async () => {
    const policy = new SendQueueRecovery()
    policy.update('room', failure())
    const resume = vi.fn(() => policy.update('room', failure()))
    await policy.recover(authenticated, resume, current)
    await policy.recover(authenticated, resume, current)
    expect(resume).toHaveBeenCalledTimes(2)
  })

  it('deduplicates overlapping probes and preserves failures when enabling throws', async () => {
    const policy = new SendQueueRecovery(), probe = deferred<QueueReachability>()
    policy.update('room', failure())
    const check = vi.fn(() => probe.promise), resume = vi.fn(() => { throw new Error('temporarily unavailable') })
    const first = policy.recover(check, resume, current)
    const second = policy.recover(check, resume, current)
    expect(first).toBe(second)
    expect(check).toHaveBeenCalledOnce()
    probe.resolve('authenticated')
    await first
    const retry = vi.fn()
    await policy.recover(authenticated, retry, current)
    expect(retry).toHaveBeenCalledWith('room')
  })

  it('stops automatic recovery after authentication rejection', async () => {
    const policy = new SendQueueRecovery(), resume = vi.fn()
    policy.update('room', failure())
    await policy.recover(async () => 'unauthorized', resume, current)
    policy.update('room', failure('later'))
    await policy.recover(authenticated, resume, current)
    expect(resume).not.toHaveBeenCalled()
  })

  it.each(['stop', 'stale'] as const)('cannot revive an account after %s during a probe', async action => {
    const policy = new SendQueueRecovery(), resume = vi.fn(), probe = deferred<QueueReachability>()
    let alive = true
    policy.update('room', failure())
    const pending = policy.recover(() => probe.promise, resume, () => alive)
    if (action === 'stop') policy.stop()
    else alive = false
    probe.resolve('authenticated')
    await pending
    expect(resume).not.toHaveBeenCalled()
  })
})

describe('authenticated queue reachability', () => {
  const session = { homeserverUrl: 'https://matrix.invalid/', accessToken: 'test-only', userId: '@alice:matrix.invalid' }
  const signal = new AbortController().signal

  it('uses only the exact session endpoint with no redirects or cached result', async () => {
    const fetcher = vi.fn(async () => ({ status: 200, json: async () => ({ user_id: session.userId }) }))
    vi.stubGlobal('fetch', fetcher)
    await expect(probeQueueRecovery(session, signal)).resolves.toBe('authenticated')
    expect(fetcher).toHaveBeenCalledWith('https://matrix.invalid/_matrix/client/v3/account/whoami', {
      headers: { Authorization: 'Bearer test-only' }, cache: 'no-store', redirect: 'error', credentials: 'omit', signal,
    })
  })

  it.each([401, 403])('treats HTTP %i as requiring intervention', async status => {
    vi.stubGlobal('fetch', async () => ({ status }))
    await expect(probeQueueRecovery(session, signal)).resolves.toBe('unauthorized')
  })

  it.each([404, 429, 500, 302])('does not resume on HTTP %i', async status => {
    vi.stubGlobal('fetch', async () => ({ status }))
    await expect(probeQueueRecovery(session, signal)).resolves.toBe('unavailable')
  })

  it('does not resume on a wrong user, malformed response, or network failure', async () => {
    vi.stubGlobal('fetch', async () => ({ status: 200, json: async () => ({ user_id: '@other:matrix.invalid' }) }))
    await expect(probeQueueRecovery(session, signal)).resolves.toBe('unavailable')
    vi.stubGlobal('fetch', async () => ({ status: 200, json: async () => { throw new Error('invalid JSON') } }))
    await expect(probeQueueRecovery(session, signal)).resolves.toBe('unavailable')
    vi.stubGlobal('fetch', async () => { throw new Error('offline') })
    await expect(probeQueueRecovery(session, signal)).resolves.toBe('unavailable')
  })
  it('does not fetch or accept a response when the lifecycle signal is aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(probeQueueRecovery(session, controller.signal)).resolves.toBe('unavailable')
    expect(fetcher).not.toHaveBeenCalled()

    const duringJson = new AbortController()
    vi.stubGlobal('fetch', async () => ({
      status: 200, json: async () => { duringJson.abort(); return { user_id: session.userId } },
    }))
    await expect(probeQueueRecovery(session, duringJson.signal)).resolves.toBe('unavailable')
  })

})
