import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account } from '../src/types'

const restoredAccount = (id: string): Account => ({ id, name: id, userId: '@' + id + ':example.org', color: '#477962', connection: 'online' })

describe('restored session entry', () => {
  beforeEach(() => { vi.resetModules(); vi.stubEnv('VITE_FERN_DEMO', '0') })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

  it('selects the restored account from the default empty gate', async () => {
    const store = await import('../src/store')
    expect(store.state.accounts).toEqual([])
    vi.spyOn(store.engine, 'restoreAll').mockImplementation(async () => {
      store.state.accounts.push(restoredAccount('saved'))
    })
    await store.initialize()
    expect(store.state.activeAccountId).toBe('saved')
    expect(store.state.accounts.map(item => item.id)).toEqual(['saved'])
  })

  it('replaces every tour identity when real sessions restore', async () => {
    const store = await import('../src/store')
    store.seedDemo()
    store.switchAccount('demo-home')
    vi.spyOn(store.engine, 'restoreAll').mockImplementation(async () => {
      store.state.accounts.push(restoredAccount('saved'))
    })
    await store.initialize()
    expect(store.state.activeAccountId).toBe('saved')
    expect(store.state.accounts.map(item => item.id)).toEqual(['saved'])
    expect(store.state.rooms.some(item => item.accountId.startsWith('demo-'))).toBe(false)
  })

  it('preserves an already selected real account', async () => {
    const store = await import('../src/store')
    store.state.accounts = [restoredAccount('first'), restoredAccount('selected')]
    store.switchAccount('selected')
    vi.spyOn(store.engine, 'restoreAll').mockResolvedValue(undefined)
    await store.initialize()
    expect(store.state.activeAccountId).toBe('selected')
  })

  it('preserves a selection made while restoration is still pending', async () => {
    const store = await import('../src/store')
    store.state.accounts = [restoredAccount('first'), restoredAccount('later-choice')]
    let finish!: () => void
    vi.spyOn(store.engine, 'restoreAll').mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    const restoring = store.initialize()
    store.switchAccount('later-choice')
    finish()
    await restoring
    expect(store.state.activeAccountId).toBe('later-choice')
  })

  it('retains a failed restored account and its actionable error', async () => {
    const store = await import('../src/store')
    vi.spyOn(store.engine, 'restoreAll').mockImplementation(async () => {
      store.state.accounts.push({ ...restoredAccount('expired'), connection: 'error', error: 'Sign in again' })
    })
    await store.initialize()
    expect(store.state.activeAccountId).toBe('expired')
    expect(store.state.error).toBe('Sign in again')
    expect(store.state.accounts[0].connection).toBe('error')
  })

  it('keeps the gate and error when restoration itself fails', async () => {
    const store = await import('../src/store')
    vi.spyOn(store.engine, 'restoreAll').mockRejectedValue(new Error('Storage unavailable'))
    await store.initialize()
    expect(store.state.accounts).toEqual([])
    expect(store.state.activeAccountId).toBe('')
    expect(store.state.error).toBe('Storage unavailable')
  })
})
