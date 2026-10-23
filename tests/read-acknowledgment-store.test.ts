import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/applock', async importOriginal => ({ ...await importOriginal<typeof import('../src/applock')>(), verifyPin: vi.fn(async () => true) }))
import { acknowledgeVisibleRoom, appLocked, clearFocus, engine, focusMessage, roomReadReady, selectRoom, state, unlockApp } from '../src/store'
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
})
