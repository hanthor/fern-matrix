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
    directoryTestIds: string[]
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
  private closed: Promise<void>
  constructor() {
    this.child = spawn(process.env.FERN_SYNAPSE_PYTHON ?? 'python3', ['tests/integration/nio_peer.py'], {
      stdio: 'pipe',
    })
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
  command(action: string, values: Record<string, unknown> = {}) {
    const id = String(++this.nextId)
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Independent Matrix test client timed out.'))
      }, 45_000)
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
  // A real Vite-served document preserves loopback network permissions and
  // isolates the adapter from App.vue's automatic session restoration.
  await page.goto('http://127.0.0.1:5173/tests/integration/client.html')
  await page.evaluate(async () => {
    // @ts-expect-error This path is resolved by Vite in the browser.
    const { MatrixEngine } = await import('/src/sdk/engine.ts')
    const state: Window['matrixTest'] = { engine: undefined as unknown as MatrixEngine,
      accounts: {}, rooms: {}, messages: {}, typing: {}, errors: [], stops: [], verification: [] }
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

test('public directory, encrypted messaging and media use the live server', async ({ browser, request }) => {
  const ca = await browser.newContext()
  const cb = await browser.newContext()
  const pa = await ca.newPage()
  const pb = await cb.newPage()
  const nio = new NioPeer()
  let nioStarted = false
  try {
    await boot(pa); await boot(pb)
    const a = await login(pa, alice)
    const b = await login(pb, bob)
    await nio.command('start', { homeserver: fixture.base, username: reference.username, password: reference.password })
    nioStarted = true

    const independentRoom = await pa.evaluate(({ a, invite }) =>
      window.matrixTest.engine.createRoom(a, 'Independent E2EE fixture', 'Matrix-nio interoperability', invite),
    { a, invite: reference.userId })
    await watch(pa, a, independentRoom)
    await nio.command('join', { roomId: independentRoom })
    const nioText = 'Encrypted message from matrix-nio'
    const nioOriginal = await nio.command('send', { roomId: independentRoom, body: nioText })
    const nioOriginalOnFern = await findMessage(pa, a, independentRoom, nioText)
    const fernReply = 'Encrypted Fern reply to matrix-nio'
    await pa.evaluate(({ a, roomId, body, eventId }) => window.matrixTest.engine.send(a, roomId, body, eventId),
      { a, roomId: independentRoom, body: fernReply, eventId: nioOriginalOnFern.id })
    await nio.command('wait_text', { roomId: independentRoom, body: fernReply })
    const nioEdit = 'Encrypted matrix-nio edited message'
    await nio.command('edit', { roomId: independentRoom, body: nioEdit, eventId: nioOriginal.eventId })
    await expect.poll(() => pa.evaluate(({ a, roomId, body }) => window.matrixTest.messages[a + '/' + roomId]
      ?.some(message => message.body === body && message.edited), { a, roomId: independentRoom, body: nioEdit })).toBe(true)
    await nio.command('react', { roomId: independentRoom, eventId: nioOriginalOnFern.id, key: '🌿' })
    await expect.poll(() => pa.evaluate(({ a, roomId, eventId }) => window.matrixTest.messages[a + '/' + roomId]
      ?.find(message => message.id === eventId)?.reactions.find(reaction => reaction.key === '🌿')?.count ?? 0,
    { a, roomId: independentRoom, eventId: nioOriginalOnFern.id })).toBe(1)
    await pa.evaluate(({ a, roomId, eventId }) => window.matrixTest.engine.react(a, roomId, eventId, '🍃'),
      { a, roomId: independentRoom, eventId: nioOriginalOnFern.id })
    await nio.command('wait_reaction', { roomId: independentRoom, eventId: nioOriginal.eventId, key: '🍃' })
    const nioFile = [0x4e, 0x69, 0x6f, 0x00, 0x61, 0xff, 0x74, 0x74, 0x61, 0x63, 0x68]
    await nio.command('send_file', { roomId: independentRoom, name: 'nio-encrypted.bin', bytes: nioFile })
    await expect.poll(() => pa.evaluate(({ a, roomId }) => window.matrixTest.messages[a + '/' + roomId]
      ?.some(message => message.attachment?.name === 'nio-encrypted.bin') ?? false, { a, roomId: independentRoom })).toBe(true)
    const nioMedia = await pa.evaluate(({ a, roomId }) => window.matrixTest.messages[a + '/' + roomId]!
      .find(message => message.attachment?.name === 'nio-encrypted.bin')!, { a, roomId: independentRoom })
    const nioDownloaded = await pa.evaluate(async ({ a, roomId, message }) => {
      const url = await window.matrixTest.engine.download(a, roomId, message)
      return [...new Uint8Array(await (await fetch(url)).arrayBuffer())]
    }, { a, roomId: independentRoom, message: nioMedia })
    expect(nioDownloaded).toEqual(nioFile)
    const fernText = 'Encrypted message to matrix-nio'
    await pa.evaluate(({ a, roomId, body }) => window.matrixTest.engine.send(a, roomId, body),
      { a, roomId: independentRoom, body: fernText })
    const fernOriginal = await findMessage(pa, a, independentRoom, fernText)
    const nioReceived = await nio.command('wait_text', { roomId: independentRoom, body: fernText })
    expect(nioReceived.decrypted).toBe(true)
    const fernFile = [0x46, 0x65, 0x72, 0x6e, 0x00, 0xfe, 0x6d, 0x65, 0x64, 0x69, 0x61]
    await pa.evaluate(({ a, roomId, bytes }) => window.matrixTest.engine.upload(a, roomId,
      new File([new Uint8Array(bytes)], 'fern-encrypted.bin', { type: 'application/octet-stream' })),
    { a, roomId: independentRoom, bytes: fernFile })
    const nioMediaReceived = await nio.command('wait_file', { roomId: independentRoom, name: 'fern-encrypted.bin' })
    expect(nioMediaReceived.decrypted).toBe(true)
    expect(nioMediaReceived.bytes).toBe(btoa(String.fromCharCode(...fernFile)))
    const interopEvents = await matrix(request, alice, 'GET', `/rooms/${encodeURIComponent(independentRoom)}/messages?dir=b&limit=20`)
    const interopCiphertext = (interopEvents.chunk as { type: string; content: Record<string, unknown> }[])
      .filter(event => event.type === 'm.room.encrypted')
    expect(interopCiphertext.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(interopCiphertext)).not.toContain(nioText)
    expect(JSON.stringify(interopCiphertext)).not.toContain(fernText)

    const { room_id: publicId } = await matrix(request, reference, 'POST', '/createRoom', {
      name: 'Fern discovery fixture', visibility: 'public', preset: 'public_chat',
    })
    await pa.evaluate(async a => {
      let found: string[] = []
      const search = await window.matrixTest.engine.searchDirectory(a, 'Fern discovery fixture', rooms => { found = rooms.map(room => room.id) })
      // Store the callback result for polling without exposing SDK objects across the browser boundary.
      Object.defineProperty(window, 'directoryTestIds', { get: () => found, configurable: true })
      window.matrixTest.stops.push(search.stop)
    }, a)
    await expect.poll(() => pa.evaluate(() => window.directoryTestIds)).toContain(publicId)

    const dm = await pa.evaluate(({ a, invite }) => window.matrixTest.engine.createRoom(a, 'Encrypted DM fixture', 'Live integration', invite),
      { a, invite: bob.userId })
    await expect.poll(() => pa.evaluate(({ a, dm }) => window.matrixTest.rooms[a]?.find(room => room.id === dm)?.encrypted, { a, dm })).toBe(true)
    await expect.poll(() => pb.evaluate(({ b, dm }) => window.matrixTest.rooms[b]?.find(room => room.id === dm)?.membership, { b, dm })).toBe('invited')
    await pb.evaluate(({ b, dm }) => window.matrixTest.engine.join(b, dm), { b, dm })
    await watch(pa, a, dm); await watch(pb, b, dm)
    const members = await pa.evaluate(({ a, dm }) => window.matrixTest.engine.members(a, dm), { a, dm })
    expect(members.map(member => member.id).sort()).toEqual([alice.userId, bob.userId].sort())

    const secretText = 'Fern encrypted interoperability message'
    await pa.evaluate(({ a, dm, secretText }) => window.matrixTest.engine.send(a, dm, secretText), { a, dm, secretText })
    const original = await findMessage(pb, b, dm, secretText)
    await findMessage(pa, a, dm, secretText)

    // Read the real server event as the sender. The room timeline must contain
    // ciphertext, and the message body must not appear in the homeserver event.
    const raw = await matrix(request, alice, 'GET', `/rooms/${encodeURIComponent(dm)}/messages?dir=b&limit=30`)
    const encrypted = raw.chunk.find((event: { type: string; content: Record<string, unknown> }) =>
      event.type === 'm.room.encrypted' && !('body' in event.content))
    expect(encrypted).toBeTruthy()
    expect(JSON.stringify(encrypted)).not.toContain(secretText)

    await pb.evaluate(({ b, dm, eventId }) => window.matrixTest.engine.send(b, dm, 'Encrypted reply', eventId),
      { b, dm, eventId: original.id })
    const reply = await findMessage(pa, a, dm, 'Encrypted reply')
    expect(reply.replyId).toBe(original.id)
    await pa.evaluate(({ a, dm, eventId }) => window.matrixTest.engine.send(a, dm, 'Encrypted edited message', undefined, eventId),
      { a, dm, eventId: original.id })
    const edited = await findMessage(pb, b, dm, 'Encrypted edited message')
    expect(edited.edited).toBe(true)
    await pb.evaluate(({ b, dm, eventId }) => window.matrixTest.engine.react(b, dm, eventId, '🔐'),
      { b, dm, eventId: original.id })
    await expect.poll(() => pa.evaluate(({ a, dm, eventId }) =>
      window.matrixTest.messages[a + '/' + dm]?.find(message => message.id === eventId)?.reactions.find(reaction => reaction.key === '🔐')?.count,
    { a, dm, eventId: original.id })).toBe(1)

    const attachment = new Uint8Array([0x46, 0x65, 0x72, 0x6e, 0x00, 0xff, 0x45, 0x32, 0x45, 0x45])
    await pa.evaluate(({ a, dm, attachment }) => {
      const file = new File([new Uint8Array(attachment)], 'private-note.bin', { type: 'application/octet-stream' })
      return window.matrixTest.engine.upload(a, dm, file)
    }, { a, dm, attachment: Array.from(attachment) })
    await expect.poll(() => pb.evaluate(({ b, dm }) => window.matrixTest.messages[b + '/' + dm]?.some(message =>
      message.attachment?.name === 'private-note.bin'), { b, dm })).toBe(true)
    const mediaMessage = await pb.evaluate(({ b, dm }) => window.matrixTest.messages[b + '/' + dm]!
      .find(message => message.attachment?.name === 'private-note.bin')!, { b, dm })
    const downloaded = await pb.evaluate(async ({ b, dm, mediaMessage }) => {
      const url = await window.matrixTest.engine.download(b, dm, mediaMessage)
      return [...new Uint8Array(await (await fetch(url)).arrayBuffer())]
    }, { b, dm, mediaMessage })
    expect(downloaded).toEqual(Array.from(attachment))

    const afterMedia = await matrix(request, alice, 'GET', `/rooms/${encodeURIComponent(dm)}/messages?dir=b&limit=30`)
    const rawEvents = afterMedia.chunk as { type: string; content: Record<string, unknown> }[]
    expect(rawEvents.some(event => event.type === 'm.room.encrypted' && !('body' in event.content))).toBe(true)
    expect(JSON.stringify(rawEvents)).not.toContain('private-note.bin')
    expect(JSON.stringify(rawEvents)).not.toContain(Array.from(attachment).join(','))

    // Establish recovery only once, reject silently replacing an existing
    // server backup, then restore the encrypted history on a fresh device.
    const recoveryKey = await pa.evaluate(({ a }) => window.matrixTest.engine.enableRecovery(a, () => {}), { a })
    expect(recoveryKey).toBeTruthy()
    const unavailableBackup = await pb.evaluate(async ({ b, recoveryKey }) => {
      try { await window.matrixTest.engine.recover(b, recoveryKey); return '' }
      catch (error) { return error instanceof Error ? error.message : String(error) }
    }, { b, recoveryKey })
    expect(unavailableBackup).toBeTruthy()
    const backupGuard = await pa.evaluate(async ({ a }) => {
      try { await window.matrixTest.engine.enableRecovery(a, () => {}); return '' }
      catch (error) { return error instanceof Error ? error.message : String(error) }
    }, { a })
    expect(backupGuard).toContain('already has a backup')

    const cc = await browser.newContext()
    const pc = await cc.newPage()
    try {
      await boot(pc)
      const restored = await login(pc, alice)
      await expect.poll(() => pc.evaluate(id => window.matrixTest.accounts[id]?.connection, restored)).toBe('online')
      await watch(pc, restored, dm)
      await expect.poll(() => pc.evaluate(({ restored, dm }) => window.matrixTest.messages[restored + '/' + dm]
        ?.some(message => message.body.includes('Unable to decrypt')) ?? false, { restored, dm })).toBe(true)
      const rejectedKey = await pc.evaluate(async restored => {
        try { await window.matrixTest.engine.recover(restored, 'not a valid recovery key'); return false }
        catch { return true }
      }, restored)
      expect(rejectedKey).toBe(true)
      await pc.evaluate(({ restored, recoveryKey }) => window.matrixTest.engine.recover(restored, recoveryKey), { restored, recoveryKey })
      await expect.poll(() => pc.evaluate(({ restored, dm }) => window.matrixTest.rooms[restored]?.some(room => room.id === dm && room.membership === 'joined'), { restored, dm })).toBe(true)
      await watch(pc, restored, dm)
      await findMessage(pc, restored, dm, 'Encrypted edited message')
      const restoredMedia = await pc.evaluate(({ restored, dm }) => window.matrixTest.messages[restored + '/' + dm]?.some(message =>
        message.attachment?.name === 'private-note.bin'), { restored, dm })
      expect(restoredMedia).toBe(true)
    } finally {
      await pc.evaluate(async () => { window.matrixTest?.stops.forEach(stop => stop()); await window.matrixTest?.engine.dispose() }).catch(() => {})
      await cc.close()
    }
  } finally {
    if (nioStarted) await nio.stop().catch(() => {})
    for (const page of [pa, pb]) {
      await page.evaluate(async () => { window.matrixTest?.stops.forEach(stop => stop()); await window.matrixTest?.engine.dispose() }).catch(() => {})
    }
    await ca.close(); await cb.close()
  }
})

test('same-account device verification accepts and compares SAS on both devices', async ({ browser }) => {
  const ca = await browser.newContext()
  const cb = await browser.newContext()
  const pa = await ca.newPage()
  const pb = await cb.newPage()
  try {
    await boot(pa); await boot(pb)
    const a = await login(pa, alice)
    const b = await login(pb, alice)
    await expect.poll(() => pa.evaluate(a => window.matrixTest.accounts[a]?.connection, a)).toBe('online')
    await expect.poll(() => pb.evaluate(b => window.matrixTest.accounts[b]?.connection, b)).toBe('online')
    await expect.poll(() => pb.evaluate(async b => {
      try { await window.matrixTest.engine.listenForVerificationRequests(b, value => window.matrixTest.verification.push(value)); return true }
      catch { return false }
    }, b), { timeout: 30_000 }).toBe(true)
    await expect.poll(() => pa.evaluate(async a => {
      try { await window.matrixTest.engine.listenForVerificationRequests(a, value => window.matrixTest.verification.push(value)); return true }
      catch { return false }
    }, a), { timeout: 30_000 }).toBe(true)
    await pa.evaluate(a => window.matrixTest.engine.startVerification(a, value => window.matrixTest.verification.push(value)), a)
    await expect.poll(() => pb.evaluate(() => window.matrixTest.verification.map(value => value.status))).toContain('incoming')
    await pb.evaluate(b => window.matrixTest.engine.cancelVerification(b), b)
    await expect.poll(() => pa.evaluate(() => window.matrixTest.verification.some(value => value.status === 'canceled' || value.status === 'failed'))).toBe(true)
    await expect.poll(() => pb.evaluate(() => window.matrixTest.verification.some(value => value.status === 'canceled' || value.status === 'failed'))).toBe(true)

    await expect.poll(() => pb.evaluate(async b => {
      try { await window.matrixTest.engine.listenForVerificationRequests(b, value => window.matrixTest.verification.push(value)); return true }
      catch { return false }
    }, b), { timeout: 30_000 }).toBe(true)
    await expect.poll(() => pa.evaluate(async a => {
      try { await window.matrixTest.engine.listenForVerificationRequests(a, value => window.matrixTest.verification.push(value)); return true }
      catch { return false }
    }, a), { timeout: 30_000 }).toBe(true)
    await pa.evaluate(a => window.matrixTest.engine.startVerification(a, value => window.matrixTest.verification.push(value)), a)
    await expect.poll(() => pb.evaluate(() => window.matrixTest.verification.filter(value => value.status === 'incoming').length)).toBeGreaterThan(1)
    await pb.evaluate(b => window.matrixTest.engine.acceptVerificationRequest(b), b)
    await expect.poll(() => pa.evaluate(() => window.matrixTest.verification.some(value => value.status === 'compare'))).toBe(true)
    await expect.poll(() => pb.evaluate(() => window.matrixTest.verification.some(value => value.status === 'compare'))).toBe(true)
    const aSas = await pa.evaluate(() => window.matrixTest.verification.findLast(value => value.status === 'compare'))
    const bSas = await pb.evaluate(() => window.matrixTest.verification.findLast(value => value.status === 'compare'))
    expect(aSas?.emojis ?? aSas?.numbers).toEqual(bSas?.emojis ?? bSas?.numbers)
    await pa.evaluate(a => window.matrixTest.engine.finishVerification(a, true), a)
    await pb.evaluate(b => window.matrixTest.engine.finishVerification(b, true), b)
    await expect.poll(() => pa.evaluate(() => window.matrixTest.verification.some(value => value.status === 'verified'))).toBe(true)
    await expect.poll(() => pb.evaluate(() => window.matrixTest.verification.some(value => value.status === 'verified'))).toBe(true)
  } finally {
    for (const page of [pa, pb]) await page.evaluate(async () => { await window.matrixTest?.engine.dispose() }).catch(() => {})
    await ca.close(); await cb.close()
  }
})

test('same-account device verification can reject a SAS comparison', async ({ browser }) => {
  const ca = await browser.newContext()
  const cb = await browser.newContext()
  const pa = await ca.newPage()
  const pb = await cb.newPage()
  try {
    await boot(pa); await boot(pb)
    const a = await login(pa, alice)
    const b = await login(pb, alice)
    await expect.poll(() => pa.evaluate(a => window.matrixTest.accounts[a]?.connection, a)).toBe('online')
    await expect.poll(() => pb.evaluate(b => window.matrixTest.accounts[b]?.connection, b)).toBe('online')
    await expect.poll(() => pb.evaluate(async b => {
      try { await window.matrixTest.engine.listenForVerificationRequests(b, value => window.matrixTest.verification.push(value)); return true }
      catch { return false }
    }, b), { timeout: 30_000 }).toBe(true)
    await expect.poll(() => pa.evaluate(async a => {
      try { await window.matrixTest.engine.listenForVerificationRequests(a, value => window.matrixTest.verification.push(value)); return true }
      catch { return false }
    }, a), { timeout: 30_000 }).toBe(true)
    await pa.evaluate(a => window.matrixTest.engine.startVerification(a, value => window.matrixTest.verification.push(value)), a)
    await expect.poll(() => pb.evaluate(() => window.matrixTest.verification.some(value => value.status === 'incoming'))).toBe(true)
    await pb.evaluate(b => window.matrixTest.engine.acceptVerificationRequest(b), b)
    await expect.poll(() => pa.evaluate(() => window.matrixTest.verification.some(value => value.status === 'compare'))).toBe(true)
    await expect.poll(() => pb.evaluate(() => window.matrixTest.verification.some(value => value.status === 'compare'))).toBe(true)
    const aSas = await pa.evaluate(() => window.matrixTest.verification.findLast(value => value.status === 'compare'))
    const bSas = await pb.evaluate(() => window.matrixTest.verification.findLast(value => value.status === 'compare'))
    expect(aSas?.emojis ?? aSas?.numbers).toEqual(bSas?.emojis ?? bSas?.numbers)
    await pb.evaluate(b => window.matrixTest.engine.finishVerification(b, false), b)
    await expect.poll(() => pa.evaluate(() => window.matrixTest.verification.some(value => value.status === 'canceled' || value.status === 'failed'))).toBe(true)
    await expect.poll(() => pb.evaluate(() => window.matrixTest.verification.some(value => value.status === 'canceled' || value.status === 'failed'))).toBe(true)
  } finally {
    for (const page of [pa, pb]) await page.evaluate(async () => { await window.matrixTest?.engine.dispose() }).catch(() => {})
    await ca.close(); await cb.close()
  }
})
