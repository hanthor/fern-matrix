import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appLocked, captureRoomNavigation, clearFocus, engine, focused, focusMessage, goToSuccessor, selectRoom, state } from '../src/store'
import type { Account, Message, Room } from '../src/types'

const account = (id: string): Account => ({ id, name: id, userId: '@' + id + ':example.org', color: '#477962', connection: 'online' })
const room = (id: string, accountId = 'a'): Room => ({ id, accountId, name: id, topic: '', direct: false, space: false, encrypted: true, favorite: false, unread: 0, mentions: 0, members: 2, preview: '', timestamp: 0, membership: 'joined' })
const message = (id: string): Message => ({ id, sender: '@sender:example.org', name: 'Sender', body: id, timestamp: 1, own: false, kind: 'text', reactions: [] })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

beforeEach(() => {
  clearFocus()
  appLocked.value = false
  state.accounts = [account('a'), account('b')]
  state.rooms = [room('old'), room('other'), room('old', 'b')]
  state.messages = {}
  state.activeAccountId = 'a'
  state.activeRoomId = 'old'
  state.lastRoom = {}
  state.error = ''
  vi.spyOn(engine, 'watchRoom').mockResolvedValue(vi.fn())
  vi.spyOn(engine, 'markRead').mockResolvedValue(undefined)
  vi.spyOn(engine, 'members').mockResolvedValue([])
  vi.spyOn(engine, 'ignoredUsers').mockResolvedValue([])
  vi.spyOn(engine, 'pollModPower').mockResolvedValue(false)
})
afterEach(() => { clearFocus(); vi.restoreAllMocks() })

describe('focused context owns its account, room and lifetime', () => {
  it('retains the initial snapshot delivered before subscription setup resolves', async () => {
    const pending = deferred<() => void>()
    vi.spyOn(engine, 'focusEvent').mockImplementation((_account, _room, _event, update) => {
      update([message('event')])
      return pending.promise
    })
    const request = focusMessage('old', 'event')
    expect(focused.value?.messages.map(value => value.id)).toEqual(['event'])
    pending.resolve(vi.fn())
    expect(await request).toBe(true)
    expect(focused.value).toMatchObject({ accountId: 'a', roomId: 'old', eventId: 'event' })
    expect(focused.value?.messages.map(value => value.id)).toEqual(['event'])
  })

  it('cancels a late A handle without replacing B or losing B cancellation', async () => {
    const a = deferred<() => void>()
    const b = deferred<() => void>()
    const stopA = vi.fn(), stopB = vi.fn()
    const callbacks: Array<(messages: Message[]) => void> = []
    vi.spyOn(engine, 'focusEvent').mockImplementation((_account, _room, event, update) => {
      callbacks.push(update)
      return event === 'A' ? a.promise : b.promise
    })
    const first = focusMessage('old', 'A')
    const second = focusMessage('old', 'B')
    b.resolve(stopB)
    expect(await second).toBe(true)
    callbacks[1]([message('B')])
    a.resolve(stopA)
    expect(await first).toBe(false)
    callbacks[0]([message('A')])
    expect(focused.value?.eventId).toBe('B')
    expect(focused.value?.messages.map(value => value.id)).toEqual(['B'])
    expect(stopA).toHaveBeenCalledTimes(1)
    clearFocus()
    clearFocus()
    expect(stopB).toHaveBeenCalledTimes(1)
  })

  it.each(['clear', 'room', 'account', 'lock'] as const)('does not resurrect after %s', async change => {
    const pending = deferred<() => void>()
    const stop = vi.fn()
    vi.spyOn(engine, 'focusEvent').mockReturnValue(pending.promise)
    const request = focusMessage('old', 'event')
    if (change === 'clear') clearFocus()
    if (change === 'room') state.activeRoomId = 'other'
    if (change === 'account') state.activeAccountId = 'b'
    if (change === 'lock') appLocked.value = true
    expect(focused.value).toBeUndefined()
    pending.resolve(stop)
    expect(await request).toBe(false)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(focused.value).toBeUndefined()
  })

  it('does not mix the same room/event across accounts', async () => {
    const updates: Array<(messages: Message[]) => void> = []
    vi.spyOn(engine, 'focusEvent').mockImplementation(async (_account, _room, _event, update) => {
      updates.push(update)
      return vi.fn()
    })
    await focusMessage('old', 'same')
    state.activeAccountId = 'b'
    await focusMessage('old', 'same')
    updates[1]([message('from-b')])
    updates[0]([message('from-a')])
    expect(focused.value?.accountId).toBe('b')
    expect(focused.value?.messages[0].id).toBe('from-b')
  })

  it('ignores stale rejection but reports a current failure and returns to live', async () => {
    const pending = deferred<() => void>()
    vi.spyOn(engine, 'focusEvent').mockReturnValueOnce(pending.promise).mockResolvedValue(vi.fn())
    const first = focusMessage('old', 'A')
    await focusMessage('old', 'B')
    pending.reject(new Error('stale failure'))
    expect(await first).toBe(false)
    expect(focused.value?.eventId).toBe('B')
    vi.mocked(engine.focusEvent).mockRejectedValueOnce(new Error('current failure'))
    await expect(focusMessage('old', 'C')).rejects.toThrow('current failure')
    expect(focused.value).toBeUndefined()
  })

  it('refuses a mismatched room or locked view without starting an SDK focus', async () => {
    const focus = vi.spyOn(engine, 'focusEvent')
    expect(await focusMessage('other', 'event')).toBe(false)
    appLocked.value = true
    expect(await focusMessage('old', 'event')).toBe(false)
    expect(focus).not.toHaveBeenCalled()
  })

  it('invalidates a navigation lease after leaving and returning or reselecting', async () => {
    const owns = captureRoomNavigation()
    state.activeRoomId = 'other'
    state.activeRoomId = 'old'
    expect(owns()).toBe(false)
    const reselected = captureRoomNavigation()
    await selectRoom(state.rooms[0])
    expect(reselected()).toBe(false)
  })
})

