import { describe, expect, it } from 'vitest'
import { MatrixEngine } from '../src/sdk/engine'

// watchRoom's stop must drop its own native timeline (identity-guarded) so
// rapid switches cannot accumulate timelines or let a stale stop evict a
// newer watch. Stubs only: no WASM is loaded.
function engineWithRoom() {
  const engine = new MatrixEngine({ account() {}, rooms() {}, error() {} })
  const made: { cancelled: boolean }[] = []
  const room = {
    ownUserId: () => '@a:x',
    timeline: async () => {
      const timeline = { cancelled: false, addListener: async () => ({ cancel: () => { timeline.cancelled = true } }) }
      made.push(timeline)
      return timeline
    },
    subscribeToTypingNotifications: () => ({ cancel() {} }),
  }
  ;(engine as unknown as { clients: Map<string, unknown> }).clients.set('a', { getRoom: () => room })
  const internals = engine as unknown as { timelineCache: Map<string, unknown> }
  return { engine, made, cache: internals.timelineCache }
}

describe('watchRoom disposal', () => {
  it('stopping a watch cancels listeners and drops its timeline', async () => {
    const { engine, made, cache } = engineWithRoom()
    const stop = await engine.watchRoom('a', '!r:x', () => {}, () => {})
    expect(cache.has('a/!r:x')).toBe(true)
    stop()
    expect(made[0]!.cancelled).toBe(true)
    expect(cache.has('a/!r:x')).toBe(false)
  })
  it('a stale stop cannot evict a newer watch timeline', async () => {
    const { engine, made, cache } = engineWithRoom()
    const noop = () => {}
    const first = await engine.watchRoom('a', '!r:x', noop, noop)
    const second = await engine.watchRoom('a', '!r:x', noop, noop)
    first()
    expect(made[0]!.cancelled).toBe(true)
    expect(cache.size).toBe(1)
    second()
    expect(made[1]!.cancelled).toBe(true)
    expect(cache.size).toBe(0)
  })
})
