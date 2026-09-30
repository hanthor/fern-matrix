import { describe, expect, it } from 'vitest'
import { state, accountRooms, accountUnread, accountMentions, linkRoomAccounts, selectRoom, switchAccount, retireDemo, seedDemo } from '../src/store'

const roomOf = (accountId: string, id: string) => state.rooms.find(item => item.accountId === accountId && item.id === id)!

describe('multi-account switching', () => {
  it('remembers the selected room per account across switches', async () => {
    const design = roomOf('demo-home', 'design')
    const keep = { unread: design.unread, mentions: design.mentions }
    await selectRoom(design)
    switchAccount('demo-work')
    await selectRoom(roomOf('demo-work', 'work-product'))
    expect(state.activeRoomId).toBe('work-product')
    switchAccount('demo-home')
    expect(state.activeRoomId).toBe('design')
    switchAccount('demo-work')
    expect(state.activeRoomId).toBe('work-product')
    switchAccount('demo-home')
    design.unread = keep.unread; design.mentions = keep.mentions
  })

  it('reports unread and mention totals per account', async () => {
    expect(accountUnread('demo-home')).toBe(6)
    expect(accountMentions('demo-home')).toBe(1)
    const work = roomOf('demo-work', 'work-product')
    work.unread = 4; work.mentions = 1
    expect(accountUnread('demo-work')).toBe(4)
    expect(accountMentions('demo-work')).toBe(1)
    switchAccount('demo-work')
    await selectRoom(work)
    expect(work.unread).toBe(0)
    expect(work.mentions).toBe(0)
    expect(accountUnread('demo-work')).toBe(0)
    switchAccount('demo-home')
  })

  it('resolves room links to the accounts that joined them', () => {
    expect(linkRoomAccounts('design').map(account => account.id)).toEqual(['demo-home'])
    expect(linkRoomAccounts('work-general').map(account => account.id)).toEqual(['demo-work'])
    expect(linkRoomAccounts('!unknown:example.org')).toEqual([])
  })

  it('falls back to the first room when the remembered room is gone', async () => {
    switchAccount('demo-work')
    await selectRoom(roomOf('demo-work', 'work-product'))
    switchAccount('demo-home')
    state.rooms = state.rooms.filter(item => !(item.accountId === 'demo-work' && item.id === 'work-product'))
    switchAccount('demo-work')
    await Promise.resolve()
    expect(state.activeAccountId).toBe('demo-work')
    expect(state.activeRoomId).toBe(accountRooms.value.find(item => !item.space && item.membership === 'joined')?.id ?? '')
    switchAccount('demo-home')
    await Promise.resolve()
  })
})

describe('demo retirement', () => {
  it('retires the demo alongside a real account and reseeds it when all leave', async () => {
    expect(state.accounts.some(item => item.id === 'demo-home')).toBe(true)
    state.accounts.push({ id: 'real-1', name: 'Real', userId: '@real:example', color: '#477962', connection: 'online' as const })
    switchAccount('real-1')
    retireDemo()
    expect(state.accounts.some(item => item.id === 'demo-home')).toBe(false)
    expect(state.rooms.some(item => item.accountId === 'demo-home')).toBe(false)
    expect(state.accounts.some(item => item.id === 'real-1')).toBe(true)
    // Leaving the last real account brings the onboarding demo back.
    state.accounts = state.accounts.filter(item => item.id !== 'real-1')
    seedDemo()
    expect(state.accounts.some(item => item.id === 'demo-home')).toBe(true)
    expect(state.rooms.some(item => item.accountId === 'demo-home')).toBe(true)
    switchAccount('demo-home')
    await Promise.resolve()
    expect(state.activeAccountId).toBe('demo-home')
  })
})
