import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { MatrixEngine } from '../../src/sdk/engine'
import type { Account, Room, Message } from '../../src/types'

interface FixtureUser { username: string; password: string; userId: string; token: string }
interface Fixture { base: string; version: string; users: FixtureUser[] }
declare global {
  interface Window {
    directoryTestIds: string[]
    matrixTest: { engine: MatrixEngine; accounts: Record<string, Account>; rooms: Record<string, Room[]>;
      messages: Record<string, Message[]>; typing: Record<string, string[]>; errors: string[]; stops: (() => void)[] }
  }
}
const fixture: Fixture = JSON.parse(readFileSync(process.env.FERN_MATRIX_FIXTURE!, 'utf8'))
const [alice, bob, reference] = fixture.users

async function boot(page: Page) {
  // A real Vite-served document preserves loopback network permissions and
  // isolates the adapter from App.vue's automatic session restoration.
  await page.goto('http://127.0.0.1:5173/tests/integration/client.html')
  await page.evaluate(async () => {
    // @ts-expect-error This path is resolved by Vite in the browser.
    const { MatrixEngine } = await import('/src/sdk/engine.ts')
    const state: Window['matrixTest'] = { engine: undefined as unknown as MatrixEngine,
      accounts: {}, rooms: {}, messages: {}, typing: {}, errors: [], stops: [] }
    state.engine = new MatrixEngine({
      account: (account: Account) => { state.accounts[account.id] = account },
      rooms: (accountId: string, rooms: Room[]) => { state.rooms[accountId] = rooms },
      error: (_id: string, error: string) => { state.errors.push(error) },
    })
    window.matrixTest = state
  })
}
async function login(page: Page, user: FixtureUser) {
  const versionCheck = await page.evaluate(async base => (await fetch(base + '/_matrix/client/versions')).status, fixture.base)
  expect(versionCheck).toBe(200)
  return page.evaluate(({ base, username, password }) => window.matrixTest.engine.login(base, username, password),
    { base: fixture.base, username: user.username, password: user.password })
}
async function matrix(request: APIRequestContext, user: FixtureUser, method: string, path: string, data?: unknown) {
  const response = await request.fetch(fixture.base + '/_matrix/client/v3' + path, {
    method, headers: { Authorization: 'Bearer ' + user.token }, data,
  })
  // Report status/path, never headers, credentials or full response bodies.
  expect(response.status(), method + ' ' + path).toBeLessThan(300)
  return response.json()
}
async function watch(page: Page, accountId: string, roomId: string) {
  await expect.poll(() => page.evaluate(({ accountId, roomId }) =>
    window.matrixTest.rooms[accountId]?.some(room => room.id === roomId && room.membership === 'joined') ?? false,
  { accountId, roomId })).toBe(true)
  await page.evaluate(async ({ accountId, roomId }) => {
    const state = window.matrixTest
    const key = accountId + '/' + roomId
    state.stops.push(await state.engine.watchRoom(accountId, roomId,
      messages => { state.messages[key] = messages }, users => { state.typing[key] = users }))
  }, { accountId, roomId })
}
async function findMessage(page: Page, accountId: string, roomId: string, body: string) {
  await expect.poll(() => page.evaluate(({ accountId, roomId, body }) =>
    window.matrixTest.messages[accountId + '/' + roomId]?.some(message => message.body === body && message.id.startsWith('$')) ?? false,
  { accountId, roomId, body })).toBe(true)
  return page.evaluate(({ accountId, roomId, body }) =>
    window.matrixTest.messages[accountId + '/' + roomId].find(message => message.body === body)!, { accountId, roomId, body })
}

test('live password login, simultaneous account isolation, restoration and logout', async ({ page }) => {
  await boot(page)
  const a = await login(page, alice)
  const b = await login(page, bob)
  expect(a).not.toBe(b)
  expect(await page.evaluate(() => Object.values(window.matrixTest.accounts).map(account => account.userId).sort()))
    .toEqual([alice.userId, bob.userId].sort())
  const databases = await page.evaluate(async () => (await indexedDB.databases()).map(db => db.name))
  expect(databases.some(name => name?.includes(a))).toBe(true)
  expect(databases.some(name => name?.includes(b))).toBe(true)
  await page.evaluate(() => window.matrixTest.engine.dispose())
  await boot(page)
  await page.evaluate(() => window.matrixTest.engine.restoreAll())
  await expect.poll(() => page.evaluate(() => Object.values(window.matrixTest.accounts).filter(a => a.connection === 'online').length)).toBe(2)
  await page.evaluate(a => window.matrixTest.engine.logout(a), a)
  expect(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('fern.sessions.v1')!)))).toEqual([b])
  expect(await page.evaluate(b => window.matrixTest.engine.getClient(b).userId(), b)).toBe(bob.userId)
  await page.evaluate(b => window.matrixTest.engine.logout(b), b)
  await page.evaluate(() => window.matrixTest.engine.dispose())
})

