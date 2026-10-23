import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { engine, removeAccount, signOut, state, switchAccount, retryPendingCleanup, deactivateAccount } from '../src/store'

const { removing } = vi.hoisted(() => ({ removing: new Set<string>() }))
vi.mock('../src/session-storage', async importOriginal => ({
  ...await importOriginal<typeof import('../src/session-storage')>(),
  isSessionRemoving: (id: string) => removing.has(id),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
beforeEach(() => {
  removing.clear(); state.pendingCleanups = []; state.error = ''
  state.accounts = [
    { id: 'a', userId: '@same:example.org', name: 'First', color: '#477962', connection: 'online' },
    { id: 'b', userId: '@same:example.org', name: 'Second', color: '#477962', connection: 'online' },
  ]
  state.rooms = []; state.messages = {}; state.activeAccountId = 'a'; state.activeRoomId = ''
})
afterEach(() => vi.restoreAllMocks())

describe('captured session exit operations', () => {
  it('exits A while preserving a later switch to B', async () => {
    const pending = deferred<{ status: 'complete'; serverRevoked: boolean }>()
    const logout = vi.spyOn(engine, 'logout').mockReturnValue(pending.promise)
    const result = signOut('a')
    switchAccount('b')
    pending.resolve({ status: 'complete', serverRevoked: true })
    expect(await result).toMatchObject({ status: 'complete' })
    expect(logout).toHaveBeenCalledWith('a')
    expect(state.accounts.map(value => value.id)).toEqual(['b'])
    expect(state.activeAccountId).toBe('b')
  })
  it('serializes removal and signout for the same session', async () => {
    const pending = deferred<{ status: 'complete'; serverRevoked: boolean }>()
    const logout = vi.spyOn(engine, 'logout').mockReturnValue(pending.promise)
    const remove = vi.spyOn(engine, 'removeAccount').mockResolvedValue({ status: 'complete' })
    const first = signOut('a')
    expect(await signOut('a')).toMatchObject({ status: 'error' })
    expect(await removeAccount('a')).toMatchObject({ status: 'error' })
    expect(logout).toHaveBeenCalledTimes(1)
    expect(remove).not.toHaveBeenCalled()
    pending.resolve({ status: 'complete', serverRevoked: false })
    expect(await first).toMatchObject({ status: 'complete' })
  })
  it('removes only the requested local session without server logout', async () => {
    const remove = vi.spyOn(engine, 'removeAccount').mockResolvedValue({ status: 'complete' })
    const logout = vi.spyOn(engine, 'logout')
    expect(await removeAccount('b')).toMatchObject({ status: 'complete' })
    expect(remove).toHaveBeenCalledWith('b')
    expect(logout).not.toHaveBeenCalled()
    expect(state.activeAccountId).toBe('a')
    expect(state.accounts.map(value => value.id)).toEqual(['a'])
  })
  it('preserves an account and releases the guard when local cleanup rejects', async () => {
    const remove = vi.spyOn(engine, 'removeAccount').mockRejectedValueOnce(new Error('storage failed')).mockResolvedValue({ status: 'complete' })
    expect(await removeAccount('a')).toMatchObject({ status: 'error' })
    expect(state.accounts.some(value => value.id === 'a')).toBe(true)
    expect(await removeAccount('a')).toMatchObject({ status: 'complete' })
    expect(remove).toHaveBeenCalledTimes(2)
  })
  it('does not act on an absent or demo account', async () => {
    const logout = vi.spyOn(engine, 'logout')
    const remove = vi.spyOn(engine, 'removeAccount')
    state.accounts[0]!.connection = 'demo'
    expect(await signOut('a')).toMatchObject({ status: 'error' })
    expect(await removeAccount('a')).toMatchObject({ status: 'error' })
    expect(await signOut('missing')).toMatchObject({ status: 'error' })
    expect(await removeAccount('missing')).toMatchObject({ status: 'error' })
    expect(logout).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })
})

describe('two-phase cleanup outcomes', () => {
  it('keeps database-only cleanup pending without treating it as complete', async () => {
    vi.spyOn(engine, 'logout').mockResolvedValue({ status: 'restart-required', serverRevoked: false })
    switchAccount('b')
    expect(await signOut('a')).toEqual({ status: 'restart-required', serverRevoked: false })
    expect(state.pendingCleanups).toMatchObject([{ account: { id: 'a' }, status: 'restart-required', serverRevoked: false }])
    expect(state.accounts.map(item => item.id)).toEqual(['b'])
    expect(state.activeAccountId).toBe('b')
  })
  it('quarantines a cleanup error and retries only local removal after server logout', async () => {
    const logout = vi.spyOn(engine, 'logout').mockImplementation(async () => {
      removing.add('a')
      throw new Error('unsafe details must not be shown')
    })
    const remove = vi.spyOn(engine, 'removeAccount').mockResolvedValue({ status: 'restart-required' })
    expect(await signOut('a')).toEqual({ status: 'error', cleanupStarted: true })
    expect(state.error).not.toContain('unsafe details')
    expect(state.accounts.map(item => item.id)).toEqual(['b'])
    expect(state.pendingCleanups[0]?.status).toBe('error')
    expect(await signOut('a')).toMatchObject({ status: 'error' })
    expect(await retryPendingCleanup('a')).toEqual({ status: 'restart-required' })
    expect(remove).toHaveBeenCalledWith('a')
    expect(logout).toHaveBeenCalledTimes(1)
    expect(state.pendingCleanups[0]?.status).toBe('restart-required')
  })
  it('does not repeat remote deactivation after a local cleanup failure', async () => {
    const deactivate = vi.spyOn(engine, 'deactivate').mockImplementation(async () => {
      removing.add('a'); throw new Error('cleanup failed')
    })
    const remove = vi.spyOn(engine, 'removeAccount').mockResolvedValue({ status: 'complete' })
    expect(await deactivateAccount('password', true)).toEqual({ status: 'error', cleanupStarted: true })
    expect(await retryPendingCleanup('a')).toEqual({ status: 'complete' })
    expect(deactivate).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith('a')
    expect(state.pendingCleanups).toEqual([])
    expect(state.activeAccountId).toBe('b')
  })
  it('preserves the account for a rejected pre-cleanup deactivation', async () => {
    vi.spyOn(engine, 'deactivate').mockRejectedValue(new Error('auth failed'))
    expect(await deactivateAccount('incorrect', true)).toEqual({ status: 'error', cleanupStarted: false })
    expect(state.accounts.map(item => item.id)).toEqual(['a', 'b'])
    expect(state.pendingCleanups).toEqual([])
  })
  it('serializes local retries and retains error state until confirmed completion', async () => {
    removing.add('a')
    vi.spyOn(engine, 'logout').mockRejectedValue(new Error('storage failed'))
    await signOut('a')
    const pending = deferred<{ status: 'complete' }>()
    const remove = vi.spyOn(engine, 'removeAccount').mockReturnValue(pending.promise)
    const first = retryPendingCleanup('a')
    expect(await retryPendingCleanup('a')).toMatchObject({ status: 'error' })
    expect(remove).toHaveBeenCalledTimes(1)
    pending.resolve({ status: 'complete' }); await first
    expect(state.pendingCleanups).toEqual([])
  })
})
