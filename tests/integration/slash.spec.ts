import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { MatrixEngine } from '../../src/sdk/engine'
import type { Account, Room, Message } from '../../src/types'

// Slash commands (#41) against a live homeserver: /me arrives as m.emote
// on an independent client and renders on a second Fern client, while
// /topic and /name update room state for both members.
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
const [alice, bob, reference] = fixture.users

class NioPeer {
  private child: ChildProcessWithoutNullStreams
  private nextId = 0
  private pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>()
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
      this.pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value) }, reject: error => { clearTimeout(timeout); reject(error) } })
      this.child.stdin.write(JSON.stringify({ id, action, ...values }) + '\n')
    })
  }
  stop() { this.child.kill('SIGTERM') }
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

test('/me arrives as m.emote; /topic and /name update both members', async ({ browser }) => {
  const ca = await browser.newContext()
  const cb = await browser.newContext()
  const pa = await ca.newPage()
  const pb = await cb.newPage()
  const nio = new NioPeer()
  try {
    await boot(pa); await boot(pb)
    const a = await login(pa, alice)
    const b = await login(pb, bob)
    const roomId = await pa.evaluate(({ id, invite }) =>
      window.matrixTest.engine.createRoom(id, 'Slash original', 'slash fixture', invite),
    { id: a, invite: bob.userId })
    await pa.evaluate(({ id, roomId, user }) => window.matrixTest.engine.invite(id, roomId, user),
      { id: a, roomId, user: reference.userId })
    await expect.poll(() => pb.evaluate(({ accountId, room }) =>
      window.matrixTest.rooms[accountId]?.some(item => item.id === room && item.membership === 'invited') ?? false,
    { accountId: b, room: roomId })).toBe(true)
    await pb.evaluate(({ id, roomId }) => window.matrixTest.engine.join(id, roomId), { id: b, roomId })
    await watch(pa, a, roomId); await watch(pb, b, roomId)
    await nio.command('start', { homeserver: fixture.base, username: reference.username, password: reference.password })
    await nio.command('join', { roomId })

    // The independent client sends first so Olm sessions exist both ways
    // before Fern encrypts the emote to its just-joined device.
    const hello = 'matrix-nio is ready for the emote'
    await nio.command('send', { roomId, body: hello })
    await expect.poll(() => pa.evaluate(({ accountId, roomId, hello }) =>
      window.matrixTest.messages[accountId + '/' + roomId]?.some(message => message.body === hello) ?? false,
    { accountId: a, roomId, hello })).toBe(true)

    // Fern must see the independent client as a member before encrypting,
    // or the new device misses the room key.
    await expect.poll(() => pa.evaluate(({ id, roomId, user }) =>
      window.matrixTest.engine.members(id, roomId).then(members => members.some(member => member.id === user)),
    { id: a, roomId, user: reference.userId })).toBe(true)

    // /me sends a real emote: the independent client sees m.emote on the wire.
    const action = 'waves from the slash test'
    await pa.evaluate(({ id, roomId, action }) => window.matrixTest.engine.sendEmote(id, roomId, action),
      { id: a, roomId, action })
    // The second Fern client renders the emote distinctly through the timeline.
    await expect.poll(() => pb.evaluate(({ accountId, roomId, action }) =>
      window.matrixTest.messages[accountId + '/' + roomId]?.find(message => message.body === action)?.kind ?? null,
    { accountId: b, roomId, action })).toBe('emote')
    const seen = await nio.command('wait_text', { roomId, body: action })
    expect(seen.msgtype).toBe('m.emote')

    // /topic and /name land in room state and reach the other member.
    await pa.evaluate(({ id, roomId }) => window.matrixTest.engine.setRoomTopic(id, roomId, 'slashed topic'),
      { id: a, roomId })
    await expect.poll(() => pb.evaluate(({ accountId, room }) =>
      window.matrixTest.rooms[accountId]?.find(item => item.id === room)?.topic,
    { accountId: b, room: roomId })).toBe('slashed topic')
    await pa.evaluate(({ id, roomId }) => window.matrixTest.engine.setRoomName(id, roomId, 'Slashed name'),
      { id: a, roomId })
    await expect.poll(() => pb.evaluate(({ accountId, room }) =>
      window.matrixTest.rooms[accountId]?.find(item => item.id === room)?.name,
    { accountId: b, room: roomId })).toBe('Slashed name')
  } finally {
    nio.stop()
    await ca.close(); await cb.close()
  }
})
