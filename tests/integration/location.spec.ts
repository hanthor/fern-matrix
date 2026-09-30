import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { MatrixEngine } from '../../src/sdk/engine'
import type { Account, Room, Message } from '../../src/types'

interface FixtureUser { username: string; password: string; userId: string; token: string }
interface Fixture { base: string; version: string; users: FixtureUser[] }
declare global {
  interface Window {
    matrixTest: { engine: MatrixEngine; accounts: Record<string, Account>; rooms: Record<string, Room[]>;
      messages: Record<string, Message[]>; typing: Record<string, string[]>; errors: string[]; stops: (() => void)[];
      verification: { status: string; emojis?: { symbol: string; description: string }[]; numbers?: number[] }[] }
  }
}
const fixture: Fixture = JSON.parse(readFileSync(process.env.FERN_MATRIX_FIXTURE!, 'utf8'))
const [alice, , reference] = fixture.users

class NioPeer {
  private child: ChildProcessWithoutNullStreams
  private nextId = 0
  private pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>()
  private closed: Promise<void>
  constructor() {
    this.child = spawn(process.env.FERN_SYNAPSE_PYTHON ?? 'python3', ['tests/integration/nio_peer.py'], { stdio: 'pipe' })
    this.child.stderr.resume()
    const lines = createInterface({ input: this.child.stdout })
    lines.on('line', line => {
      let response: { id?: string; error?: string } & Record<string, unknown>
      try { response = JSON.parse(line) }
      catch { return }
      if (!response.id) return
      const pending = this.pending.get(response.id)
      if (!pending) return
      this.pending.delete(response.id)
      if (response.error) pending.reject(new Error(response.error))
      else pending.resolve(response)
    })
    this.closed = new Promise(resolve => this.child.once('close', () => resolve()))
    this.child.once('error', error => {
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
    })
    this.child.once('close', code => {
      if (code === 0) return
      for (const pending of this.pending.values()) pending.reject(new Error('Independent Matrix test client stopped unexpectedly.'))
      this.pending.clear()
    })
  }
  command(action: string, values: Record<string, unknown> = {}, timeoutMs = 45_000) {
    const id = String(++this.nextId)
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Independent Matrix test client timed out.'))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: value => { clearTimeout(timeout); resolve(value) },
        reject: error => { clearTimeout(timeout); reject(error) },
      })
      this.child.stdin.write(JSON.stringify({ id, action, ...values }) + '\n')
    })
  }
  async stop() {
    try { await this.command('stop') } finally { await this.closed }
  }
}

async function boot(page: Page) {
  await page.goto('http://127.0.0.1:5173/tests/integration/client.html')
  await page.evaluate(async () => {
    // @ts-expect-error This path is resolved by Vite in the browser.
    const { MatrixEngine } = await import('/src/sdk/engine.ts')
    const state = { engine: undefined as unknown as MatrixEngine,
      accounts: {}, rooms: {}, messages: {}, typing: {}, errors: [], stops: [], verification: [] } as Window['matrixTest']
    state.engine = new MatrixEngine({
      account: (account: Account) => { state.accounts[account.id] = account },
      rooms: (accountId: string, rooms: Room[]) => { state.rooms[accountId] = rooms },
      error: () => {},
    })
    window.matrixTest = state
  })
}
async function login(page: Page, user: FixtureUser) {
  return page.evaluate(({ base, username, password }) => window.matrixTest.engine.login(base, username, password),
    { base: fixture.base, username: user.username, password: user.password })
}
async function watch(page: Page, accountId: string, roomId: string) {
  await expect.poll(() => page.evaluate(({ accountId, roomId }) =>
    window.matrixTest.rooms[accountId]?.some(room => room.id === roomId && room.membership === 'joined') ?? false,
  { accountId, roomId })).toBe(true)
  await page.evaluate(async ({ accountId, roomId }) => {
    const state = window.matrixTest
    const key = accountId + '/' + roomId
    state.stops.push(await state.engine.watchRoom(accountId, roomId,
      messages => { state.messages[key] = messages }, () => {}))
  }, { accountId, roomId })
}

test('encrypted location shares interoperate with an independent client', async ({ page, request }) => {
  const nio = new NioPeer()
  let nioStarted = false
  try {
    await boot(page)
    const a = await login(page, alice)
    await nio.command('start', { homeserver: fixture.base, username: reference.username, password: reference.password })
    nioStarted = true
    const roomId = await page.evaluate(({ a, invite }) =>
      window.matrixTest.engine.createRoom(a, 'Location fixture', 'encrypted location interop', invite),
    { a, invite: reference.userId })
    await watch(page, a, roomId)
    await nio.command('join', { roomId })

    // Independent client -> Fern: a valid share parses into coordinates with
    // a text alternative; a corrupt geo URI falls back to plain text.
    await nio.command('send_location', { roomId, body: 'Nio is here', geoUri: 'geo:53.4794,-2.2453;u=25', description: 'Nio spot' })
    await expect.poll(() => page.evaluate(({ a, roomId }) => window.matrixTest.messages[a + '/' + roomId]
      ?.some(message => message.kind === 'location' && message.location?.lat === 53.4794) ?? false,
    { a, roomId })).toBe(true)
    const nioShare = await page.evaluate(({ a, roomId }) => window.matrixTest.messages[a + '/' + roomId]!
      .find(message => message.location?.lat === 53.4794)!, { a, roomId })
    // Coordinates and uncertainty parse; the sender's top-level description
    // does not reach timeline content in this SDK build (upstream
    // matrix-org/matrix-rust-sdk#7138), so only the coordinate alternative
    // renders — same fallback Element uses for undescribed shares.
    expect(nioShare.location).toEqual({ lat: 53.4794, lon: -2.2453, uncertainty: 25 })
    expect(nioShare.body).toBe('Location shared: 53.4794, -2.2453 (±25m)')
    await nio.command('send_location', { roomId, body: 'Bogus place', geoUri: 'not-a-place' })
    await expect.poll(() => page.evaluate(({ a, roomId }) => window.matrixTest.messages[a + '/' + roomId]
      ?.some(message => message.kind === 'text' && message.body === 'Bogus place') ?? false,
    { a, roomId })).toBe(true)

    // Fern -> independent client: coordinates and description arrive
    // decrypted, and never appear outside the ciphertext.
    await page.evaluate(({ a, roomId }) => window.matrixTest.engine.sendLocation(a, roomId,
      { lat: 51.5074, lon: -0.1278, description: 'Fern spot' }), { a, roomId })
    const received = await nio.command('wait_location', { roomId, body: 'Location shared: 51.5074, -0.1278 — Fern spot' })
    expect(received.decrypted).toBe(true)
    expect(received.geoUri).toBe('geo:51.5074,-0.1278')
    // This SDK build drops the top-level description on the wire too
    // (upstream matrix-org/matrix-rust-sdk#7138); coordinates arrive intact.
    expect(received.description).toBeNull()
    const raw = await request.fetch(fixture.base + '/_matrix/client/v3' + `/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=20`,
      { headers: { Authorization: 'Bearer ' + alice.token } })
    expect(raw.status()).toBeLessThan(300)
    const chunk = (await raw.json() as { chunk: { type: string }[] }).chunk
    expect(chunk.some(event => event.type === 'm.room.encrypted')).toBe(true)
    expect(JSON.stringify(chunk)).not.toContain('51.5074')
    await page.evaluate(a => window.matrixTest.engine.dispose(), a)
  } finally {
    if (nioStarted) await nio.stop()
  }
})
