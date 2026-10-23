import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/applock', async importOriginal => ({ ...await importOriginal<typeof import('../src/applock')>(), verifyPin: vi.fn(async () => true) }))
import { acknowledgeVisibleRoom, appLocked, clearFocus, engine, focusMessage, roomReadReady, focused, messageKey, lockNow, selectRoom, state, unlockApp } from '../src/store'
import type { Account, Message, Room } from '../src/types'
const message = (id = '$one'): Message => ({ id, sender: '@sender:x', name: 'Sender', body: id, timestamp: 1, own: false, kind: 'text', reactions: [] })
let fixtureNumber = 0
let fixtureAccount = ''
const makeRoom = (): Room => ({ id: '!room:x', accountId: fixtureAccount, name: 'Room', topic: '', direct: false, space: false, encrypted: true, favorite: false, unread: 3, mentions: 1, members: 2, preview: '', timestamp: 0, membership: 'joined' })
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
let update: (messages: Message[]) => void
beforeEach(() => {
  fixtureAccount = `read-fixture-${++fixtureNumber}`
  acknowledgeVisibleRoom(); clearFocus(); appLocked.value = false
  state.activeRoomId = ''
  state.accounts = [{ id: fixtureAccount, name: 'A', userId: '@a:x', color: '#477962', connection: 'online' } as Account]
  state.rooms = [makeRoom()]
  state.activeAccountId = fixtureAccount
  state.messages = {}; state.messageQuery = ''; state.error = ''
  vi.spyOn(engine, 'watchRoom').mockImplementation(async (_account, _room, onMessages) => { update = onMessages; onMessages([message()]); return vi.fn() })
  vi.spyOn(engine, 'markRead').mockResolvedValue(undefined)
  vi.spyOn(engine, 'markEventRead').mockResolvedValue(true)
  vi.spyOn(engine, 'members').mockResolvedValue([])
  vi.spyOn(engine, 'ignoredUsers').mockResolvedValue([])
  vi.spyOn(engine, 'pollModPower').mockResolvedValue(false)
  vi.spyOn(engine, 'warmSecrets').mockResolvedValue(undefined)
  vi.spyOn(engine, 'restoreAll').mockResolvedValue(undefined)
})
afterEach(() => { acknowledgeVisibleRoom(); clearFocus(); vi.restoreAllMocks() })
describe('room read readiness and acknowledgment', () => {
  it('selection alone never acknowledges or clears SDK counters', async () => {
    expect(await selectRoom(state.rooms[0])).toBe(true)
    expect(roomReadReady.value).toBe(true)
    expect(engine.markRead).not.toHaveBeenCalled()
    expect(engine.markEventRead).not.toHaveBeenCalled()
    expect(state.rooms[0].unread).toBe(3)
    acknowledgeVisibleRoom('$one'); await flush()
    expect(engine.markEventRead).toHaveBeenCalledWith(fixtureAccount, '!room:x', '$one', expect.any(AbortSignal))
    expect(state.rooms[0].unread).toBe(3)
  })
  it('requires the handle even when the first snapshot arrives early', async () => {
    const pending = deferred<() => void>()
    vi.mocked(engine.watchRoom).mockImplementation((_a, _r, callback) => { callback([message()]); return pending.promise })
    const selection = selectRoom(state.rooms[0])
    expect(roomReadReady.value).toBe(false)
    acknowledgeVisibleRoom('$one')
    expect(engine.markEventRead).not.toHaveBeenCalled()
    pending.resolve(vi.fn()); await selection
    expect(roomReadReady.value).toBe(true)
  })
  it('requires a snapshot even when the handle is ready first', async () => {
    vi.mocked(engine.watchRoom).mockImplementation(async (_a, _r, callback) => { update = callback; return vi.fn() })
    await selectRoom(state.rooms[0])
    expect(roomReadReady.value).toBe(false)
    update([message()])
    expect(roomReadReady.value).toBe(true)
  })
  it('stale snapshots cannot enable the new room', async () => {
    await selectRoom(state.rooms[0])
    const oldUpdate = update
    state.activeRoomId = '!different:x'
    oldUpdate([message('$old')])
    expect(roomReadReady.value).toBe(false)
    acknowledgeVisibleRoom('$old')
    expect(engine.markEventRead).not.toHaveBeenCalled()
  })
  it('does not clear newer unread counters after an older receipt completes', async () => {
    await selectRoom(state.rooms[0])
    const pending = deferred<boolean>()
    vi.mocked(engine.markEventRead).mockReturnValueOnce(pending.promise)
    acknowledgeVisibleRoom('$one')
    update([message(), message('$two')])
    state.rooms[0].unread = 7; state.rooms[0].mentions = 2
    pending.resolve(true); await flush()
    expect(state.rooms[0].unread).toBe(7)
    expect(state.rooms[0].mentions).toBe(2)
  })
  it.each(['lock', 'filter', 'focus', 'local-echo'] as const)('rejects %s acknowledgment', async block => {
    await selectRoom(state.rooms[0])
    if (block === 'lock') appLocked.value = true
    if (block === 'filter') state.messageQuery = 'filtered'
    if (block === 'focus') {
      vi.spyOn(engine, 'focusEvent').mockResolvedValue(vi.fn())
      await focusMessage('!room:x', '$one')
    }
    if (block === 'local-echo') update([{ ...message('txn'), status: 'sending' }])
    acknowledgeVisibleRoom(block === 'local-echo' ? 'txn' : '$one')
    expect(engine.markEventRead).not.toHaveBeenCalled()
  })
  it('restores accounts when the first unlock has no current room', async () => {
    const restoredAccount = state.accounts[0]
    const restoredRoom = state.rooms[0]
    state.accounts = []; state.rooms = []; state.activeAccountId = ''; state.activeRoomId = ''
    appLocked.value = true
    vi.mocked(engine.restoreAll).mockImplementationOnce(async () => {
      state.accounts = [restoredAccount]; state.rooms = [restoredRoom]
    })
    expect(await unlockApp('test-pin')).toBe(true)
    await flush()
    expect(engine.restoreAll).toHaveBeenCalledOnce()
    expect(state.activeAccountId).toBe(fixtureAccount)
    expect(state.activeRoomId).toBe('!room:x')
    expect(engine.watchRoom).toHaveBeenCalledOnce()
    expect(roomReadReady.value).toBe(true)
  })
  it('leaves the shell locked with an actionable error when warming fails', async () => {
    appLocked.value = true
    vi.mocked(engine.warmSecrets).mockRejectedValueOnce(new Error('Secret storage unavailable'))
    expect(await unlockApp('test-pin')).toBe(false)
    expect(appLocked.value).toBe(true)
    expect(state.error).toBe('Secret storage unavailable')
    expect(engine.watchRoom).not.toHaveBeenCalled()
  })
  it('rearms the existing room after unlock without opening a hidden phone pane or acknowledging', async () => {
    await selectRoom(state.rooms[0])
    state.mobileRoom = false
    appLocked.value = true
    expect(roomReadReady.value).toBe(false)
    expect(await unlockApp('test-pin')).toBe(true)
    expect(roomReadReady.value).toBe(true)
    expect(state.mobileRoom).toBe(false)
    expect(engine.markEventRead).not.toHaveBeenCalled()
    acknowledgeVisibleRoom('$one'); await flush()
    expect(engine.markEventRead).toHaveBeenCalledTimes(1)
  })
  it('rejects a stale same-room snapshot before it changes the current receipt target', async () => {
    await selectRoom(state.rooms[0])
    const oldUpdate = update
    await selectRoom(state.rooms[0])
    update([message('$new-watch')])
    const key = messageKey(fixtureAccount, '!room:x')
    const anchor = state.firstUnread[key]
    oldUpdate([message('$stale-watch')])
    expect(state.messages[key].map(value => value.id)).toEqual(['$new-watch'])
    expect(state.firstUnread[key]).toBe(anchor)
    expect(roomReadReady.value).toBe(true)
    acknowledgeVisibleRoom('$stale-watch'); await flush()
    expect(engine.markEventRead).not.toHaveBeenCalled()
    acknowledgeVisibleRoom('$new-watch'); await flush()
    expect(engine.markEventRead).toHaveBeenCalledWith(fixtureAccount, '!room:x', '$new-watch', expect.any(AbortSignal))
  })
  it('keeps the shell locked until secrets warm and rearms without opening the phone pane', async () => {
    await selectRoom(state.rooms[0])
    state.mobileRoom = false
    appLocked.value = true
    const pending = deferred<void>()
    vi.mocked(engine.warmSecrets).mockReturnValueOnce(pending.promise)
    const unlocked = unlockApp('test-pin')
    await vi.waitFor(() => expect(engine.warmSecrets).toHaveBeenCalled())
    expect(appLocked.value).toBe(true)
    expect(engine.watchRoom).toHaveBeenCalledTimes(1)
    pending.resolve()
    expect(await unlocked).toBe(true)
    expect(roomReadReady.value).toBe(true)
    expect(state.mobileRoom).toBe(false)
    expect(engine.markEventRead).not.toHaveBeenCalled()
  })
  it('a new lock cancels delayed secret warming without rearming', async () => {
    await selectRoom(state.rooms[0])
    appLocked.value = true
    const pending = deferred<void>()
    vi.mocked(engine.warmSecrets).mockReturnValueOnce(pending.promise)
    const unlocked = unlockApp('test-pin')
    await vi.waitFor(() => expect(engine.warmSecrets).toHaveBeenCalled())
    lockNow()
    pending.resolve()
    expect(await unlocked).toBe(false)
    expect(appLocked.value).toBe(true)
    expect(roomReadReady.value).toBe(false)
    expect(engine.watchRoom).toHaveBeenCalledTimes(1)
  })
  it.each(['focus', 'filter', 'thread'] as const)('keeps the rearmed live watch while newer %s intent opens and closes', async change => {
    await selectRoom(state.rooms[0])
    appLocked.value = true
    const handle = deferred<() => void>()
    vi.mocked(engine.watchRoom).mockImplementationOnce((_a, _r, callback) => { update = callback; callback([message()]); return handle.promise })
    const unlocked = unlockApp('test-pin')
    await vi.waitFor(() => expect(engine.watchRoom).toHaveBeenCalledTimes(2))
    expect(appLocked.value).toBe(false)
    if (change === 'focus') {
      vi.spyOn(engine, 'focusEvent').mockResolvedValue(vi.fn())
      await focusMessage('!room:x', '$focused')
    } else if (change === 'filter') state.messageQuery = 'new filter'
    else state.thread = { accountId: fixtureAccount, roomId: '!room:x', rootId: '$root', root: undefined, messages: [], end: false, loading: true }
    update([message('$after-unlock')])
    handle.resolve(vi.fn())
    expect(await unlocked).toBe(true)
    expect(engine.watchRoom).toHaveBeenCalledTimes(2)
    expect(roomReadReady.value).toBe(true)
    if (change === 'focus') expect(focused.value?.eventId).toBe('$focused')
    if (change === 'filter') expect(state.messageQuery).toBe('new filter')
    if (change === 'thread') expect(state.thread?.rootId).toBe('$root')
    clearFocus(); state.messageQuery = ''; state.thread = undefined
    expect(state.messages[messageKey(fixtureAccount, '!room:x')].at(-1)?.id).toBe('$after-unlock')
    acknowledgeVisibleRoom('$after-unlock'); await flush()
    expect(engine.markEventRead).toHaveBeenCalledWith(fixtureAccount, '!room:x', '$after-unlock', expect.any(AbortSignal))
  })
  it('does not revisit an older room when the unlock watch resolves after navigation', async () => {
    await selectRoom(state.rooms[0])
    appLocked.value = true
    const handle = deferred<() => void>()
    const stop = vi.fn()
    vi.mocked(engine.watchRoom).mockImplementationOnce((_a, _r, callback) => { callback([message()]); return handle.promise })
    const unlocked = unlockApp('test-pin')
    await vi.waitFor(() => expect(engine.watchRoom).toHaveBeenCalledTimes(2))
    state.rooms.push({ ...makeRoom(), id: '!new:x' })
    await selectRoom(state.rooms[1])
    handle.resolve(stop); await unlocked
    expect(stop).toHaveBeenCalledOnce()
    expect(state.activeRoomId).toBe('!new:x')
    expect(roomReadReady.value).toBe(true)
    expect(engine.watchRoom).toHaveBeenCalledTimes(3)
  })
})
