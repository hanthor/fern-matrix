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

test('forwarding re-sends text and encrypted media into chosen rooms', async ({ browser }) => {
  const ca = await browser.newContext()
  const cb = await browser.newContext()
  const pa = await ca.newPage()
  const pb = await cb.newPage()
  try {
    await boot(pa); await boot(pb)
    const a = await login(pa, alice)
    const b = await login(pb, bob)
    const roomA = await pa.evaluate((id: string) =>
      window.matrixTest.engine.createRoom(id, 'Forward source', 'forward fixture'), a)
    const roomB = await pa.evaluate(({ id, invite }) =>
      window.matrixTest.engine.createRoom(id, 'Forward target', 'forward fixture', invite), { id: a, invite: bob.userId })
    await pb.evaluate(({ id, roomId }) => window.matrixTest.engine.join(id, roomId), { id: b, roomId: roomB })
    await watch(pa, a, roomA); await watch(pa, a, roomB); await watch(pb, b, roomB)
    await pa.evaluate(({ id, roomId }) => window.matrixTest.engine.send(id, roomId, 'Forward this text please'), { id: a, roomId: roomA })
    const payload = [9, 8, 7, 6, 5, 4, 3, 2, 1]
    await pa.evaluate(({ id, roomId, payload }) => window.matrixTest.engine.upload(id, roomId,
      new File([new Uint8Array(payload)], 'forward-secret.bin', { type: 'application/octet-stream' })).then(operation => operation.done),
    { id: a, roomId: roomA, payload })
    await expect.poll(() => pa.evaluate(({ id, roomId }) => window.matrixTest.messages[id + '/' + roomId]
      ?.some(message => message.body === 'Forward this text please' && message.id.startsWith('$')) ?? false,
    { id: a, roomId: roomA })).toBe(true)
    await expect.poll(() => pa.evaluate(({ id, roomId }) => window.matrixTest.messages[id + '/' + roomId]
      ?.some(message => message.attachment?.name === 'forward-secret.bin' && message.id.startsWith('$')) ?? false,
    { id: a, roomId: roomA })).toBe(true)
    const text = await pa.evaluate(({ id, roomId }) => window.matrixTest.messages[id + '/' + roomId]!
      .find(message => message.body === 'Forward this text please')!, { id: a, roomId: roomA })
    const file = await pa.evaluate(({ id, roomId }) => window.matrixTest.messages[id + '/' + roomId]!
      .find(message => message.attachment?.name === 'forward-secret.bin')!, { id: a, roomId: roomA })

    // Text and encrypted media forward into the chosen room and arrive
    // decrypted, byte-identical, under the forwarder's identity.
    await pa.evaluate(({ id, roomA, message, roomB }) =>
      window.matrixTest.engine.forwardMessage(id, roomA, message, id, roomB), { id: a, roomA, message: text, roomB })
    await pa.evaluate(({ id, roomA, message, roomB }) =>
      window.matrixTest.engine.forwardMessage(id, roomA, message, id, roomB), { id: a, roomA, message: file, roomB })
    await expect.poll(() => pb.evaluate(({ id, roomId }) => window.matrixTest.messages[id + '/' + roomId]
      ?.some(message => message.body === 'Forward this text please' && message.name === 'alice' && message.id.startsWith('$')) ?? false,
    { id: b, roomId: roomB })).toBe(true)
    await expect.poll(() => pb.evaluate(({ id, roomId }) => window.matrixTest.messages[id + '/' + roomId]
      ?.some(message => message.attachment?.name === 'forward-secret.bin' && message.id.startsWith('$')) ?? false,
    { id: b, roomId: roomB })).toBe(true)
    const forwarded = await pb.evaluate(({ id, roomId }) => window.matrixTest.messages[id + '/' + roomId]!
      .find(message => message.attachment?.name === 'forward-secret.bin')!, { id: b, roomId: roomB })
    const downloaded = await pb.evaluate(async ({ id, roomId, message }) => {
      const url = await window.matrixTest.engine.download(id, roomId, message)
      return [...new Uint8Array(await (await fetch(url)).arrayBuffer())]
    }, { id: b, roomId: roomB, message: forwarded })
    expect(downloaded).toEqual(payload)

    // Refusals: polls, removed content, and rooms the forwarder never joined.
    await expect(pa.evaluate(({ id, roomA, message, roomB }) => window.matrixTest.engine
      .forwardMessage(id, roomA, { ...message, kind: 'poll' }, id, roomB), { id: a, roomA, message: text, roomB }))
      .rejects.toThrow('Polls cannot be forwarded')
    await expect(pa.evaluate(({ id, roomA, message, roomB }) => window.matrixTest.engine
      .forwardMessage(id, roomA, { ...message, kind: 'notice', body: 'Message removed' }, id, roomB),
    { id: a, roomA, message: text, roomB })).rejects.toThrow('removed')
    await expect(pa.evaluate(({ id, roomA, message }) => window.matrixTest.engine
      .forwardMessage(id, roomA, message, id, '!never-joined:example'), { id: a, roomA, message: text }))
      .rejects.toThrow()
    await pa.evaluate(id => window.matrixTest.engine.dispose(), a)
    await pb.evaluate(id => window.matrixTest.engine.dispose(), b)
  } finally {
    await ca.close(); await cb.close()
  }
})

test('forwarding works across the forwarder\u2019s own accounts', async ({ browser }) => {
  const ca = await browser.newContext()
  const cb = await browser.newContext()
  const pa = await ca.newPage()
  const pb = await cb.newPage()
  try {
    await boot(pa); await boot(pb)
    const a = await login(pa, alice)
    // Both sessions live on one engine here, exactly like the real app's
    // multi-account engine, so one composition can span both accounts.
    const b2 = await login(pa, bob)
    const b = await login(pb, bob)
    const roomA = await pa.evaluate((id: string) =>
      window.matrixTest.engine.createRoom(id, 'Cross-account source', 'forward fixture'), a)
    const roomC = await pa.evaluate((id: string) =>
      window.matrixTest.engine.createRoom(id, 'Cross-account target', 'forward fixture'), b2)
    await watch(pa, a, roomA); await watch(pb, b, roomC)
    await pa.evaluate(({ id, roomId }) => window.matrixTest.engine.send(id, roomId, 'Cross-account forward me'), { id: a, roomId: roomA })
    await expect.poll(() => pa.evaluate(({ id, roomId }) => window.matrixTest.messages[id + '/' + roomId]
      ?.some(message => message.body === 'Cross-account forward me' && message.id.startsWith('$')) ?? false,
    { id: a, roomId: roomA })).toBe(true)
    const text = await pa.evaluate(({ id, roomId }) => window.matrixTest.messages[id + '/' + roomId]!
      .find(message => message.body === 'Cross-account forward me')!, { id: a, roomId: roomA })
    // Alice's plaintext is re-encrypted under Bob's session: each leg stays
    // inside rooms its own account joined.
    await pa.evaluate(({ a, roomA, message, b2, roomC }) =>
      window.matrixTest.engine.forwardMessage(a, roomA, message, b2, roomC),
    { a, roomA, message: text, b2, roomC })
    await expect.poll(() => pb.evaluate(({ id, roomId }) => window.matrixTest.messages[id + '/' + roomId]
      ?.some(message => message.body === 'Cross-account forward me' && message.name === 'bob' && message.id.startsWith('$')) ?? false,
    { id: b, roomId: roomC })).toBe(true)
    await pa.evaluate(id => window.matrixTest.engine.dispose(), a)
    await pb.evaluate(id => window.matrixTest.engine.dispose(), b)
  } finally {
    await ca.close(); await cb.close()
  }
})
