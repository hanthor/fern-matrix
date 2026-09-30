import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
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
const [alice, bob] = fixture.users

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
async function findMessage(page: Page, accountId: string, roomId: string, body: string) {
  await expect.poll(() => page.evaluate(({ accountId, roomId, body }) =>
    window.matrixTest.messages[accountId + '/' + roomId]?.some(message => message.body === body && message.id.startsWith('$')) ?? false,
  { accountId, roomId, body })).toBe(true)
  return page.evaluate(({ accountId, roomId, body }) =>
    window.matrixTest.messages[accountId + '/' + roomId].find(message => message.body === body)!, { accountId, roomId, body })
}

test('focused jump, pins with permissions, and deleted-event previews', async ({ browser }) => {
  const ca = await browser.newContext()
  const cb = await browser.newContext()
  const pa = await ca.newPage()
  const pb = await cb.newPage()
  try {
    await boot(pa); await boot(pb)
    const a = await login(pa, alice)
    const b = await login(pb, bob)
    const roomId = await pa.evaluate(({ a, invite }) =>
      window.matrixTest.engine.createRoom(a, 'Search fixture', 'jump and pins', invite),
    { a, invite: bob.userId })
    await pb.evaluate(({ b, roomId }) => window.matrixTest.engine.join(b, roomId), { b, roomId })
    await watch(pa, a, roomId); await watch(pb, b, roomId)
    for (const body of ['Searchable sunshine one', 'Searchable sunshine two', 'Searchable sunshine three']) {
      await pa.evaluate(({ a, roomId, body }) => window.matrixTest.engine.send(a, roomId, body), { a, roomId, body })
    }
    const middle = await findMessage(pa, a, roomId, 'Searchable sunshine two')

    // Jump-to-message returns the target with surrounding live context.
    const context = await pa.evaluate(({ a, roomId, eventId }) => new Promise<Message[]>(resolve => {
      const timer = setTimeout(() => resolve([]), 20000)
      void window.matrixTest.engine.focusEvent(a, roomId, eventId, messages => {
        if (!messages.length) return
        clearTimeout(timer); resolve(messages)
      }).catch(() => resolve([]))
    }), { a, roomId, eventId: middle.id })
    expect(context.some(message => message.id === middle.id && message.body === 'Searchable sunshine two')).toBe(true)
    expect(context.some(message => message.body === 'Searchable sunshine one')).toBe(true)
    expect(context.some(message => message.body === 'Searchable sunshine three')).toBe(true)

    // Focusing an unknown event fails actionably instead of rendering empty.
    await expect.poll(() => pa.evaluate(({ a, roomId }) => window.matrixTest.engine
      .focusEvent(a, roomId, '$missing-event-id', () => {}).then(() => 'resolved', (error: Error) => error.message),
    { a, roomId })).not.toBe('resolved')

    // Pins: creator pins, both see ids, only the creator may unpin.
    await pa.evaluate(({ a, roomId, eventId }) => window.matrixTest.engine.pin(a, roomId, eventId),
      { a, roomId, eventId: middle.id })
    const alicePins = await pa.evaluate(({ a, roomId }) => window.matrixTest.engine.pinState(a, roomId), { a, roomId })
    expect(alicePins.ids).toContain(middle.id)
    expect(alicePins.canPin).toBe(true)
    const bobPins = await pb.evaluate(({ b, roomId }) => window.matrixTest.engine.pinState(b, roomId), { b, roomId })
    expect(bobPins.canPin).toBe(false)
    const bobUnpin = await pb.evaluate(({ b, roomId, eventId }) => window.matrixTest.engine.unpin(b, roomId, eventId),
      { b, roomId, eventId: middle.id })
    expect(bobUnpin).toBe(false)
    expect((await pa.evaluate(({ a, roomId }) => window.matrixTest.engine.pinState(a, roomId), { a, roomId })).ids).toContain(middle.id)

    // A redacted pin is unfocusable, so previews report it missing instead of
    // crashing; the pins UI prefers the live timeline's removed marker, and
    // otherwise renders the unavailable row.
    await pa.evaluate(({ a, roomId, eventId }) => window.matrixTest.engine.remove(a, roomId, eventId),
      { a, roomId, eventId: middle.id })
    await expect.poll(() => pa.evaluate(({ a, roomId, eventId }) => window.matrixTest.engine.pinPreview(a, roomId, eventId)
      .then(preview => preview?.body ?? 'missing'), { a, roomId, eventId: middle.id })).toBe('missing')
    await pa.evaluate(({ a, roomId, eventId }) => window.matrixTest.engine.unpin(a, roomId, eventId),
      { a, roomId, eventId: middle.id })
    expect((await pa.evaluate(({ a, roomId }) => window.matrixTest.engine.pinState(a, roomId), { a, roomId })).ids).not.toContain(middle.id)

    // Media attachments ride the same jump machinery for gallery context.
    const bytes = [0x46, 0x65, 0x72, 0x6e, 0x00, 0x67, 0x61, 0x6c, 0x6c, 0x65, 0x72, 0x79]
    await pa.evaluate(({ a, roomId, bytes }) => window.matrixTest.engine.upload(a, roomId,
      new File([new Uint8Array(bytes)], 'gallery-notes.txt', { type: 'text/plain' })).then(operation => operation.done),
    { a, roomId, bytes })
    await expect.poll(() => pa.evaluate(({ a, roomId }) => window.matrixTest.messages[a + '/' + roomId]
      ?.some(message => message.attachment?.name === 'gallery-notes.txt' && message.id.startsWith('$')) ?? false, { a, roomId })).toBe(true)
    const media = await pa.evaluate(({ a, roomId }) => window.matrixTest.messages[a + '/' + roomId]!
      .find(message => message.attachment?.name === 'gallery-notes.txt')!, { a, roomId })
    const mediaContext = await pa.evaluate(({ a, roomId, eventId }) => new Promise<Message[]>(resolve => {
      const timer = setTimeout(() => resolve([]), 20000)
      void window.matrixTest.engine.focusEvent(a, roomId, eventId, messages => {
        if (!messages.length) return
        clearTimeout(timer); resolve(messages)
      }).catch(() => resolve([]))
    }), { a, roomId, eventId: media.id })
    expect(mediaContext.some(message => message.attachment?.name === 'gallery-notes.txt')).toBe(true)
    await pa.evaluate(a => window.matrixTest.engine.dispose(), a)
    await pb.evaluate(b => window.matrixTest.engine.dispose(), b)
  } finally {
    await ca.close(); await cb.close()
  }
})