describe('replacement room continuation', () => {
  beforeEach(() => { state.rooms[0].successor = 'next' })

  it('selects an already joined successor without another join', async () => {
    state.rooms.push(room('next'))
    const join = vi.spyOn(engine, 'join')
    expect(await goToSuccessor()).toBe(true)
    expect(state.activeRoomId).toBe('next')
    expect(join).not.toHaveBeenCalled()
  })

  it('joins once, then selects the replacement in the captured account', async () => {
    const pending = deferred<string>()
    const join = vi.spyOn(engine, 'join').mockReturnValue(pending.promise)
    const first = goToSuccessor()
    expect(await goToSuccessor()).toBe(false)
    state.rooms.push(room('next'))
    pending.resolve('next')
    expect(await first).toBe(true)
    expect(join).toHaveBeenCalledExactlyOnceWith('a', 'next')
    expect(state.activeAccountId).toBe('a')
    expect(state.activeRoomId).toBe('next')
    expect(state.rooms.some(value => value.id === 'old' && value.accountId === 'a')).toBe(true)
  })

  it.each(['account', 'room', 'leave-and-return', 'lock'] as const)('does not steal navigation after %s while joining', async change => {
    const pending = deferred<string>()
    vi.spyOn(engine, 'join').mockReturnValue(pending.promise)
    const request = goToSuccessor()
    if (change === 'account') state.activeAccountId = 'b'
    if (change === 'room') state.activeRoomId = 'other'
    if (change === 'leave-and-return') { state.activeRoomId = 'other'; state.activeRoomId = 'old' }
    if (change === 'lock') appLocked.value = true
    const selected = state.activeRoomId
    state.rooms.push(room('next'))
    pending.resolve('next')
    expect(await request).toBe(false)
    expect(state.activeRoomId).toBe(selected)
    expect(engine.watchRoom).not.toHaveBeenCalled()
  })

  it('does not claim ready when the selected replacement watch fails', async () => {
    state.rooms.push(room('next'))
    vi.mocked(engine.watchRoom).mockRejectedValueOnce(new Error('replacement watch failed'))
    expect(await goToSuccessor()).toBe(false)
    // The target was selected, but its load failed; keep the actionable error.
    expect(state.activeRoomId).toBe('next')
    expect(state.error).toBe('replacement watch failed')
    expect(state.loading).toBe(false)
  })

  it('keeps the old room and reports a current join failure', async () => {
    vi.spyOn(engine, 'join').mockRejectedValue(new Error('join refused'))
    expect(await goToSuccessor()).toBe(false)
    expect(state.activeRoomId).toBe('old')
    expect(state.error).toBe('join refused')
  })

  it('does not report successful continuation when the refreshed room is missing', async () => {
    vi.spyOn(engine, 'join').mockResolvedValue('next')
    expect(await goToSuccessor()).toBe(false)
    expect(state.activeRoomId).toBe('old')
    expect(state.error).toContain('not available yet')
  })

  it('suppresses a join error belonging to an abandoned view', async () => {
    const pending = deferred<string>()
    vi.spyOn(engine, 'join').mockReturnValue(pending.promise)
    const request = goToSuccessor()
    state.activeRoomId = 'other'
    state.error = 'current view error'
    pending.reject(new Error('stale join failure'))
    expect(await request).toBe(false)
    expect(state.error).toBe('current view error')
  })
})

describe('room selection error ownership', () => {
  it.each(['room', 'account'] as const)('does not publish a stale watch rejection after newer %s selection', async change => {
    const pending = deferred<() => void>()
    vi.mocked(engine.watchRoom).mockReturnValueOnce(pending.promise)
    const old = selectRoom(state.rooms[0])
    const target = change === 'room' ? state.rooms[1] : state.rooms[2]
    if (change === 'account') state.activeAccountId = 'b'
    expect(await selectRoom(target)).toBe(true)
    state.error = 'current view error'
    pending.reject(new Error('old watch failed'))
    expect(await old).toBe(false)
    expect(state.error).toBe('current view error')
    expect(state.activeRoomId).toBe(target.id)
    expect(state.loading).toBe(false)
  })

  it('reports current watch failure and does not claim ready', async () => {
    vi.mocked(engine.watchRoom).mockRejectedValueOnce(new Error('watch failed'))
    expect(await selectRoom(state.rooms[0])).toBe(false)
    expect(state.error).toBe('watch failed')
    expect(state.loading).toBe(false)
  })

  it('ignores a detached poll-power rejection from a former room', async () => {
    const pending = deferred<boolean>()
    vi.mocked(engine.pollModPower).mockReturnValueOnce(pending.promise)
    expect(await selectRoom(state.rooms[0])).toBe(true)
    expect(await selectRoom(state.rooms[1])).toBe(true)
    state.error = 'current view error'
    pending.reject(new Error('old power failed'))
    await Promise.resolve()
    expect(state.error).toBe('current view error')
  })
})
