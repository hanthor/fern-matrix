import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { engine, removeAccount, signOut, state, switchAccount } from '../src/store'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
beforeEach(() => {
  state.accounts = [
    { id: 'a', userId: '@same:example.org', name: 'First', color: '#477962', connection: 'online' },
    { id: 'b', userId: '@same:example.org', name: 'Second', color: '#477962', connection: 'online' },
  ]
  state.rooms = []; state.messages = {}; state.activeAccountId = 'a'; state.activeRoomId = ''
})
afterEach(() => vi.restoreAllMocks())

describe('captured session exit operations', () => {
  it('exits A while preserving a later switch to B', async () => {
    const pending = deferred<{ serverRevoked: boolean }>()
    const logout = vi.spyOn(engine, 'logout').mockReturnValue(pending.promise)
    const result = signOut('a')
    switchAccount('b')
    pending.resolve({ serverRevoked: true })
    expect(await result).toBe(true)
    expect(logout).toHaveBeenCalledWith('a')
    expect(state.accounts.map(value => value.id)).toEqual(['b'])
    expect(state.activeAccountId).toBe('b')
  })
  it('serializes removal and signout for the same session', async () => {
    const pending = deferred<{ serverRevoked: boolean }>()
    const logout = vi.spyOn(engine, 'logout').mockReturnValue(pending.promise)
    const remove = vi.spyOn(engine, 'removeAccount').mockResolvedValue()
    const first = signOut('a')
    expect(await signOut('a')).toBe(false)
    expect(await removeAccount('a')).toBe(false)
    expect(logout).toHaveBeenCalledTimes(1)
    expect(remove).not.toHaveBeenCalled()
    pending.resolve({ serverRevoked: false })
    expect(await first).toBe(true)
  })
  it('removes only the requested local session without server logout', async () => {
    const remove = vi.spyOn(engine, 'removeAccount').mockResolvedValue()
    const logout = vi.spyOn(engine, 'logout')
    expect(await removeAccount('b')).toBe(true)
    expect(remove).toHaveBeenCalledWith('b')
    expect(logout).not.toHaveBeenCalled()
    expect(state.activeAccountId).toBe('a')
    expect(state.accounts.map(value => value.id)).toEqual(['a'])
  })
  it('preserves an account and releases the guard when local cleanup rejects', async () => {
    const remove = vi.spyOn(engine, 'removeAccount').mockRejectedValueOnce(new Error('storage failed')).mockResolvedValue()
    expect(await removeAccount('a')).toBe(false)
    expect(state.accounts.some(value => value.id === 'a')).toBe(true)
    expect(await removeAccount('a')).toBe(true)
    expect(remove).toHaveBeenCalledTimes(2)
  })
  it('does not act on an absent or demo account', async () => {
    const logout = vi.spyOn(engine, 'logout')
    const remove = vi.spyOn(engine, 'removeAccount')
    state.accounts[0]!.connection = 'demo'
    expect(await signOut('a')).toBe(false)
    expect(await removeAccount('a')).toBe(false)
    expect(await signOut('missing')).toBe(false)
    expect(await removeAccount('missing')).toBe(false)
    expect(logout).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })
})
