import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { state, engine, retireDemo, seedDemo, signOut, removeAccount, deactivateAccount } from '../src/store'
import type { Account } from '../src/types'

const real = (id: string): Account => ({ id, name: id, userId: '@' + id + ':example.org', color: '#477962', connection: 'online' })

describe('real-account exits never enter the tour', () => {
  beforeEach(() => {
    // Keep this enabled: account exits must be safe even in a tour build.
    vi.stubEnv('VITE_FERN_DEMO', '1')
    state.accounts = [real('real-a'), real('real-b')]
    state.rooms = []
    state.messages = {}
    state.activeAccountId = 'real-a'
    state.activeRoomId = ''
    state.lastRoom = {}
    state.thread = undefined
    vi.spyOn(engine, 'logout').mockResolvedValue({ serverRevoked: true })
    vi.spyOn(engine, 'removeAccount').mockResolvedValue(undefined)
    vi.spyOn(engine, 'deactivate').mockResolvedValue(undefined)
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

  it('signs out to the remaining real account', async () => {
    await signOut()
    expect(engine.logout).toHaveBeenCalledWith('real-a')
    expect(state.activeAccountId).toBe('real-b')
    expect(state.accounts.map(item => item.id)).toEqual(['real-b'])
  })

  it('removes the active account without introducing demo fixtures', async () => {
    await removeAccount('real-a')
    expect(state.activeAccountId).toBe('real-b')
    expect(state.accounts.map(item => item.id)).toEqual(['real-b'])
  })

  it('keeps the current account when a different one is removed', async () => {
    state.activeRoomId = '!selected:example.org'
    state.filter = 'unread'
    state.spaceId = '!space:example.org'
    state.details = true
    state.thread = { accountId: 'real-a', roomId: '!selected:example.org', rootId: '$root', root: undefined, messages: [], end: true, loading: false }
    await removeAccount('real-b')
    expect(state.activeAccountId).toBe('real-a')
    expect(state.activeRoomId).toBe('!selected:example.org')
    expect(state.filter).toBe('unread')
    expect(state.spaceId).toBe('!space:example.org')
    expect(state.details).toBe(true)
    expect(state.thread?.rootId).toBe('$root')
    expect(state.accounts.map(item => item.id)).toEqual(['real-a'])
  })

  it.each(['signOut', 'remove', 'deactivate'] as const)('returns to the gate after last-account %s', async action => {
    state.accounts = [real('real-a')]
    if (action === 'signOut') await signOut()
    else if (action === 'remove') await removeAccount('real-a')
    else await deactivateAccount('test-only-password', false)
    expect(state.accounts).toEqual([])
    expect(state.activeAccountId).toBe('')
    expect(state.activeRoomId).toBe('')
  })

  it('deactivation selects a remaining real account', async () => {
    await deactivateAccount('test-only-password', false)
    expect(state.activeAccountId).toBe('real-b')
    expect(state.accounts.map(item => item.id)).toEqual(['real-b'])
  })

  it('leaves the account selected when removal fails', async () => {
    vi.mocked(engine.removeAccount).mockRejectedValue(new Error('Removal failed'))
    await removeAccount('real-a')
    expect(state.activeAccountId).toBe('real-a')
    expect(state.accounts.map(item => item.id)).toEqual(['real-a', 'real-b'])
    expect(state.error).toBe('Removal failed')
  })

  it('retires every demo identity and reseeds idempotently only when asked', () => {
    seedDemo()
    retireDemo()
    expect(state.accounts.map(item => item.id)).toEqual(['real-a', 'real-b'])
    expect(state.rooms.some(item => item.accountId.startsWith('demo-'))).toBe(false)
    seedDemo()
    seedDemo()
    expect(state.accounts.filter(item => item.connection === 'demo').map(item => item.id).sort()).toEqual(['demo-home', 'demo-work'])
  })

  it('does not confuse the second demo account with a real session', () => {
    state.accounts = []
    seedDemo()
    state.activeAccountId = 'demo-work'
    retireDemo()
    expect(state.accounts.filter(item => item.connection === 'demo')).toHaveLength(2)
  })
})
