import { describe, expect, it } from 'vitest'
import { state, messages, visibleMessages, ignoredUsersState, shouldNotify, browserNotify } from '../src/store'
import type { Message, Room } from '../src/types'

const room = (id: string): Room => ({ id, accountId: 'demo-home', name: id, topic: '', direct: false,
  space: false, encrypted: true, favorite: false, unread: 0, mentions: 0, members: 2, preview: '',
  timestamp: 0, membership: 'joined' })
const message = (id: string, sender: string): Message => ({ id, sender, name: sender, body: 'hi',
  timestamp: 0, own: false, kind: 'text', reactions: [] })

describe('ignore filtering', () => {
  it('hides ignored senders from the timeline and notifications', () => {
    const keepRooms = state.rooms
    const keepMessages = state.messages
    state.rooms = [room('general')]
    state.activeRoomId = 'general'
    state.messages = { 'demo-home/general': [message('m1', '@alice:x'), message('m2', '@bob:x')] }
    ignoredUsersState.value = ['@alice:x']
    expect(messages.value.map(item => item.id)).toEqual(['m1', 'm2'])
    expect(visibleMessages.value.map(item => item.id)).toEqual(['m2'])
    browserNotify.value = true
    expect(shouldNotify('demo-home', room('general'), message('m1', '@alice:x'))).toBe(false)
    expect(shouldNotify('demo-home', room('general'), message('m2', '@bob:x'))).toBe(true)
    ignoredUsersState.value = []
    browserNotify.value = false
    expect(visibleMessages.value.map(item => item.id)).toEqual(['m1', 'm2'])
    state.rooms = keepRooms
    state.messages = keepMessages
  })
})