test('two clients: invites, text mutations, polls, history, typing and receipts', async ({ browser, request }) => {
  const ca = await browser.newContext()
  const cb = await browser.newContext()
  const pa = await ca.newPage()
  const pb = await cb.newPage()
  try {
    await boot(pa); await boot(pb)
    const a = await login(pa, alice)
    const b = await login(pb, bob)
    const { room_id: roomId } = await matrix(request, reference, 'POST', '/createRoom', {
      name: 'Live integration conversation', visibility: 'public', preset: 'public_chat',
      invite: [alice.userId, bob.userId],
    })
    for (const [p, id] of [[pa, a], [pb, b]] as const) {
      await expect.poll(() => p.evaluate(({ id, roomId }) => window.matrixTest.rooms[id]?.find(r => r.id === roomId)?.membership,
        { id, roomId })).toBe('invited')
      await p.evaluate(({ id, roomId }) => window.matrixTest.engine.join(id, roomId), { id, roomId })
      await watch(p, id, roomId)
    }
    await pa.evaluate(({ a, roomId }) => window.matrixTest.engine.send(a, roomId, 'Live original message'), { a, roomId })
    const original = await findMessage(pb, b, roomId, 'Live original message')
    await findMessage(pa, a, roomId, 'Live original message')
    await pb.evaluate(({ b, roomId, eventId }) => window.matrixTest.engine.send(b, roomId, 'Live reply', eventId),
      { b, roomId, eventId: original.id })
    const reply = await findMessage(pa, a, roomId, 'Live reply')
    expect(reply.replyId).toBe(original.id)
    await pa.evaluate(({ a, roomId, eventId }) => window.matrixTest.engine.send(a, roomId, 'Live edited message', undefined, eventId),
      { a, roomId, eventId: original.id })
    const edited = await findMessage(pb, b, roomId, 'Live edited message')
    expect(edited.edited).toBe(true)
    await pb.evaluate(({ b, roomId, eventId }) => window.matrixTest.engine.react(b, roomId, eventId, '💚'),
      { b, roomId, eventId: original.id })
    await expect.poll(() => pa.evaluate(({ a, roomId, eventId }) =>
      window.matrixTest.messages[a + '/' + roomId]?.find(m => m.id === eventId)?.reactions.find(r => r.key === '💚')?.count,
    { a, roomId, eventId: original.id })).toBe(1)
    await pb.evaluate(({ b, roomId }) => window.matrixTest.engine.typing(b, roomId, true), { b, roomId })
    await expect.poll(() => pa.evaluate(({ a, roomId }) => window.matrixTest.typing[a + '/' + roomId], { a, roomId })).toContain(bob.userId)
    await pb.evaluate(({ b, roomId }) => window.matrixTest.engine.typing(b, roomId, false), { b, roomId })
    await pb.evaluate(({ b, roomId }) => window.matrixTest.engine.markRead(b, roomId), { b, roomId })
    // The independent HTTP reference checks server receipt state through /sync.
    const sync = await matrix(request, reference, 'GET', '/sync?timeout=0')
    const receiptEvents = sync.rooms.join[roomId].ephemeral.events.filter((event: { type: string }) => event.type === 'm.receipt')
    expect(JSON.stringify(receiptEvents)).toContain(bob.userId)
    await pa.evaluate(({ a, roomId }) => window.matrixTest.engine.poll(a, roomId, 'Live poll?', ['Yes', 'No']), { a, roomId })
    await expect.poll(() => pb.evaluate(({ b, roomId }) =>
      window.matrixTest.messages[b + '/' + roomId]?.some(m => m.poll?.question === 'Live poll?'), { b, roomId })).toBe(true)
    const poll = await pb.evaluate(({ b, roomId }) =>
      window.matrixTest.messages[b + '/' + roomId].find(m => m.poll?.question === 'Live poll?')!, { b, roomId })
    await pb.evaluate(({ b, roomId, eventId, answerId }) => window.matrixTest.engine.vote(b, roomId, eventId, answerId),
      { b, roomId, eventId: poll.id, answerId: poll.poll!.answers[0].id })
    await expect.poll(() => pa.evaluate(({ a, roomId }) =>
      window.matrixTest.messages[a + '/' + roomId]?.find(m => m.poll?.question === 'Live poll?')?.poll?.answers[0].count,
    { a, roomId })).toBe(1)
    await expect.poll(() => pb.evaluate(({ b, roomId }) =>
      window.matrixTest.messages[b + '/' + roomId]?.find(m => m.poll?.question === 'Live poll?')?.poll?.voted,
    { b, roomId })).toBe(poll.poll!.answers[0].id)
    await pa.evaluate(({ a, roomId, eventId }) => window.matrixTest.engine.remove(a, roomId, eventId),
      { a, roomId, eventId: original.id })
    await expect.poll(() => pb.evaluate(({ b, roomId }) => window.matrixTest.messages[b + '/' + roomId]?.some(m => m.body === 'Live edited message'),
      { b, roomId })).toBe(false)
    // Populate enough server history to require pagination in a fresh timeline.
    for (let index = 0; index < 65; index++) {
      await matrix(request, reference, 'PUT', `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/history-${index}`,
        { msgtype: 'm.text', body: 'History ' + index })
    }
    await findMessage(pa, a, roomId, 'History 64')
    await pa.evaluate(() => { window.matrixTest.stops.forEach(stop => stop()); return window.matrixTest.engine.dispose() })
    await boot(pa)
    // A new device/store must fetch old history from the server, rather than
    // passing because the earlier client's timeline already cached it all.
    const historyAccount = await login(pa, alice)
    await watch(pa, historyAccount, roomId)
    await findMessage(pa, historyAccount, roomId, 'History 64')
    expect(await pa.evaluate(({ a, roomId }) => window.matrixTest.messages[a + '/' + roomId]?.some(m => m.body === 'History 0'),
      { a: historyAccount, roomId })).toBe(false)
    let historyRequests = 0
    pa.on('request', request => { if (new URL(request.url()).pathname.endsWith('/messages')) historyRequests++ })
    for (let attempt = 0; attempt < 4; attempt++) {
      if (await pa.evaluate(({ a, roomId }) => window.matrixTest.messages[a + '/' + roomId]?.some(m => m.body === 'History 0'), { a: historyAccount, roomId })) break
      await pa.evaluate(({ a, roomId }) => window.matrixTest.engine.paginate(a, roomId), { a: historyAccount, roomId })
    }
    await findMessage(pa, historyAccount, roomId, 'History 0')
    expect(historyRequests).toBeGreaterThan(0)
  } finally {
    for (const p of [pa, pb]) {
      await p.evaluate(async () => { window.matrixTest?.stops.forEach(stop => stop()); await window.matrixTest?.engine.dispose() }).catch(() => {})
    }
    await ca.close(); await cb.close()
  }
})

