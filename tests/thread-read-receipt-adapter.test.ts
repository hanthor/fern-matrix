import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ init: vi.fn(async () => {}), removing: new Set<string>() }))
vi.mock('../src/sdk/index', () => ({ uniffiInitAsync: mocks.init, initPlatform: vi.fn(), LogLevel: { Warn: 1 }, ReceiptType: { Read: 1 } }))
vi.mock('../src/session-storage', async importOriginal => ({
  ...await importOriginal<typeof import('../src/session-storage')>(),
  isSessionRemoving: (id: string) => mocks.removing.has(id),
}))
beforeEach(() => { mocks.removing.clear(); vi.resetModules(); mocks.init.mockReset().mockResolvedValue(undefined) })
async function fixture() {
  const { MatrixEngine } = await import('../src/sdk/engine')
  const engine = new MatrixEngine({ account() {}, rooms() {}, error() {} })
  const sendReadReceipt = vi.fn(async () => {})
  const timeline = { sendReadReceipt }
  const internals = engine as unknown as { threadTimelines: Map<string, unknown>; eventCache: Map<string, unknown> }
  internals.threadTimelines.set('a/!room:x/$root', timeline)
  internals.eventCache.set('a/!room:x/$reply', {
    eventOrTransactionId: { tag: 'EventId', inner: { eventId: '$reply' } },
    content: { tag: 'MsgLike', inner: { content: { threadRoot: '$root' } } },
  })
  return { engine, sendReadReceipt, internals }
}
describe('visible thread explicit-event SDK receipt', () => {
  it('uses the cached thread timeline and forwards exact event and cancellation', async () => {
    const { engine, sendReadReceipt } = await fixture()
    const signal = new AbortController().signal
    expect(await engine.markThreadEventRead('a', '!room:x', '$root', '$reply', signal)).toBe(true)
    expect(sendReadReceipt).toHaveBeenCalledExactlyOnceWith(1, '$reply', { signal })
  })
  it('rejects wrong-thread/root events, local echoes and missing timelines without creating one', async () => {
    const { engine, sendReadReceipt, internals } = await fixture()
    const signal = new AbortController().signal
    internals.eventCache.set('a/!room:x/$wrong', { eventOrTransactionId: { tag: 'EventId', inner: { eventId: '$wrong' } }, content: { tag: 'MsgLike', inner: { content: { threadRoot: '$other' } } } })
    internals.eventCache.set('a/!room:x/txn', { eventOrTransactionId: { tag: 'TransactionId', inner: { transactionId: 'txn' } } })
    expect(await engine.markThreadEventRead('a', '!room:x', '$root', '$wrong', signal)).toBe(false)
    expect(await engine.markThreadEventRead('a', '!room:x', '$root', 'txn', signal)).toBe(false)
    expect(await engine.markThreadEventRead('a', '!room:x', '$root', '$missing', signal)).toBe(false)
    internals.threadTimelines.clear()
    expect(await engine.markThreadEventRead('a', '!room:x', '$root', '$reply', signal)).toBe(false)
    expect(sendReadReceipt).not.toHaveBeenCalled()
    expect(mocks.init).not.toHaveBeenCalled()
  })
  it('refuses a session already being removed', async () => {
    const { engine, sendReadReceipt } = await fixture()
    mocks.removing.add('a')
    expect(await engine.markThreadEventRead('a', '!room:x', '$root', '$reply', new AbortController().signal)).toBe(false)
    expect(sendReadReceipt).not.toHaveBeenCalled()
    expect(mocks.init).not.toHaveBeenCalled()
  })
  it.each(['abort', 'replace', 'dispose', 'tombstone'] as const)('rechecks %s after SDK initialization', async change => {
    let resolve!: () => void
    mocks.init.mockImplementation(() => new Promise<void>(done => { resolve = done }))
    const { engine, sendReadReceipt, internals } = await fixture()
    const controller = new AbortController()
    const pending = engine.markThreadEventRead('a', '!room:x', '$root', '$reply', controller.signal)
    await vi.waitFor(() => expect(mocks.init).toHaveBeenCalled())
    if (change === 'abort') controller.abort()
    else if (change === 'replace') internals.threadTimelines.set('a/!room:x/$root', {})
    else if (change === 'tombstone') mocks.removing.add('a')
    else await engine.dispose()
    resolve()
    expect(await pending).toBe(false)
    expect(sendReadReceipt).not.toHaveBeenCalled()
  })
})
