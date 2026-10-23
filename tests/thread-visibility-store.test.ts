import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { state, engine, openThread, closeThread, threadReadReady, acknowledgeVisibleThread, threadUnread, appLocked, threadReply, paginateThread } from '../src/store'
import type { Message } from '../src/types'
const reply = (id = '$reply', rootId = '$root'): Message => ({ id, threadRoot: rootId, sender: '@sender:x', name: 'Sender', body: id, timestamp: 1, own: false, kind: 'text', reactions: [] })
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
let fixtureId = 0
let accountId = ''
let update: (messages: Message[]) => void
beforeEach(() => {
  closeThread(); appLocked.value = false
  accountId = 'thread-fixture-' + (++fixtureId)
  state.accounts = [{ id: accountId, userId: '@a:x', name: 'A', color: '#123', connection: 'online' }]
  state.activeAccountId = accountId; state.activeRoomId = '!room:x'; state.details = true
  state.messages = {}; state.threadSeen = {}; state.threadReadBoundary = {}; state.threadKnownEvents = {}; state.threadAcknowledgedEvents = {}; state.error = ''
  vi.spyOn(engine, 'watchThread').mockImplementation(async (_a, _r, _root, callback) => { update = callback; callback([reply('$reply', _root)]); return vi.fn() })
  vi.spyOn(engine, 'markThreadEventRead').mockResolvedValue(true)
  vi.spyOn(engine, 'markThreadRead').mockResolvedValue(undefined)
})
afterEach(() => { closeThread(); state.details = false; vi.restoreAllMocks() })
describe('thread subscription ownership and visible receipts', () => {
  it('keeps subscription updates separate from read acknowledgment', async () => {
    expect(await openThread(accountId, '!room:x', '$root')).toBe(true)
    expect(threadReadReady.value).toBe(true)
    expect(threadUnread(accountId, '!room:x', '$root', 1)).toBeUndefined()
    expect(engine.markThreadRead).not.toHaveBeenCalled()
    expect(engine.markThreadEventRead).not.toHaveBeenCalled()
    acknowledgeVisibleThread('$reply'); await flush()
    expect(engine.markThreadEventRead).toHaveBeenCalledWith(accountId, '!room:x', '$root', '$reply', expect.any(AbortSignal))
    expect(threadUnread(accountId, '!room:x', '$root', 1)).toBe(0)
  })
  it('requires both current watch handle and first snapshot', async () => {
    const handle = deferred<() => void>()
    vi.mocked(engine.watchThread).mockImplementationOnce((_a, _r, _root, callback) => { update = callback; callback([reply()]); return handle.promise })
    const opened = openThread(accountId, '!room:x', '$root')
    expect(threadReadReady.value).toBe(false)
    acknowledgeVisibleThread('$reply')
    expect(engine.markThreadEventRead).not.toHaveBeenCalled()
    handle.resolve(vi.fn()); await opened
    expect(threadReadReady.value).toBe(true)
    closeThread()
    vi.mocked(engine.watchThread).mockImplementationOnce(async (_a, _r, _root, callback) => { update = callback; return vi.fn() })
    await openThread(accountId, '!room:x', '$root')
    expect(threadReadReady.value).toBe(false)
    update([reply()])
    expect(threadReadReady.value).toBe(true)
  })
  it('cancels a late handle and rejects callbacks after same-root account switching', async () => {
    const handle = deferred<() => void>(), oldStop = vi.fn(), currentStop = vi.fn()
    let oldUpdate!: (messages: Message[]) => void
    vi.mocked(engine.watchThread).mockImplementationOnce((_a, _r, _root, callback) => { oldUpdate = callback; return handle.promise })
    const old = openThread(accountId, '!room:x', '$root')
    const nextId = accountId + '-next'
    state.accounts.push({ ...state.accounts[0], id: nextId })
    state.activeAccountId = nextId
    vi.mocked(engine.watchThread).mockImplementationOnce(async (_a, _r, _root, callback) => { callback([reply('$current')]); return currentStop })
    await openThread(nextId, '!room:x', '$root')
    oldUpdate([reply('$stale')])
    handle.resolve(oldStop)
    expect(await old).toBe(false)
    expect(oldStop).toHaveBeenCalledOnce()
    expect(state.thread?.accountId).toBe(nextId)
    expect(state.thread?.messages.map(value => value.id)).toEqual(['$current'])
    closeThread()
    expect(currentStop).toHaveBeenCalledOnce()
  })
  it('ignores late callbacks after same-root reopen', async () => {
    await openThread(accountId, '!room:x', '$root')
    const oldUpdate = update
    await openThread(accountId, '!room:x', '$root')
    update([reply('$current')]); oldUpdate([reply('$stale')])
    expect(state.thread?.messages.at(-1)?.id).toBe('$current')
  })
  it('closing before watch failure never throws or overwrites a newer error', async () => {
    const handle = deferred<() => void>()
    vi.mocked(engine.watchThread).mockReturnValueOnce(handle.promise)
    const old = openThread(accountId, '!room:x', '$root')
    closeThread(); state.error = 'Current error'
    handle.reject(new Error('Old watch failed'))
    expect(await old).toBe(false)
    expect(state.error).toBe('Current error')
    expect(state.thread).toBeUndefined()
  })
  it('hiding details cancels receipts but retains the live subscription', async () => {
    await openThread(accountId, '!room:x', '$root')
    const pending = deferred<boolean>()
    vi.mocked(engine.markThreadEventRead).mockReturnValueOnce(pending.promise)
    acknowledgeVisibleThread('$reply')
    const signal = vi.mocked(engine.markThreadEventRead).mock.calls[0][4]
    state.details = false
    expect(signal.aborted).toBe(true)
    update([reply(), reply('$new')])
    acknowledgeVisibleThread('$new')
    expect(engine.markThreadEventRead).toHaveBeenCalledTimes(1)
    pending.resolve(true); await flush()
    expect(threadUnread(accountId, '!room:x', '$root', 2)).toBeUndefined()
    expect(threadReadReady.value).toBe(true)
    state.details = true
    acknowledgeVisibleThread('$new'); await flush()
    expect(threadUnread(accountId, '!room:x', '$root', 2)).toBe(0)
  })
  it('reapplies a hidden successful receipt only once its target is visible again', async () => {
    await openThread(accountId, '!room:x', '$root')
    const pending = deferred<boolean>()
    vi.mocked(engine.markThreadEventRead).mockReturnValueOnce(pending.promise)
    acknowledgeVisibleThread('$reply')
    state.details = false
    pending.resolve(true); await flush()
    expect(threadUnread(accountId, '!room:x', '$root', 1)).toBeUndefined()
    state.details = true
    acknowledgeVisibleThread('$reply'); await flush()
    expect(engine.markThreadEventRead).toHaveBeenCalledTimes(1)
    expect(threadUnread(accountId, '!room:x', '$root', 1)).toBe(0)
  })
  it('older pagination can refresh visible local seen count without resending or reading newer replies', async () => {
    await openThread(accountId, '!room:x', '$root')
    acknowledgeVisibleThread('$reply'); await flush()
    update([reply('$older-1'), reply('$older-2'), reply()])
    expect(threadUnread(accountId, '!room:x', '$root', 3)).toBe(0) // Older replies precede the acknowledged boundary.
    acknowledgeVisibleThread('$reply'); await flush()
    expect(engine.markThreadEventRead).toHaveBeenCalledTimes(1)
    expect(threadUnread(accountId, '!room:x', '$root', 3)).toBe(0)
    update([reply('$older-1'), reply('$older-2'), reply(), reply('$unseen')])
    acknowledgeVisibleThread('$reply'); await flush()
    expect(threadUnread(accountId, '!room:x', '$root', 4)).toBe(1)
    expect(engine.markThreadEventRead).toHaveBeenCalledTimes(1)
  })
  it('unknown summary totals or a missing acknowledged boundary never invent unread counts', async () => {
    expect(threadUnread(accountId, '!room:x', '$root', 500)).toBeUndefined()
    await openThread(accountId, '!room:x', '$root')
    acknowledgeVisibleThread('$reply'); await flush()
    expect(threadUnread(accountId, '!room:x', '$root', 500)).toBe(0)
    update([reply('$different-window')])
    expect(threadUnread(accountId, '!room:x', '$root', 500)).toBeUndefined()
  })
  it('an older acknowledged snapshot cannot roll back a newer known read boundary', async () => {
    await openThread(accountId, '!room:x', '$root')
    update([reply('$A'), reply('$B')])
    acknowledgeVisibleThread('$B'); await flush()
    update([reply('$A')])
    acknowledgeVisibleThread('$A'); await flush()
    update([reply('$A'), reply('$B'), reply('$unseen')])
    expect(threadUnread(accountId, '!room:x', '$root', 3)).toBe(1)
    update([reply('$A'), reply('$B')])
    expect(threadUnread(accountId, '!room:x', '$root', 2)).toBe(0)
  })
  it('old completion cannot count newer unseen replies', async () => {
    await openThread(accountId, '!room:x', '$root')
    const pending = deferred<boolean>()
    vi.mocked(engine.markThreadEventRead).mockReturnValueOnce(pending.promise)
    acknowledgeVisibleThread('$reply')
    update([reply(), reply('$unseen')])
    pending.resolve(true); await flush()
    expect(threadUnread(accountId, '!room:x', '$root', 2)).toBeUndefined()
  })
  it('rejects roots, local echoes and failed events as receipt targets', async () => {
    await openThread(accountId, '!room:x', '$root')
    update([{ ...reply('$root'), threadRoot: undefined }, { ...reply('txn'), status: 'sending' }, { ...reply('$failed'), status: 'failed' }])
    for (const id of ['$root', 'txn', '$failed']) acknowledgeVisibleThread(id)
    expect(engine.markThreadEventRead).not.toHaveBeenCalled()
  })
  it('deduplicates receipts independently for distinct thread roots', async () => {
    await openThread(accountId, '!room:x', '$root')
    acknowledgeVisibleThread('$reply'); await flush()
    await openThread(accountId, '!room:x', '$other')
    acknowledgeVisibleThread('$reply'); await flush()
    expect(engine.markThreadEventRead).toHaveBeenCalledTimes(2)
    expect(threadUnread(accountId, '!room:x', '$root', 1)).toBe(0)
    expect(threadUnread(accountId, '!room:x', '$other', 1)).toBe(0)
  })
  it('locking closes the subscription and rejects late callbacks', async () => {
    const stop = vi.fn()
    vi.mocked(engine.watchThread).mockImplementationOnce(async (_a, _r, _root, callback) => { update = callback; callback([reply()]); return stop })
    await openThread(accountId, '!room:x', '$root')
    appLocked.value = true
    update([reply('$late')])
    expect(stop).toHaveBeenCalledOnce()
    expect(state.thread).toBeUndefined()
    expect(threadReadReady.value).toBe(false)
    expect(engine.markThreadEventRead).not.toHaveBeenCalled()
  })
  it.each(['reply', 'paginate'] as const)('a stale %s failure does not change the newer thread', async operation => {
    await openThread(accountId, '!room:x', '$root')
    const pending = deferred<never>()
    if (operation === 'reply') vi.spyOn(engine, 'sendThreadReply').mockReturnValueOnce(pending.promise)
    else vi.spyOn(engine, 'paginateThread').mockReturnValueOnce(pending.promise)
    const work = operation === 'reply' ? threadReply('Old message') : paginateThread()
    await openThread(accountId, '!room:x', '$next')
    state.error = 'Current error'
    pending.reject(new Error('Stale failure')); await work
    expect(state.error).toBe('Current error')
    expect(state.thread?.rootId).toBe('$next')
  })
})
