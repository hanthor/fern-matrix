import { describe, expect, it } from 'vitest'
import { accountName, accountRooms, filteredRooms, inboxRooms, state, totalUnread } from '../src/store'

// Unified inbox: per-account list by default, all accounts merged
// newest-first when enabled. Reads demo fixtures only (no selectRoom, so the
// fixture unread counts stay intact for the assertions below).
describe('unified inbox', () => {
  it('lists only the active account by default', () => {
    expect(state.inboxAll).toBe(false)
    expect(inboxRooms.value.map(item => item.accountId)).toEqual(
      accountRooms.value.map(item => item.accountId),
    )
    expect(inboxRooms.value.every(item => item.accountId === 'demo-home')).toBe(true)
  })

  it('merges every account newest-first when enabled', () => {
    state.inboxAll = true
    try {
      const rooms = inboxRooms.value
      expect(new Set(rooms.map(item => item.accountId))).toEqual(new Set(['demo-home', 'demo-work']))
      expect(rooms.some(item => item.space)).toBe(false)
      for (let index = 1; index < rooms.length; index += 1) {
        expect(rooms[index - 1].timestamp).toBeGreaterThanOrEqual(rooms[index].timestamp)
      }
      expect(filteredRooms.value.length).toBeGreaterThan(accountRooms.value.length)
    } finally {
      state.inboxAll = false
    }
  })

  it('scopes the unread badge to the visible inbox', () => {
    expect(totalUnread).toBeDefined()
    const perAccount = totalUnread.value
    expect(perAccount).toBe(6)
    state.inboxAll = true
    try {
      expect(totalUnread.value).toBe(10)
    } finally {
      state.inboxAll = false
    }
    expect(totalUnread.value).toBe(perAccount)
  })

  it('resolves account names for room rows', () => {
    expect(accountName('demo-home')).toBe('Alex Morgan')
    expect(accountName('demo-work')).toBe('Alex · Work')
    expect(accountName('missing')).toBe('')
  })
})
