import { afterEach, describe, expect, it, vi } from 'vitest'
import { MatrixEngine } from '../src/sdk/engine'
import type { Account } from '../src/types'
import type { ClientInterface, RoomSendQueueUpdate, TaskHandleInterface } from '../src/sdk/generated/matrix_sdk_ffi'

afterEach(() => { vi.unstubAllGlobals() })

function harness() {
  const accounts = vi.fn(), errors = vi.fn()
  const engine = new MatrixEngine({ account: accounts, rooms() {}, error: errors })
  const internals = engine as unknown as {
    installQueueRecovery(client: ClientInterface, id: string, account: Account, current: () => boolean, handles: TaskHandleInterface[]): Promise<boolean>
    queueRecoveries: Map<string, { recover: () => Promise<unknown>; stop: () => void; rejectAuth: () => void }>
    clients: Map<string, ClientInterface>
    handles: Map<string, TaskHandleInterface[]>
    refreshFailures: Map<string, number>
    refreshRooms: (id: string) => Promise<void>
    pingServer: (id: string) => Promise<void>
    noteRefreshFailure: (id: string, error: unknown) => void
    noteRefreshSuccess: (id: string) => void
    checkSessionAlive: (id: string, account: Account, syncState: number) => Promise<void>
  }
  let session = { accessToken: 'test-token-before', homeserverUrl: 'https://matrix.invalid', userId: '@alice:matrix.invalid' }
  let onUpdate!: (roomId: string, update: RoomSendQueueUpdate) => void
  let active = true
  const enable = vi.fn(), cancel = vi.fn()
  const client = {
    session: () => ({ ...session }),
    userId: () => session.userId,
    homeserver: () => session.homeserverUrl,
    getRoom: () => ({ enableSendQueue: enable }),
    subscribeToSendQueueUpdates: async (listener: { onUpdate: typeof onUpdate }) => {
      onUpdate = listener.onUpdate
      return { cancel }
    },
  } as unknown as ClientInterface
  const account: Account = { id: 'a', userId: session.userId, name: 'Alice', color: '#477962', connection: 'online' }
  const handles: TaskHandleInterface[] = []
  internals.clients.set('a', client)
  internals.handles.set('a', handles)
  internals.refreshRooms = async () => {}
  const install = () => internals.installQueueRecovery(client, 'a', account, () => active, handles)
  const fail = () => onUpdate('room', {
    tag: 'SendError', inner: { transactionId: 'tx', isRecoverable: true },
  } as unknown as RoomSendQueueUpdate)
  return {
    engine, client, account, internals, install, fail, enable, cancel, accounts, errors, handles,
    rotate: () => { session = { ...session, accessToken: 'test-token-after' } },
    stale: () => { active = false },
  }
}

