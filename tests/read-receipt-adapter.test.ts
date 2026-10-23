import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ init: vi.fn(async () => {}) }))
vi.mock('../src/sdk/index', () => ({ uniffiInitAsync: mocks.init, initPlatform: vi.fn(), LogLevel: { Warn: 1 }, ReceiptType: { Read: 1 } }))
beforeEach(() => { vi.resetModules(); mocks.init.mockReset().mockResolvedValue(undefined) })
async function fixture() {
  const { MatrixEngine } = await import('../src/sdk/engine')
  const engine = new MatrixEngine({ account() {}, rooms() {}, error() {} })
  const sendReadReceipt = vi.fn(async () => {})
  const timeline = { sendReadReceipt }
  const internals = engine as unknown as { timelineCache: Map<string, unknown>; eventCache: Map<string, unknown> }
  internals.timelineCache.set('a/!room:x', timeline)
  internals.eventCache.set('a/!room:x/$event', { eventOrTransactionId: { tag: 'EventId', inner: { eventId: '$event' } } })
  return { engine, timeline, sendReadReceipt, internals }
}
describe('explicit event receipt SDK adapter', () => {
  it('sends the observed EventId through the existing timeline and forwards cancellation', async () => {
    const { engine, sendReadReceipt } = await fixture()
    const signal = new AbortController().signal
    expect(await engine.markEventRead('a', '!room:x', '$event', signal)).toBe(true)
    expect(sendReadReceipt).toHaveBeenCalledExactlyOnceWith(1, '$event', { signal })
  })
  it('refuses local echoes, missing events and absent live timelines', async () => {
    const { engine, sendReadReceipt, internals } = await fixture()
    internals.eventCache.set('a/!room:x/txn', { eventOrTransactionId: { tag: 'TransactionId', inner: { transactionId: 'txn' } } })
    const signal = new AbortController().signal
    expect(await engine.markEventRead('a', '!room:x', 'txn', signal)).toBe(false)
    expect(await engine.markEventRead('a', '!room:x', '$missing', signal)).toBe(false)
    internals.timelineCache.clear()
    expect(await engine.markEventRead('a', '!room:x', '$event', signal)).toBe(false)
    expect(sendReadReceipt).not.toHaveBeenCalled()
    expect(mocks.init).not.toHaveBeenCalled()
  })
  it('refuses a previously disposed adapter', async () => {
    const { engine, sendReadReceipt } = await fixture()
    await engine.dispose()
    expect(await engine.markEventRead('a', '!room:x', '$event', new AbortController().signal)).toBe(false)
    expect(sendReadReceipt).not.toHaveBeenCalled()
    expect(mocks.init).not.toHaveBeenCalled()
  })
  it.each(['abort', 'replace-timeline', 'dispose'] as const)('rechecks %s after SDK initialization', async change => {
    let resolve!: () => void
    mocks.init.mockImplementation(() => new Promise<void>(done => { resolve = done }))
    const { engine, sendReadReceipt, internals } = await fixture()
    const controller = new AbortController()
    const request = engine.markEventRead('a', '!room:x', '$event', controller.signal)
    await vi.waitFor(() => expect(mocks.init).toHaveBeenCalled())
    if (change === 'abort') controller.abort()
    else if (change === 'replace-timeline') internals.timelineCache.set('a/!room:x', {})
    else await engine.dispose()
    resolve()
    expect(await request).toBe(false)
    expect(sendReadReceipt).not.toHaveBeenCalled()
  })
})
