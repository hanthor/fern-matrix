import { beforeEach, describe, expect, it } from 'vitest'
import { state, browserNotify, quietAccounts, shouldNotify, markNotified, maybeNotify, setAccountQuiet,
  enableBrowserNotify, openNotificationTarget, cacheRoomNotifyMode } from '../src/store'
import type { Message, Room } from '../src/types'

const room = (id: string): Room => ({ id, accountId: 'demo-home', name: id, topic: '', direct: false,
  space: false, encrypted: true, favorite: false, unread: 0, mentions: 0, members: 2, preview: '',
  timestamp: 0, membership: 'joined' })
const message = (id: string, own = false): Message => ({ id, sender: own ? '@me:x' : '@them:x', name: 'Them',
  body: 'hello', timestamp: 0, own, kind: 'text', reactions: [] })

class FakeNotification {
  static permission = 'granted'
  static instances: FakeNotification[] = []
  static async requestPermission() { return FakeNotification.permission }
  onclick: (() => void) | null = null
  constructor(public title: string, public options: Record<string, unknown>) { FakeNotification.instances.push(this) }
}

describe('desktop notification rules', () => {
  beforeEach(() => {
    browserNotify.value = true
    FakeNotification.instances = []
    FakeNotification.permission = 'granted'
    cacheRoomNotifyMode('demo-home', 'general', undefined)
    setAccountQuiet('demo-home', false)
  })

  it('stays silent without the browser toggle, for own messages and twice for one message', () => {
    browserNotify.value = false
    expect(shouldNotify('demo-home', room('general'), message('m1'))).toBe(false)
    browserNotify.value = true
    expect(shouldNotify('demo-home', room('general'), message('m2', true))).toBe(false)
    expect(shouldNotify('demo-home', room('general'), message('m3'))).toBe(true)
    markNotified(message('m3'))
    expect(shouldNotify('demo-home', room('general'), message('m3'))).toBe(false)
  })

  it('suppresses muted rooms and quiet accounts', () => {
    cacheRoomNotifyMode('demo-home', 'general', 'mute')
    expect(shouldNotify('demo-home', room('general'), message('m4'))).toBe(false)
    cacheRoomNotifyMode('demo-home', 'general', undefined)
    setAccountQuiet('demo-home', true)
    expect(quietAccounts.value['demo-home']).toBe(true)
    expect(shouldNotify('demo-home', room('general'), message('m5'))).toBe(false)
    setAccountQuiet('demo-home', false)
    expect(shouldNotify('demo-home', room('general'), message('m5'))).toBe(true)
  })

  it('shows one notification per message and routes clicks to the room', async () => {
    const real = (globalThis as Record<string, unknown>).Notification
    ;(globalThis as Record<string, unknown>).Notification = FakeNotification
    try {
      const leaving = state.activeAccountId
      const leavingRoom = state.activeRoomId
      expect(maybeNotify('demo-home', room('design'), message('m6'))).toBe(true)
      expect(FakeNotification.instances).toHaveLength(1)
      expect(FakeNotification.instances[0].title).toBe('Them')
      // A second arrival of the same message stays silent.
      expect(maybeNotify('demo-home', room('design'), message('m6'))).toBe(false)
      expect(FakeNotification.instances).toHaveLength(1)
      FakeNotification.instances[0].onclick?.()
      await Promise.resolve()
      expect(state.activeRoomId).toBe('design')
      await openNotificationTarget(leaving, state.rooms.find(item => item.id === leavingRoom)?.id ?? leavingRoom)
    } finally {
      if (real === undefined) delete (globalThis as Record<string, unknown>).Notification
      else (globalThis as Record<string, unknown>).Notification = real
      browserNotify.value = false
    }
  })

  it('asks permission once and explains a stored denial', async () => {
    const real = (globalThis as Record<string, unknown>).Notification
    ;(globalThis as Record<string, unknown>).Notification = FakeNotification
    try {
      FakeNotification.permission = 'denied'
      let prompted = false
      FakeNotification.requestPermission = async () => { prompted = true; return 'denied' }
      await enableBrowserNotify(true)
      expect(prompted).toBe(false)
      expect(browserNotify.value).toBe(false)
      expect(state.error).toContain('blocked')
      state.error = ''
    } finally {
      if (real === undefined) delete (globalThis as Record<string, unknown>).Notification
      else (globalThis as Record<string, unknown>).Notification = real
      browserNotify.value = false
    }
  })
})
