import { describe, expect, it } from 'vitest'
import { state, firstUnreadAnchor, noteFirstUnread, jumpToFirstUnread, selectRoom, messageKey } from '../src/store'
import type { Message } from '../src/types'

// First-unread jump (#41): the anchor derives from the SDK notification
// count at room open, and the pill consumes it through jumpToEvent.
const message = (id: string): Message => ({ id, sender: '@them:x', name: 'Them',
  body: id, timestamp: 0, own: false, kind: 'text', reactions: [] })

describe('firstUnreadAnchor', () => {
  const messages = ['m1', 'm2', 'm3', 'm4', 'm5'].map(message)
  it('lands unread-many messages from the end', () => {
    expect(firstUnreadAnchor(messages, 2)).toEqual({ id: 'm4', count: 2 })
  })
  it('clamps an overlarge count to the oldest loaded message', () => {
    expect(firstUnreadAnchor(messages, 99)).toEqual({ id: 'm1', count: 99 })
  })
  it('returns null without unread or without messages', () => {
    expect(firstUnreadAnchor(messages, 0)).toBeNull()
    expect(firstUnreadAnchor([], 3)).toBeNull()
  })
})

describe('unread pill state', () => {
  it('notes and consumes the anchor', () => {
    const messages = ['m1', 'm2', 'm3'].map(message)
    noteFirstUnread('a/r', messages, 1)
    expect(state.firstUnread['a/r']).toEqual({ id: 'm3', count: 1 })
    expect(jumpToFirstUnread('a/r')).toBe(true)
    expect(state.jumpToEvent).toBe('m3')
    expect(state.firstUnread['a/r']).toBeUndefined()
    state.jumpToEvent = ''
  })

  it('refuses to jump without an anchor', () => {
    expect(jumpToFirstUnread('a/missing')).toBe(false)
  })

  it('selectRoom in the demo anchors from the pending unread count', async () => {
    const room = state.rooms.find(item => item.accountId === 'demo-home' && !item.space)!
    room.unread = 2
    await selectRoom(room)
    const key = messageKey(room.accountId, room.id)
    const loaded = state.messages[key]
    expect(loaded.length).toBeGreaterThan(2)
    expect(state.firstUnread[key]).toEqual({ id: loaded[loaded.length - 2].id, count: 2 })
    expect(room.unread).toBe(0)
  })

  it('selectRoom without unread leaves no anchor', async () => {
    const room = state.rooms.find(item => item.accountId === 'demo-home' && !item.space)!
    room.unread = 0
    await selectRoom(room)
    expect(state.firstUnread[messageKey(room.accountId, room.id)]).toBeUndefined()
  })
})