describe('engine queue recovery attachment', () => {
  it('does not treat an old-token 401 as rejection of a refreshed SDK session', async () => {
    const h = harness()
    await h.install()
    h.fail()
    let resolve!: (value: { status: number }) => void
    vi.stubGlobal('fetch', () => new Promise(done => { resolve = done }))
    const recovery = h.internals.queueRecoveries.get('a')!
    const pending = recovery.recover()
    h.rotate()
    resolve({ status: 401 })
    await pending
    expect(h.enable).not.toHaveBeenCalled()
    expect(h.errors).not.toHaveBeenCalled()
    const fetcher = vi.fn(async () => ({ status: 200, json: async () => ({ user_id: '@alice:matrix.invalid' }) }))
    vi.stubGlobal('fetch', fetcher)
    await recovery.recover()
    expect(fetcher.mock.calls).toHaveLength(1)
    // Compare header locally without logging real session material.
    expect((fetcher.mock.calls as unknown as [string, RequestInit][])[0]![1].headers)
      .toEqual({ Authorization: 'Bearer test-token-after' })
    expect(h.enable.mock.calls).toEqual([[true]])
  })

  it('disposal aborts an outstanding probe and cannot resume a queue', async () => {
    const h = harness()
    await h.install()
    h.fail()
    let signal!: AbortSignal
    let resolve!: (value: { status: number; json: () => Promise<{ user_id: string }> }) => void
    vi.stubGlobal('fetch', (_url: string, options: RequestInit) => {
      signal = options.signal!
      return new Promise(done => { resolve = done })
    })
    const pending = h.internals.queueRecoveries.get('a')!.recover()
    await h.engine.dispose()
    expect(signal.aborted).toBe(true)
    expect(h.cancel).toHaveBeenCalledOnce()
    resolve({ status: 200, json: async () => ({ user_id: '@alice:matrix.invalid' }) })
    await pending
    expect(h.enable).not.toHaveBeenCalled()
    expect(h.internals.queueRecoveries.size).toBe(0)
  })

  it('a tombstoned or replaced attachment cannot resume from a late successful probe', async () => {
    const h = harness()
    await h.install()
    h.fail()
    let resolve!: (value: { status: number; json: () => Promise<{ user_id: string }> }) => void
    vi.stubGlobal('fetch', () => new Promise(done => { resolve = done }))
    const pending = h.internals.queueRecoveries.get('a')!.recover()
    h.stale()
    resolve({ status: 200, json: async () => ({ user_id: '@alice:matrix.invalid' }) })
    await pending
    expect(h.enable).not.toHaveBeenCalled()
  })

  it('a fresh attachment can recover after the previous attachment rejected authentication', async () => {
    const h = harness()
    await h.install()
    h.fail()
    vi.stubGlobal('fetch', async () => ({ status: 401 }))
    await h.internals.queueRecoveries.get('a')!.recover()
    expect(h.accounts).toHaveBeenCalledWith(expect.objectContaining({ connection: 'error' }))
    vi.stubGlobal('fetch', async () => ({ status: 200, json: async () => ({ user_id: '@alice:matrix.invalid' }) }))
    await h.internals.queueRecoveries.get('a')!.recover()
    expect(h.enable).not.toHaveBeenCalled()
    await h.install()
    h.fail()
    await h.internals.queueRecoveries.get('a')!.recover()
    expect(h.enable).toHaveBeenCalledOnce()
  })
  it('retryConnection preserves an authenticated rejection instead of announcing online', async () => {
    const h = harness()
    await h.install()
    h.fail()
    const fetcher = vi.fn(async (url: string) => url.endsWith('/versions')
      ? { ok: true, status: 200 } : { ok: false, status: 401 })
    vi.stubGlobal('fetch', fetcher)
    await h.engine.retryConnection('a')
    expect(h.accounts.mock.calls.at(-1)?.[0]).toMatchObject({ connection: 'error', error: 'Session expired. Sign in again.' })
    expect(h.enable).not.toHaveBeenCalled()
    const requests = fetcher.mock.calls.length
    await h.engine.retryConnection('a')
    expect(fetcher.mock.calls.length).toBe(requests)
    const offline = vi.fn(async () => { throw new Error('network failed after authentication rejection') })
    vi.stubGlobal('fetch', offline)
    for (let index = 0; index < 3; index++) {
      await h.internals.pingServer('a')
      h.internals.noteRefreshFailure('a', new Error('late network failure'))
    }
    h.internals.noteRefreshSuccess('a')
    await h.internals.checkSessionAlive('a', h.account, 4)
    expect(offline).not.toHaveBeenCalled()
    expect(h.accounts.mock.calls.at(-1)?.[0]).toMatchObject({ connection: 'error' })
    expect(h.accounts.mock.calls.some(([value]) => value.connection === 'online')).toBe(false)
  })

  it('authenticated probe failures feed the existing polling backoff, then recover', async () => {
    const h = harness()
    await h.install()
    h.fail()
    vi.stubGlobal('fetch', async (url: string) => url.endsWith('/versions')
      ? { ok: true, status: 200 } : { ok: false, status: 503 })
    for (let index = 0; index < 3; index++) await h.internals.pingServer('a')
    expect(h.internals.refreshFailures.get('a')).toBe(3)
    expect(h.accounts.mock.calls.at(-1)?.[0]).toMatchObject({ connection: 'offline' })
    expect(h.enable).not.toHaveBeenCalled()
    vi.stubGlobal('fetch', async (url: string) => url.endsWith('/versions')
      ? { ok: true, status: 200 } : { ok: true, status: 200, json: async () => ({ user_id: '@alice:matrix.invalid' }) })
    await h.internals.pingServer('a')
    expect(h.internals.refreshFailures.get('a')).toBe(0)
    expect(h.accounts.mock.calls.at(-1)?.[0]).toMatchObject({ connection: 'online' })
    expect(h.enable).toHaveBeenCalledOnce()
  })

  it('cancels a subscription that finishes installing after its attachment becomes stale', async () => {
    const h = harness()
    let resolve!: (value: TaskHandleInterface) => void
    h.client.subscribeToSendQueueUpdates = () => new Promise(done => { resolve = done })
    const pending = h.install()
    h.stale()
    resolve({ cancel: h.cancel } as unknown as TaskHandleInterface)
    await expect(pending).resolves.toBe(false)
    expect(h.cancel).toHaveBeenCalledOnce()
    expect(h.handles).toHaveLength(0)
    expect(h.internals.queueRecoveries.size).toBe(0)
  })

  it('does not announce online if authentication is rejected during the awaited room refresh', async () => {
    const h = harness()
    await h.install()
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200 }))
    let release!: () => void, started!: () => void
    const refreshing = new Promise<void>(resolve => { started = resolve })
    const pendingRefresh = new Promise<void>(resolve => { release = resolve })
    h.internals.refreshRooms = async () => { started(); await pendingRefresh }
    const pending = h.engine.retryConnection('a')
    await refreshing
    h.internals.queueRecoveries.get('a')!.rejectAuth()
    release()
    await pending
    expect(h.accounts.mock.calls.some(([value]) => value.connection === 'online')).toBe(false)
  })

})
