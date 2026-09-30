import { describe, expect, it, vi, afterEach } from 'vitest'
import { MatrixEngine, OFFLINE_AFTER_FAILURES, pollDelay } from '../src/sdk/engine'

afterEach(() => { vi.unstubAllGlobals() })

// The downtime detector is pure engine state: failures are fed straight into
// the private seam (no WASM), while the live suite covers the wiring.
function harness() {
  const accounts: unknown[] = []
  const errors: Array<[string, string]> = []
  const engine = new MatrixEngine({ account: value => { accounts.push(value) }, rooms() {}, error: (id, message) => { errors.push([id, message]) } })
  const internals = engine as unknown as {
    noteRefreshSuccess: (id: string) => void
    noteRefreshFailure: (id: string, error: unknown) => void
    retryConnection: (id: string) => Promise<void>
    pingServer: (id: string) => Promise<void>
    refreshRooms: (id: string) => Promise<void>
    clients: Map<string, { userId: () => string; homeserver?: () => string }>
  }
  internals.clients.set('a', { userId: () => '@a:x' })
  return { engine, internals, accounts: accounts as Array<{ connection: string; error?: string }>, errors }
}

describe('downtime detection and bounded retry', () => {
  it('backs the room-list poll off exponentially to a one-minute cap', () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(pollDelay)).toEqual([4000, 8000, 16000, 32000, 60000, 60000, 60000])
  })
  it('flips offline after consecutive failures, exactly once', () => {
    const { internals, accounts, errors } = harness()
    internals.noteRefreshFailure('a', new Error('network unreachable'))
    internals.noteRefreshFailure('a', new Error('network unreachable'))
    expect(accounts).toEqual([])
    expect(errors).toEqual([])
    internals.noteRefreshFailure('a', new Error('network unreachable'))
    expect(accounts).toEqual([{ id: 'a', userId: '@a:x', name: 'a', color: '#477962', connection: 'offline', error: expect.any(String) }])
    expect(errors).toEqual([['a', 'Connection lost. Retrying automatically.']])
    internals.noteRefreshFailure('a', new Error('network unreachable'))
    expect(accounts).toHaveLength(1)
    expect(errors).toHaveLength(1)
    expect(OFFLINE_AFTER_FAILURES).toBe(3)
  })
  it('recovers to online on the next success and resets the count', () => {
    const { internals, accounts, errors } = harness()
    for (let index = 0; index < 3; index++) internals.noteRefreshFailure('a', new Error('down'))
    internals.noteRefreshSuccess('a')
    expect(accounts.at(-1)).toMatchObject({ connection: 'online' })
    internals.noteRefreshFailure('a', new Error('down'))
    expect(accounts).toHaveLength(2)
    expect(errors).toHaveLength(1)
  })
  it('never flips auth failures to offline and reports them once', () => {
    const { internals, accounts, errors } = harness()
    const expired = new Error('401 Unauthorized: M_UNKNOWN_TOKEN soft logout')
    for (let index = 0; index < 5; index++) internals.noteRefreshFailure('a', expired)
    expect(accounts).toEqual([])
    expect(errors).toEqual([['a', expired.message]])
  })
  it('retryConnection resets backoff, announces and re-polls immediately', async () => {
    const { engine, internals, accounts } = harness()
    for (let index = 0; index < 3; index++) internals.noteRefreshFailure('a', new Error('down'))
    let polls = 0
    internals.pingServer = async () => { polls++; internals.noteRefreshSuccess('a') }
    internals.refreshRooms = async () => {}
    await engine.retryConnection('a')
    expect(polls).toBe(1)
    expect(accounts.at(-2)).toMatchObject({ connection: 'connecting' })
    expect(accounts.at(-1)).toMatchObject({ connection: 'online' })
  })
  it('ping failures flip offline and a successful ping recovers', async () => {
    const { internals, accounts, errors } = harness()
    internals.clients.set('a', { userId: () => '@a:x', homeserver: () => 'http://down.invalid/' })
    vi.stubGlobal('fetch', async () => { throw new Error('connection refused') })
    await internals.pingServer('a')
    await internals.pingServer('a')
    expect(accounts).toEqual([])
    await internals.pingServer('a')
    expect(accounts.at(-1)).toMatchObject({ connection: 'offline' })
    vi.stubGlobal('fetch', async () => ({ ok: true }))
    await internals.pingServer('a')
    expect(accounts.at(-1)).toMatchObject({ connection: 'online' })
    expect(errors).toHaveLength(1)
  })
  it('retryConnection fails actionably for a removed account', async () => {
    const { engine } = harness()
    await expect(engine.retryConnection('gone')).rejects.toThrow('not connected')
  })
})
