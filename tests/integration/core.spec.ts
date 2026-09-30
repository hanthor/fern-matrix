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
const [alice, bob, reference, adminUser] = fixture.users

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
async function admin(request: APIRequestContext, method: string, path: string, data?: unknown) {
  const response = await request.fetch(fixture.base + '/_synapse/admin' + path, {
    method, headers: { Authorization: 'Bearer ' + adminUser.token }, data,
  })
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

test('login discovery reports password-only flows and SSO starts fail actionably', async ({ page }) => {
  await boot(page)
  const methods = await page.evaluate(base => window.matrixTest.engine.loginMethods(base), fixture.base)
  expect(methods).toEqual({ password: true, sso: false, oidc: false })
  // Modern OIDC refuses to start without an authentication issuer, while
  // legacy SSO only builds its redirect URL up front. Either way a bogus
  // callback fails actionably and nothing is persisted.
  const oidcOutcome = await page.evaluate(async base => {
    try {
      await window.matrixTest.engine.startOidcLogin(base, 'https://app.example/oidc-callback.html')
      return 'started'
    } catch (error) { return error instanceof Error ? error.message : String(error) }
  }, fixture.base)
  expect(oidcOutcome).toContain("doesn't provide an authentication issuer")
  const sso = await page.evaluate(base => window.matrixTest.engine.startSsoLogin(base, 'https://app.example/oidc-callback.html'), fixture.base)
  expect(sso.url).toContain('/login/sso/redirect')
  const ssoOutcome = await page.evaluate(async flowId => {
    try {
      await window.matrixTest.engine.finishSsoLogin(flowId, 'https://app.example/oidc-callback.html?loginToken=bogus')
      return 'finished'
    } catch (error) { return error instanceof Error ? error.message : String(error) }
  }, sso.flowId)
  expect(ssoOutcome).not.toBe('finished')
  expect(ssoOutcome.length > 0).toBe(true)
  // Refused and bogus flows persist no credentials. Their temporary stores
  // are deletion-requested on every terminal path; physical unlinking follows
  // connection release (proven end to end by the account-removal test) rather
  // than a fixed delay, so only the synchronous guarantee is asserted here.
  expect(Object.keys(JSON.parse(await page.evaluate(() => localStorage.getItem('fern.sessions.v1') ?? '{}')))).toEqual([])
  await page.evaluate(() => window.matrixTest.engine.dispose())
})

test('removing one account erases only its data and blocks stale restore', async ({ browser }) => {
  const context = await browser.newContext()
  const pa = await context.newPage()
  const databases = (page: Page) => page.evaluate(async () => (await indexedDB.databases()).map(db => db.name))
  // The SDK's IndexedDB connections die with their page, so database unlinks
  // are observed from a second page sharing this context's storage. Re-issuing
  // a delete is idempotent: it only hurries what removal already requested.
  async function expectUnlinked(page: Page, id: string) {
    for (const suffix of ['', '::matrix-sdk-crypto', '::matrix-sdk-state']) {
      await page.evaluate(name => new Promise<void>(resolve => {
        const request = indexedDB.deleteDatabase(name)
        request.onsuccess = request.onerror = request.onblocked = () => resolve()
      }), `fern-${id}${suffix}`)
    }
    await expect.poll(() => page.evaluate(async (wanted: string) =>
      (await indexedDB.databases()).every(db => !db.name?.includes(wanted)), id)).toBe(true)
  }
  await boot(pa)
  const a = await login(pa, alice)
  const b = await login(pa, bob)
  await expect.poll(() => pa.evaluate(() => Object.values(window.matrixTest.accounts).filter(account => account.connection === 'online').length)).toBe(2)
  // Simulate the per-room drafts App.vue persists under the engine-owned prefix.
  await pa.evaluate(([a, b]) => {
    localStorage.setItem(`fern.draft.${a}/!room:x`, 'unsent words A')
    localStorage.setItem(`fern.draft.${b}/!room:x`, 'unsent words B')
  }, [a, b])
  expect((await databases(pa)).some(name => name?.includes(a))).toBe(true)
  expect((await databases(pa)).some(name => name?.includes(b))).toBe(true)
  // Local-only removal contacts no server and is idempotent. Credentials,
  // drafts and handles are erased synchronously.
  await pa.evaluate(a => window.matrixTest.engine.removeAccount(a), a)
  await pa.evaluate(a => window.matrixTest.engine.removeAccount(a), a)
  expect(Object.keys(JSON.parse(await pa.evaluate(() => localStorage.getItem('fern.sessions.v1')!)))).toEqual([b])
  expect(await pa.evaluate(a => localStorage.getItem(`fern.draft.${a}/!room:x`), a)).toBeNull()
  expect(await pa.evaluate(b => localStorage.getItem(`fern.draft.${b}/!room:x`), b)).toBe('unsent words B')
  await expect.poll(() => pa.evaluate(async id => {
    try { window.matrixTest.engine.getClient(id); return false } catch { return true }
  }, a)).toBe(true)
  const pb = await context.newPage()
  await boot(pb)
  await pa.close()
  await expectUnlinked(pb, a)
  expect((await databases(pb)).some(name => name?.includes(b))).toBe(true)
  // A fresh engine restoring from the remaining sessions never resurrects
  // the removed account: its credentials are gone, so the keychain delegate
  // cannot supply a session for it.
  await pb.evaluate(() => window.matrixTest.engine.restoreAll())
  await expect.poll(() => pb.evaluate(() => Object.values(window.matrixTest.accounts).filter(account => account.connection === 'online').length)).toBe(1)
  expect(await pb.evaluate(() => Object.values(window.matrixTest.accounts).map(account => account.userId))).toEqual([bob.userId])
  // Sign-out revokes the server session and erases the local account too.
  const revoked = await pb.evaluate(b => window.matrixTest.engine.logout(b), b)
  expect(revoked.serverRevoked).toBe(true)
  expect(Object.keys(JSON.parse(await pb.evaluate(() => localStorage.getItem('fern.sessions.v1') ?? '{}')))).toEqual([])
  expect(await pb.evaluate(b => localStorage.getItem(`fern.draft.${b}/!room:x`), b)).toBeNull()
  await expect.poll(() => pb.evaluate(async id => {
    try { window.matrixTest.engine.getClient(id); return false } catch { return true }
  }, b)).toBe(true)
  const pc = await context.newPage()
  await boot(pc)
  await pb.close()
  await expectUnlinked(pc, b)
  await pc.evaluate(() => window.matrixTest.engine.dispose())
  await pc.close()
  await context.close()
})

test('offline sends queue, discard drops, and reconnect delivers once', async ({ browser, request }) => {
  // Chromium's offline emulation does not block loopback, so the dead server
  // is simulated with a TCP proxy that can drop all upstream connections.
  const target = new URL(fixture.base)
  const sockets = new Set<import('node:net').Socket>()
  const { createServer, connect } = await import('node:net')
  const serve = () => createServer(client => {
    sockets.add(client)
    const upstream = connect(Number(target.port), '127.0.0.1')
    client.on('error', () => {}); upstream.on('error', () => {})
    client.pipe(upstream); upstream.pipe(client)
    const drop = () => { sockets.delete(client); try { upstream.destroy() } catch { /* Closed */ } }
    client.on('close', drop); upstream.on('close', drop)
  })
  let proxy = serve()
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const proxyPort = (proxy.address() as import('node:net').AddressInfo).port
  const viaProxy = `http://127.0.0.1:${proxyPort}`
  const blackout = async () => {
    // Destroy live sockets first: the sliding-sync long-poll would otherwise
    // keep server.close() waiting for its full timeout.
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    await new Promise<void>(resolve => proxy.close(() => resolve()))
  }
  const restore = async () => {
    proxy = serve()
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject)
      proxy.listen(proxyPort, '127.0.0.1', () => { proxy.off('error', reject); resolve() })
    })
  }
  const ca = await browser.newContext()
  const cb = await browser.newContext()
  const pa = await ca.newPage()
  const pb = await cb.newPage()
  try {
    await boot(pa); await boot(pb)
    const loginVia = async (page: Page, user: FixtureUser) => page.evaluate(({ base, username, password }) =>
      window.matrixTest.engine.login(base, username, password),
    { base: viaProxy, username: user.username, password: user.password })
    const a = await loginVia(pa, alice)
    const b = await login(pb, bob)
    const { room_id: roomId } = await matrix(request, reference, 'POST', '/createRoom', {
      name: 'Offline queue fixture', visibility: 'public', preset: 'public_chat',
      invite: [alice.userId, bob.userId],
    })
    for (const [p, id] of [[pa, a], [pb, b]] as const) {
      await expect.poll(() => p.evaluate(({ id, roomId }) => window.matrixTest.rooms[id]?.find(r => r.id === roomId)?.membership,
        { id, roomId })).toBe('invited')
      await p.evaluate(({ id, roomId }) => window.matrixTest.engine.join(id, roomId), { id, roomId })
      await watch(p, id, roomId)
    }
    await blackout()
    // NOTE: the sync-service state stays 'online' through the blackout (the
    // SDK retries internally without flipping its service state), so downtime
    // status is asserted only on the send queue below. See issue #8.
    try {
      await pa.evaluate(({ a, roomId }) => window.matrixTest.engine.send(a, roomId, 'Queued while offline'), { a, roomId })
      // The local echo stays pending while the network is down.
      await expect.poll(() => pa.evaluate(({ a, roomId }) => window.matrixTest.messages[a + '/' + roomId]
        ?.some(message => message.body === 'Queued while offline' && message.status === 'sending') ?? false,
      { a, roomId })).toBe(true)
      // A queued echo can be discarded before it ever leaves the device.
      await pa.evaluate(({ a, roomId }) => window.matrixTest.engine.send(a, roomId, 'Discarded while offline'), { a, roomId })
      await expect.poll(() => pa.evaluate(({ a, roomId }) => window.matrixTest.messages[a + '/' + roomId]
        ?.some(message => message.body === 'Discarded while offline') ?? false, { a, roomId })).toBe(true)
      const discarded = await pa.evaluate(({ a, roomId }) => window.matrixTest.messages[a + '/' + roomId]!
        .find(message => message.body === 'Discarded while offline')!, { a, roomId })
      await pa.evaluate(({ a, roomId, messageId }) => window.matrixTest.engine.discardSend(a, roomId, messageId),
        { a, roomId, messageId: discarded.id })
      await expect.poll(() => pa.evaluate(({ a, roomId }) => window.matrixTest.messages[a + '/' + roomId]
        ?.some(message => message.body === 'Discarded while offline' && message.status === 'sending') ?? false,
      { a, roomId })).toBe(false)
    } finally {
      await restore()
    }
    // Reconnect flushes the queue: the kept message arrives, the discarded
    // one never does, and the flush delivers exactly once.
    await findMessage(pb, b, roomId, 'Queued while offline')
    await pb.waitForTimeout(5000)
    const deliveries = await pb.evaluate(({ b, roomId }) => window.matrixTest.messages[b + '/' + roomId]
      ?.filter(message => message.body === 'Queued while offline').length ?? 0, { b, roomId })
    expect(deliveries).toBe(1)
    expect(await pb.evaluate(({ b, roomId }) => window.matrixTest.messages[b + '/' + roomId]
      ?.some(message => message.body === 'Discarded while offline') ?? false, { b, roomId })).toBe(false)
  } finally {
    for (const p of [pa, pb]) {
      await p.evaluate(async () => { window.matrixTest?.stops.forEach(stop => stop()); await window.matrixTest?.engine.dispose() }).catch(() => {})
    }
    await ca.close(); await cb.close()
    await new Promise<void>(resolve => proxy.close(() => resolve()))
    for (const socket of sockets) socket.destroy()
  }
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
    const fernFormatted = `Formatted **bold** hello [${reference.userId}](https://matrix.to/#/${reference.userId}) @room`
    await pa.evaluate(({ a, roomId, body }) => window.matrixTest.engine.send(a, roomId, body),
      { a, roomId: independentRoom, body: fernFormatted })
    const nioFormatted = await nio.command('wait_formatted', { roomId: independentRoom, body: fernFormatted })
    expect(nioFormatted.decrypted).toBe(true)
    expect(nioFormatted.format).toBe('org.matrix.custom.html')
    expect(nioFormatted.formattedBody).toContain('<strong>bold</strong>')
    expect(nioFormatted.formattedBody).toContain(`<a href="https://matrix.to/#/${reference.userId}">`)
    expect(nioFormatted.mentions).toEqual({ user_ids: [reference.userId], room: true })
    const nioHostileBody = 'Hostile formatted message from matrix-nio'
    await nio.command('send', { roomId: independentRoom, body: nioHostileBody,
      formatted: '<em>italic</em><img src="x" onerror="alert(1)"><script>alert(1)</script>',
      mentions: { user_ids: [alice.userId], room: false } })
    const hostileOnFern = await findMessage(pa, a, independentRoom, nioHostileBody)
    // This SDK's timeline items expose only the plain-text fallback, so the
    // hostile HTML never reaches Fern's renderer; sanitizeHtml still guards
    // composed and future formatted bodies (see tests/format.test.ts).
    expect(hostileOnFern.formattedBody).toBeUndefined()
    const fernFile = [0x46, 0x65, 0x72, 0x6e, 0x00, 0xfe, 0x6d, 0x65, 0x64, 0x69, 0x61]
    await pa.evaluate(({ a, roomId, bytes }) => window.matrixTest.engine.upload(a, roomId,
      new File([new Uint8Array(bytes)], 'fern-encrypted.bin', { type: 'application/octet-stream' })).then(operation => operation.done),
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
    // Both devices are fresh and unverified, so the SDK must flag the
    // encrypted message's authenticity shield on the receiving timeline.
    expect(['red', 'grey']).toContain(original.shield?.level)
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
      return window.matrixTest.engine.upload(a, dm, file).then(operation => operation.done)
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
      // Rotating the backup key after explicit confirmation yields a fresh,
      // different recovery key; the old key is superseded, never silently
      // replaced without the caller's deliberate reset.
      const rotatedKey = await pa.evaluate(({ a }) => window.matrixTest.engine.resetRecovery(a), { a })
      expect(rotatedKey).toBeTruthy()
      expect(rotatedKey).not.toBe(recoveryKey)
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

test('unanswered verification request stays pending, cancels cleanly and allows retry', async ({ browser }) => {
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
    // The protocol timeout is on the order of minutes, so an unanswered
    // request must stay non-terminal over a short quiescence window: neither
    // side may fail it prematurely.
    const terminal = () => pa.evaluate(() => window.matrixTest.verification
      .filter(value => ['verified', 'canceled', 'failed'].includes(value.status)).length)
    const before = await terminal()
    await pa.waitForTimeout(10_000)
    expect(await terminal()).toBe(before)
    // Abandoning the request surfaces a terminal status on the requesting
    // device and releases the controller, so a fresh request works
    // afterwards — the same recovery path a real protocol timeout takes
    // through didCancel(). The SDK only watches a request for changes after
    // it is acknowledged, so the silent receiver correctly sees no terminal
    // update for a flow it never engaged with.
    await pa.evaluate(a => window.matrixTest.engine.cancelVerification(a), a)
    await expect.poll(() => pa.evaluate(() => window.matrixTest.verification.some(value => value.status === 'canceled'))).toBe(true)
    await pb.waitForTimeout(5_000)
    expect(await pb.evaluate(() => window.matrixTest.verification
      .filter(value => ['verified', 'canceled', 'failed'].includes(value.status)).length)).toBe(0)
    await expect.poll(() => pb.evaluate(async b => {
      try { await window.matrixTest.engine.listenForVerificationRequests(b, value => window.matrixTest.verification.push(value)); return true }
      catch { return false }
    }, b), { timeout: 30_000 }).toBe(true)
    await pa.evaluate(a => window.matrixTest.engine.startVerification(a, value => window.matrixTest.verification.push(value)), a)
    await expect.poll(() => pb.evaluate(() => window.matrixTest.verification.filter(value => value.status === 'incoming').length)).toBeGreaterThan(1)
    await pa.evaluate(a => window.matrixTest.engine.cancelVerification(a), a)
    await expect.poll(() => pa.evaluate(() => window.matrixTest.verification
      .filter(value => value.status === 'canceled').length)).toBeGreaterThan(1)
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

test('profile avatar upload is served to other clients', async ({ page, request }) => {
  await boot(page)
  const a = await login(page, alice)
  // Canonical 1x1 transparent PNG.
  const png = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
    8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5, 0, 1,
    13, 10, 45, 180, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]
  await page.evaluate(({ a, bytes }) => window.matrixTest.engine.uploadAvatar(a, 'image/png', new Uint8Array(bytes).buffer),
    { a, bytes: png })
  const profile = await matrix(request, reference, 'GET', `/profile/${encodeURIComponent(alice.userId)}/avatar_url`)
  expect(profile.avatar_url).toMatch(/^mxc:\/\//)
  await page.evaluate(() => window.matrixTest.engine.dispose())
})

test('profile pictures are retrievable by another client', async ({ browser }) => {
  const ca = await browser.newContext()
  const cb = await browser.newContext()
  const pa = await ca.newPage()
  const pb = await cb.newPage()
  try {
    await boot(pa); await boot(pb)
    const a = await login(pa, alice)
    const b = await login(pb, bob)
    // Canonical 1x1 transparent PNG.
    const png = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
      8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5, 0, 1,
      13, 10, 45, 180, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]
    await pa.evaluate(({ a, bytes }) => window.matrixTest.engine.uploadAvatar(a, 'image/png', new Uint8Array(bytes).buffer),
      { a, bytes: png })
    // Bob retrieves Alice's picture from his own client — the production
    // path behind every avatar in the timeline — polling for federation.
    const seen = await pb.evaluate(async ({ b, userId }) => {
      for (let round = 0; round < 60; round++) {
        const url = await window.matrixTest.engine.profileAvatar(b, userId).catch(() => undefined)
        if (url) return url
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      return undefined
    }, { b, userId: alice.userId })
    expect(seen).toMatch(/^blob:/)
    const retrieved = await pb.evaluate(async url => [...new Uint8Array(await (await fetch(url!)).arrayBuffer())], seen)
    expect(retrieved).toEqual(png)
    // A user with no picture resolves undefined instead of failing.
    expect(await pb.evaluate(({ b, userId }) => window.matrixTest.engine.profileAvatar(b, userId), { b, userId: bob.userId }))
      .toBeUndefined()
  } finally {
    await pa.evaluate(async () => { await window.matrixTest?.engine.dispose() }).catch(() => {})
    await pb.evaluate(async () => { await window.matrixTest?.engine.dispose() }).catch(() => {})
    await ca.close(); await cb.close()
  }
})

test('server-side session invalidation surfaces expiry and sign-in recovers', async ({ page, request }) => {
  await boot(page)
  const a = await login(page, alice)
  await expect.poll(() => page.evaluate(a => window.matrixTest.accounts[a]?.connection, a)).toBe('online')
  const deviceId = await page.evaluate(a => window.matrixTest.engine.security(a).then(security => security.deviceId), a)
  await admin(request, 'DELETE', `/v2/users/${encodeURIComponent(alice.userId)}/devices/${encodeURIComponent(deviceId)}`)
  await expect.poll(() => page.evaluate(a => window.matrixTest.accounts[a]?.connection, a), { timeout: 60_000 }).toBe('error')
  expect(await page.evaluate(a => window.matrixTest.accounts[a]?.error, a)).toContain('Session expired')
  const fresh = await login(page, alice)
  await expect.poll(() => page.evaluate(id => window.matrixTest.accounts[id]?.connection, fresh)).toBe('online')
  await page.evaluate(() => window.matrixTest.engine.dispose())
})

test('authenticated avatars, image metadata and media safety use the live server', async ({ browser, request }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const nio = new NioPeer()
  let nioStarted = false
  try {
    await boot(page)
    const a = await login(page, alice)
    // Canonical 1x1 transparent PNG, reused for avatar and image uploads.
    const png = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
      8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5, 0, 1,
      13, 10, 45, 180, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]
    await page.evaluate(({ a, bytes }) => window.matrixTest.engine.uploadAvatar(a, 'image/png', new Uint8Array(bytes).buffer),
      { a, bytes: png })
    const avatarUrl = await page.evaluate(({ a, userId }) => window.matrixTest.engine.profileAvatar(a, userId),
      { a, userId: alice.userId })
    expect(avatarUrl).toMatch(/^blob:/)
    const avatarBytes = await page.evaluate(async url => [...new Uint8Array(await (await fetch(url!)).arrayBuffer())], avatarUrl)
    expect(avatarBytes).toEqual(png)
    await nio.command('start', { homeserver: fixture.base, username: reference.username, password: reference.password })
    nioStarted = true
    const roomId = await page.evaluate(({ a, invite }) =>
      window.matrixTest.engine.createRoom(a, 'Media fixture', 'thumbnails and safety', invite),
    { a, invite: reference.userId })
    await watch(page, a, roomId)
    await nio.command('join', { roomId })
    const bigPng = await page.evaluate(async bytes => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
      const canvas = document.createElement('canvas')
      canvas.width = 64; canvas.height = 64
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, 64, 64)
      bitmap.close()
      return [...new Uint8Array(await (await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png')))! .arrayBuffer())]
    }, png)
    await page.evaluate(({ a, roomId, bytes }) => window.matrixTest.engine.upload(a, roomId,
      new File([new Uint8Array(bytes)], 'fern-photo.png', { type: 'image/png' })).then(operation => operation.done),
    { a, roomId, bytes: bigPng })
    const received = await nio.command('wait_image', { roomId, name: 'fern-photo.png' })
    expect(received.decrypted).toBe(true)
    expect(received.bytes).toBe(btoa(String.fromCharCode(...bigPng)))
    const info = received.info as { mimetype?: string; thumbnail_info?: unknown } | undefined
    expect(info?.mimetype).toBe('image/png')
    // No thumbnail_info: sendImage rejects in this SDK build and plaintext
    // thumbnail URLs would leak image content in encrypted rooms.
    expect(info?.thumbnail_info).toBeFalsy()
    // Unsupported content downloads as bytes, never as an executable document.
    const html = [...new TextEncoder().encode('<script>alert(1)</script>')]
    await page.evaluate(({ a, roomId, bytes }) => window.matrixTest.engine.upload(a, roomId,
      new File([new Uint8Array(bytes)], 'evil.html', { type: 'text/html' })).then(operation => operation.done),
    { a, roomId, bytes: html })
    const evil = await findMessage(page, a, roomId, 'evil.html')
    const evilType = await page.evaluate(async ({ a, roomId, message }) => {
      const url = await window.matrixTest.engine.download(a, roomId, message)
      return (await (await fetch(url)).blob()).type
    }, { a, roomId, message: evil })
    expect(evilType).toBe('application/octet-stream')
    // Blob URLs die with the session that created them.
    await page.evaluate(a => window.matrixTest.engine.logout(a), a)
    const revoked = await page.evaluate(async url => {
      try { await (await fetch(url!)).arrayBuffer(); return false } catch { return true }
    }, avatarUrl)
    expect(revoked).toBe(true)
  } finally {
    if (nioStarted) await nio.stop().catch(() => {})
    await page.evaluate(async () => { await window.matrixTest?.engine.dispose() }).catch(() => {})
    await context.close()
  }
})

test('thread timelines, replies and read state interoperate with matrix-nio', async ({ browser, request }) => {
  test.setTimeout(120_000)
  const context = await browser.newContext()
  const page = await context.newPage()
  const nio = new NioPeer()
  let nioStarted = false
  try {
    await boot(page)
    const a = await login(page, alice)
    await nio.command('start', { homeserver: fixture.base, username: reference.username, password: reference.password })
    nioStarted = true
    const roomId = await page.evaluate(({ a, invite }) =>
      window.matrixTest.engine.createRoom(a, 'Thread fixture', 'replies and read state', invite),
    { a, invite: reference.userId })
    await watch(page, a, roomId)
    await nio.command('join', { roomId })
    const rootBody = `Thread root from Fern ${Date.now()}`
    await page.evaluate(({ a, roomId, body }) => window.matrixTest.engine.send(a, roomId, body),
      { a, roomId, body: rootBody })
    const root = await findMessage(page, a, roomId, rootBody)
    await nio.command('send', { roomId, body: 'Threaded reply from matrix-nio', threadOf: root.id })
    const replyOnFern = await findMessage(page, a, roomId, 'Threaded reply from matrix-nio')
    expect(replyOnFern.threadRoot).toBe(root.id)
    await page.evaluate(({ a, roomId, rootId }) =>
      window.matrixTest.engine.sendThreadReply(a, roomId, rootId, 'Fern threaded reply'),
    { a, roomId, rootId: root.id })
    const nioThread = await nio.command('wait_thread', { roomId, body: 'Fern threaded reply', threadOf: root.id })
    expect(nioThread.decrypted).toBe(true)
    expect(nioThread.relatesTo).toMatchObject({ rel_type: 'm.thread', event_id: root.id })
    await expect.poll(() => findMessage(page, a, roomId, rootBody).then(message => message.threadReplies ?? 0),
      { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
    const settled = await page.evaluate(({ a, roomId }) =>
      window.matrixTest.engine.watchThread(a, roomId, '$missing', () => {}).then(stop => { stop(); return 'settled' }),
    { a, roomId })
    expect(settled).toBe('settled')
  } finally {
    if (nioStarted) await nio.stop().catch(() => {})
    await page.evaluate(async () => { await window.matrixTest?.engine.dispose() }).catch(() => {})
    await context.close()
  }
})

test('rapid account and room switching keeps one live subscription', async ({ page, request }) => {
  test.setTimeout(180_000)
  await boot(page)
  const a = await login(page, alice)
  const b = await login(page, bob)
  const rooms: string[] = []
  for (const name of ['Switch fixture one', 'Switch fixture two']) {
    const { room_id: roomId } = await matrix(request, reference, 'POST', '/createRoom', {
      name, visibility: 'public', preset: 'public_chat', invite: [alice.userId, bob.userId],
    })
    rooms.push(roomId)
  }
  for (const id of [a, b]) {
    for (const roomId of rooms) {
      await expect.poll(() => page.evaluate(({ id, roomId }) =>
        window.matrixTest.rooms[id]?.find(r => r.id === roomId)?.membership, { id, roomId })).toBe('invited')
      await page.evaluate(({ id, roomId }) => window.matrixTest.engine.join(id, roomId), { id, roomId })
    }
  }
  // Alternate watches across accounts and rooms the way fast room switching
  // does: stop everything, then watch the next target.
  const cycle: Array<[string, string]> = [[a, rooms[0]!], [b, rooms[1]!], [a, rooms[1]!], [b, rooms[0]!], [a, rooms[0]!], [b, rooms[1]!]]
  for (const [id, roomId] of cycle) {
    await page.evaluate(() => window.matrixTest.stops.splice(0).forEach(stop => stop()))
    await watch(page, id, roomId)
  }
  const errors = await page.evaluate(() => window.matrixTest.errors)
  expect(errors).toEqual([])
  // The final watch is live: a message sent by the other member arrives.
  await page.evaluate(({ b, roomId }) => window.matrixTest.engine.send(b, roomId, 'After rapid switching'),
    { b, roomId: rooms[1]! })
  await findMessage(page, b, rooms[1]!, 'After rapid switching')
  // Disposal sticks: with every listener stopped, a new message from the
  // other account changes nothing on the stopped watch.
  await page.evaluate(({ b, roomId }) => window.matrixTest.engine.send(b, roomId, 'While unwatched'),
    { b, roomId: rooms[1]! })
  await findMessage(page, b, rooms[1]!, 'While unwatched')
  const before = await page.evaluate(({ b, roomId }) => window.matrixTest.messages[b + '/' + roomId].length,
    { b, roomId: rooms[1]! })
  await page.evaluate(() => window.matrixTest.stops.splice(0).forEach(stop => stop()))
  await page.evaluate(({ a, roomId }) => window.matrixTest.engine.send(a, roomId, 'Sent after disposal'),
    { a, roomId: rooms[1]! })
  await page.waitForTimeout(4000)
  const after = await page.evaluate(({ b, roomId }) => ({
    length: window.matrixTest.messages[b + '/' + roomId].length,
    seen: window.matrixTest.messages[b + '/' + roomId].some(message => message.body === 'Sent after disposal'),
  }), { b, roomId: rooms[1]! })
  expect(after.length).toBe(before)
  expect(after.seen).toBe(false)
  // Subscription restoration: re-watching picks up everything missed.
  await watch(page, b, rooms[1]!)
  await findMessage(page, b, rooms[1]!, 'Sent after disposal')
  expect(await page.evaluate(() => window.matrixTest.errors)).toEqual([])
  await page.evaluate(async () => { await window.matrixTest?.engine.dispose() }).catch(() => {})
})

test('server downtime flips the account offline and retry recovers', async ({ page, request }) => {
  test.setTimeout(180_000)
  await boot(page)
  const a = await login(page, alice)
  const { room_id: roomId } = await matrix(request, reference, 'POST', '/createRoom', {
    name: 'Downtime fixture', visibility: 'public', preset: 'public_chat', invite: [alice.userId],
  })
  await expect.poll(() => page.evaluate(({ a, roomId }) =>
    window.matrixTest.rooms[a]?.find(r => r.id === roomId)?.membership, { a, roomId })).toBe('invited')
  await page.evaluate(({ a, roomId }) => window.matrixTest.engine.join(a, roomId), { a, roomId })
  await watch(page, a, roomId)
  await page.evaluate(({ a, roomId }) => window.matrixTest.engine.send(a, roomId, 'Before blackout'), { a, roomId })
  await findMessage(page, a, roomId, 'Before blackout')
  // The SDK normalizes the session to the canonical server URL, so a proxy
  // blackout would miss the probe; instead the versions endpoint the probe
  // reads is refused while all other traffic flows. The SDK service state
  // stays online through this, so the engine's own consecutive-failure
  // detector must flip the account offline.
  await page.route('**/_matrix/client/versions', route => route.abort())
  await expect.poll(() => page.evaluate(({ a }) => window.matrixTest.accounts[a]?.connection, { a }),
    { timeout: 60_000 }).toBe('offline')
  const status = await page.evaluate(({ a }) => window.matrixTest.accounts[a], { a })
  expect(status?.error ?? '').toContain('Connection lost')
  // One threshold error, not per-poll spam.
  const lost = await page.evaluate(() => window.matrixTest.errors.filter(e => e.includes('Connection lost')))
  expect(lost).toHaveLength(1)
  await page.unroute('**/_matrix/client/versions')
  // Manual retry re-probes immediately instead of waiting out the backoff.
  await page.evaluate(({ a }) => window.matrixTest.engine.retryConnection(a), { a })
  await expect.poll(() => page.evaluate(({ a }) => window.matrixTest.accounts[a]?.connection, { a }),
    { timeout: 30_000 }).toBe('online')
  await page.evaluate(({ a, roomId }) => window.matrixTest.engine.send(a, roomId, 'After recovery'), { a, roomId })
  await findMessage(page, a, roomId, 'After recovery')
  await page.evaluate(async () => { await window.matrixTest?.engine.dispose() }).catch(() => {})
})

test('unverified new devices are cut off from rotated-out sessions', async ({ browser, request }) => {
  test.setTimeout(180_000)
  const context = await browser.newContext()
  const page = await context.newPage()
  const nio = new NioPeer()
  let nioStarted = false
  try {
    await boot(page)
    const a = await login(page, alice)
    const roomId = await page.evaluate(({ a }) =>
      window.matrixTest.engine.createRoom(a, 'Key share fixture', 'history keys'), { a })
    await watch(page, a, roomId)
    // The room's encryption state must arrive before the first send:
    // otherwise the SDK posts the opener as plaintext (see issue #42).
    await expect.poll(() => page.evaluate(({ a, roomId }) =>
      window.matrixTest.rooms[a]?.find(r => r.id === roomId)?.encrypted, { a, roomId })).toBe(true)
    await page.evaluate(({ a, roomId }) => window.matrixTest.engine.send(a, roomId, 'Written before the second device'),
      { a, roomId })
    const original = await findMessage(page, a, roomId, 'Written before the second device')
    // Rotate the session and send again: the newcomer below receives the new
    // session on join but never the superseded one, so the first message can
    // only arrive via an explicit key request.
    await page.evaluate(({ a, roomId }) => window.matrixTest.engine.discardRoomKey(a, roomId), { a, roomId })
    await page.evaluate(({ a, roomId }) => window.matrixTest.engine.send(a, roomId, 'Written after rotation'),
      { a, roomId })
    const rotated = await findMessage(page, a, roomId, 'Written after rotation')
    // Pin the rotation itself: the two messages must use different megolm
    // sessions, read off the server-side ciphertext envelope.
    const raw1 = await matrix(request, alice, 'GET', `/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(original.id)}`)
    const raw2 = await matrix(request, alice, 'GET', `/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(rotated.id)}`)
    expect(raw1.type).toBe('m.room.encrypted')
    expect(raw2.content.session_id).not.toBe(raw1.content.session_id)
    // A fresh independent device for the same user joins afterwards, past a
    // session rotation. The newcomer demonstrably shares the live session
    // (it reads a post-join message), yet the superseded session stays
    // missing: fetching it makes nio request the session automatically, and
    // a persistent MegolmEvent proves the sender's devices never answer
    // requests from unverified devices.
    await nio.command('start', { homeserver: fixture.base, username: alice.username, password: alice.password })
    nioStarted = true
    await nio.command('join', { roomId })
    await page.evaluate(({ a, roomId }) => window.matrixTest.engine.send(a, roomId, 'Session the newcomer shares'),
      { a, roomId })
    const live = await findMessage(page, a, roomId, 'Session the newcomer shares')
    const liveFetched = await nio.command('fetch_event', { roomId, eventId: live.id })
    expect(liveFetched).toMatchObject({ kind: 'RoomMessageText', body: 'Session the newcomer shares' })
    const fetched = await nio.command('fetch_event', { roomId, eventId: original.id })
    expect(fetched).toMatchObject({ kind: 'MegolmEvent' })
  } finally {
    if (nioStarted) await nio.stop().catch(() => {})
    await page.evaluate(async () => { await window.matrixTest?.engine.dispose() }).catch(() => {})
    await context.close()
  }
})

test('cross-user rotated-out sessions stay missing on request', async ({ browser, request }) => {
  test.setTimeout(180_000)
  const context = await browser.newContext()
  const page = await context.newPage()
  const nio = new NioPeer()
  let nioStarted = false
  try {
    await boot(page)
    const a = await login(page, alice)
    const roomId = await page.evaluate(({ a }) =>
      window.matrixTest.engine.createRoom(a, 'Cross-user keys', 'policy probe'), { a })
    await watch(page, a, roomId)
    await expect.poll(() => page.evaluate(({ a, roomId }) =>
      window.matrixTest.rooms[a]?.find(r => r.id === roomId)?.encrypted, { a, roomId })).toBe(true)
    await page.evaluate(({ a, roomId }) => window.matrixTest.engine.send(a, roomId, 'Members-only history'),
      { a, roomId })
    await findMessage(page, a, roomId, 'Members-only history')
    await page.evaluate(({ a, roomId }) => window.matrixTest.engine.discardRoomKey(a, roomId), { a, roomId })
    await page.evaluate(({ a, roomId }) => window.matrixTest.engine.send(a, roomId, 'After rotation'), { a, roomId })
    const rotated = await findMessage(page, a, roomId, 'After rotation')
    await page.evaluate(({ a, roomId, userId }) => window.matrixTest.engine.invite(a, roomId, userId),
      { a, roomId, userId: bob.userId })
    await nio.command('start', { homeserver: fixture.base, username: bob.username, password: bob.password })
    nioStarted = true
    await nio.command('join', { roomId })
    // A different user's fresh device joins past the rotation. It reads the
    // live session but the superseded one stays missing across the same
    // automatic request window, pinning the boundary across users.
    const history = await findMessage(page, a, roomId, 'Members-only history')
    const rawHistory = await matrix(request, alice, 'GET', `/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(history.id)}`)
    const rawRotated = await matrix(request, alice, 'GET', `/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(rotated.id)}`)
    expect(rawHistory.type).toBe('m.room.encrypted')
    expect(rawRotated.content.session_id).not.toBe(rawHistory.content.session_id)
    await page.evaluate(({ a, roomId }) => window.matrixTest.engine.send(a, roomId, 'Live for the new member'),
      { a, roomId })
    const live = await findMessage(page, a, roomId, 'Live for the new member')
    const liveFetched = await nio.command('fetch_event', { roomId, eventId: live.id })
    expect(liveFetched).toMatchObject({ kind: 'RoomMessageText', body: 'Live for the new member' })
    const fetched = await nio.command('fetch_event', { roomId, eventId: history.id })
    expect(fetched).toMatchObject({ kind: 'MegolmEvent' })
  } finally {
    if (nioStarted) await nio.stop().catch(() => {})
    await page.evaluate(async () => { await window.matrixTest?.engine.dispose() }).catch(() => {})
    await context.close()
  }
})

test('backup migration moves a fresh device to the rotated key', async ({ browser, request }) => {
  test.setTimeout(180_000)
  const ca = await browser.newContext()
  const cb = await browser.newContext()
  const pa = await ca.newPage()
  const pb = await cb.newPage()
  try {
    await boot(pa)
    await boot(pb)
    const a = await login(pa, alice)
    const roomId = await pa.evaluate(({ a }) =>
      window.matrixTest.engine.createRoom(a, 'Migration fixture', 'backup rotation'), { a })
    await watch(pa, a, roomId)
    await expect.poll(() => pa.evaluate(({ a, roomId }) =>
      window.matrixTest.rooms[a]?.find(r => r.id === roomId)?.encrypted, { a, roomId })).toBe(true)
    await pa.evaluate(({ a, roomId }) => window.matrixTest.engine.send(a, roomId, 'Before rotation'), { a, roomId })
    await findMessage(pa, a, roomId, 'Before rotation')
    const oldKey = await pa.evaluate(({ a }) => window.matrixTest.engine.enableRecovery(a, () => {}), { a })
    await pa.evaluate(({ a, roomId }) => window.matrixTest.engine.discardRoomKey(a, roomId), { a, roomId })
    await pa.evaluate(({ a, roomId }) => window.matrixTest.engine.send(a, roomId, 'After rotation'), { a, roomId })
    await findMessage(pa, a, roomId, 'After rotation')
    const newKey = await pa.evaluate(({ a }) => window.matrixTest.engine.resetRecovery(a), { a })
    expect(newKey).not.toBe(oldKey)
    const b = await login(pb, alice)
    await watch(pb, b, roomId)
    // The superseded key no longer opens the replaced backup.
    const stale = await pb.evaluate(async ({ b, oldKey }) => {
      try { await window.matrixTest.engine.recover(b, oldKey); return '' }
      catch (error) { return error instanceof Error ? error.message : String(error) }
    }, { b, oldKey })
    expect(stale).toBeTruthy()
    // The rotated key restores the fresh device onto post-rotation history.
    await pb.evaluate(({ b, newKey }) => window.matrixTest.engine.recover(b, newKey), { b, newKey })
    await findMessage(pb, b, roomId, 'After rotation')
    // The rotating device re-uploads known keys, so the new backup also
    // opens pre-rotation history: migration loses nothing.
    await findMessage(pb, b, roomId, 'Before rotation')
  } finally {
    for (const page of [pa, pb]) await page.evaluate(async () => { await window.matrixTest?.engine.dispose() }).catch(() => {})
    await ca.close(); await cb.close()
  }
})

test('openers in fresh encrypted rooms never send plaintext', async ({ page, request }) => {
  await boot(page)
  const a = await login(page, alice)
  const roomId = await page.evaluate(({ a }) =>
    window.matrixTest.engine.createRoom(a, 'Opener fixture', 'plaintext race'), { a })
  await watch(page, a, roomId)
  // No encryption-state wait: the opener races state sync by design, and the
  // server-side envelope must still be ciphertext.
  await page.evaluate(({ a, roomId }) => window.matrixTest.engine.send(a, roomId, 'First word'), { a, roomId })
  const opener = await findMessage(page, a, roomId, 'First word')
  const raw = await matrix(request, alice, 'GET', `/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(opener.id)}`)
  expect(raw.type).toBe('m.room.encrypted')
  await page.evaluate(async () => { await window.matrixTest?.engine.dispose() }).catch(() => {})
})

test('pagination keeps order without duplicates and redactions update in place', async ({ page, request }) => {
  test.setTimeout(180_000)
  await boot(page)
  const a = await login(page, alice)
  const { room_id: roomId } = await matrix(request, reference, 'POST', '/createRoom', {
    name: 'History fixture', visibility: 'public', preset: 'public_chat', invite: [alice.userId],
  })
  await expect.poll(() => page.evaluate(({ a, roomId }) =>
    window.matrixTest.rooms[a]?.find(r => r.id === roomId)?.membership, { a, roomId })).toBe('invited')
  await page.evaluate(({ a, roomId }) => window.matrixTest.engine.join(a, roomId), { a, roomId })
  // Seed history from a second member so pagination has pages to fetch.
  const seeded: string[] = []
  for (let index = 0; index < 25; index++) {
    const { event_id: eventId } = await matrix(request, reference, 'PUT',
      `/rooms/${roomId}/send/m.room.message/seed${index}`, { msgtype: 'm.text', body: `Seeded history ${index}` })
    seeded.push(eventId)
  }
  await watch(page, a, roomId)
  await findMessage(page, a, roomId, 'Seeded history 24')
  const snapshot = (messages: Message[]) => ({
    ids: messages.map(message => message.id),
    ordered: messages.every((message, index, all) => index === 0 || all[index - 1]!.timestamp <= message.timestamp),
  })
  // Paginate twice while new messages arrive: live backfill and back-pagination
  // must never duplicate or reorder.
  await page.evaluate(({ a, roomId }) => window.matrixTest.engine.paginate(a, roomId), { a, roomId })
  await matrix(request, reference, 'PUT', `/rooms/${roomId}/send/m.room.message/live1`,
    { msgtype: 'm.text', body: 'Live during pagination' })
  await page.evaluate(({ a, roomId }) => window.matrixTest.engine.paginate(a, roomId), { a, roomId })
  await findMessage(page, a, roomId, 'Live during pagination')
  const afterPages = await page.evaluate(({ a, roomId }) => window.matrixTest.messages[a + '/' + roomId],
    { a, roomId })
  expect(new Set(snapshot(afterPages).ids).size).toBe(afterPages.length)
  expect(snapshot(afterPages).ordered).toBe(true)
  expect(afterPages.some(message => message.body === 'Seeded history 0')).toBe(true)
  // A redaction from the other member updates the existing item in place.
  const target = seeded[12]!
  const beforeIds = snapshot(afterPages).ids
  await matrix(request, reference, 'PUT', `/rooms/${roomId}/redact/${target}/redact1`, {})
  await expect.poll(() => page.evaluate(({ a, roomId, target }) =>
    window.matrixTest.messages[a + '/' + roomId]?.find(message => message.id === target)?.body,
  { a, roomId, target })).toBe('Message removed')
  const afterRedact = await page.evaluate(({ a, roomId }) => window.matrixTest.messages[a + '/' + roomId],
    { a, roomId })
  expect(afterRedact.map(message => message.id)).toEqual(beforeIds)
  expect(new Set(afterRedact.map(message => message.id)).size).toBe(afterRedact.length)
  expect(await page.evaluate(() => window.matrixTest.errors)).toEqual([])
  await page.evaluate(async () => { await window.matrixTest?.engine.dispose() }).catch(() => {})
})
