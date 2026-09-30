import { describe, expect, it } from 'vitest'
import { MatrixEngine } from '../src/sdk/engine'

// The SDK exposes per-echo retry/abort through lazyProvider.getSendHandle().
// These tests drive that seam with stubs: no WASM is loaded.
function engineWithEcho(handle: { tryResend: () => Promise<void>; abort: () => Promise<boolean> } | undefined) {
  const engine = new MatrixEngine({ account() {}, rooms() {}, error() {} })
  ;(engine as unknown as { eventCache: Map<string, unknown> }).eventCache
    .set('a/!room:x/m1', { lazyProvider: { getSendHandle: () => handle } })
  return engine
}

describe('failed-send retry and discard', () => {
  it('retries through the echo send handle', async () => {
    let retried = 0
    const engine = engineWithEcho({ tryResend: async () => { retried++ }, abort: async () => true })
    await engine.retrySend('a', '!room:x', 'm1')
    expect(retried).toBe(1)
  })

  it('discards through the echo send handle and reports the outcome', async () => {
    const aborted = engineWithEcho({ tryResend: async () => {}, abort: async () => true })
    await expect(aborted.discardSend('a', '!room:x', 'm1')).resolves.toBe(true)
    const sent = engineWithEcho({ tryResend: async () => {}, abort: async () => false })
    await expect(sent.discardSend('a', '!room:x', 'm1')).resolves.toBe(false)
  })

  it('reports remote echoes without a send handle actionably', async () => {
    const engine = engineWithEcho(undefined)
    await expect(engine.retrySend('a', '!room:x', 'm1')).rejects.toThrow('no longer be retried')
    await expect(engine.discardSend('a', '!room:x', 'm1')).rejects.toThrow('no longer be discarded')
    await expect(engine.retrySend('a', '!room:x', 'missing')).rejects.toThrow('no longer be retried')
  })
})