test('public directory and encrypted DM creation use the real server', async ({ page, request }) => {
  await boot(page)
  const a = await login(page, alice)
  const { room_id: publicId } = await matrix(request, reference, 'POST', '/createRoom', {
    name: 'Fern discovery fixture', visibility: 'public', preset: 'public_chat',
  })
  await page.evaluate(async a => {
    let found: string[] = []
    const search = await window.matrixTest.engine.searchDirectory(a, 'Fern discovery fixture', rooms => { found = rooms.map(room => room.id) })
    // Store the callback result for polling without exposing SDK objects across the browser boundary.
    Object.defineProperty(window, 'directoryTestIds', { get: () => found, configurable: true })
    window.matrixTest.stops.push(search.stop)
  }, a)
  await expect.poll(() => page.evaluate(() => window.directoryTestIds)).toContain(publicId)
  const dm = await page.evaluate(({ a, invite }) => window.matrixTest.engine.createRoom(a, 'Encrypted DM fixture', 'Live integration', invite),
    { a, invite: bob.userId })
  await expect.poll(() => page.evaluate(({ a, dm }) => window.matrixTest.rooms[a]?.find(room => room.id === dm)?.encrypted, { a, dm })).toBe(true)
  const members = await page.evaluate(({ a, dm }) => window.matrixTest.engine.members(a, dm), { a, dm })
  expect(members.map(member => member.id)).toContain(alice.userId)
  await page.evaluate(() => { window.matrixTest.stops.forEach(stop => stop()); return window.matrixTest.engine.dispose() })
})
