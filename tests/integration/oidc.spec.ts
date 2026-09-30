import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { MatrixEngine } from '../../src/sdk/engine'
import type { Account, Room, Message } from '../../src/types'

// Native-OIDC round trip against disposable Spindle with its built-in OIDC
// provider (see scripts/test-oidc.mjs). Skipped in the standard suite, which
// has no OIDC issuer.
test.skip(!process.env.FERN_OIDC_FIXTURE, 'OIDC fixture only: run npm run test:oidc')

interface FixtureUser { username: string; password: string; userId: string; token: string }
interface Fixture { base: string; users: FixtureUser[] }
const fixture: Fixture = process.env.FERN_OIDC_FIXTURE
  ? JSON.parse(readFileSync(process.env.FERN_OIDC_FIXTURE, 'utf8'))
  : { base: '', users: [] }
const [alice, bob] = fixture.users
const callbackPage = 'http://127.0.0.1:5173/oidc-callback.html'

async function boot(page: Page) {
  await page.goto('http://127.0.0.1:5173/tests/integration/client.html')
  await page.evaluate(async () => {
    // @ts-expect-error Browser imports are resolved by the Vite development server.
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

async function watch(page: Page, accountId: string, roomId: string) {
  await expect.poll(() => page.evaluate(({ accountId, roomId }) =>
    window.matrixTest.rooms[accountId]?.some(room => room.id === roomId && room.membership === 'joined') ?? false,
  { accountId, roomId })).toBe(true)
  await page.evaluate(async ({ accountId, roomId }) => {
    const state = window.matrixTest
    const key = accountId + '/' + roomId
    state.stops.push(await state.engine.watchRoom(accountId, roomId,
      (messages: Message[]) => { state.messages[key] = messages }, () => {}))
  }, { accountId, roomId })
}

// Completes one native-OIDC login by driving the real redirect chain
// (Fern -> Spindle authorize page -> callback page) in a popup page, then
// finishing through the engine under test. Spindle serves simplified sliding
// sync but omits the /versions advertisement flag (tuna-os/spindle#507), so
// the flow forces native sync instead of discovering it.
async function oidcLogin(page: Page, user: FixtureUser) {
  const started = await page.evaluate(({ base, callbackPage }) =>
    window.matrixTest.engine.startOidcLogin(base, callbackPage, undefined, true), { base: fixture.base, callbackPage })
  expect(started.url).toContain('/oauth2/authorize')
  const auth = await page.context().newPage()
  try {
    await auth.goto(started.url)
    await auth.getByPlaceholder('Username').fill(user.username)
    await auth.getByPlaceholder('Password').fill(user.password)
    await Promise.all([
      auth.waitForURL(/oidc-callback\.html\?.*code=/, { timeout: 30_000 }),
      auth.getByRole('button', { name: 'Sign in' }).click(),
    ])
    const callbackUrl = auth.url()
    return await page.evaluate(({ flowId, callbackUrl }) =>
      window.matrixTest.engine.finishOidcLogin(flowId, callbackUrl), { flowId: started.flowId, callbackUrl })
  } finally {
    await auth.close()
  }
}

test('native OIDC round trip authenticates two accounts independently', async ({ browser, request }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await boot(page)
    // Spindle with the built-in provider keeps password login beside OIDC.
    const methods = await page.evaluate(base => window.matrixTest.engine.loginMethods(base), fixture.base)
    expect(methods).toEqual({ password: true, sso: false, oidc: true })
    const a = await oidcLogin(page, alice)
    await expect.poll(() => page.evaluate(a => window.matrixTest.accounts[a]?.connection, a)).toBe('online')
    expect(await page.evaluate(a => window.matrixTest.engine.getClient(a).userId(), a)).toBe(alice.userId)
    const b = await oidcLogin(page, bob)
    await expect.poll(() => page.evaluate(b => window.matrixTest.accounts[b]?.connection, b)).toBe('online')
    expect(await page.evaluate(b => window.matrixTest.engine.getClient(b).userId(), b)).toBe(bob.userId)
    expect(a).not.toBe(b)
    // Both OIDC sessions are fully functional, independent Matrix sessions:
    // an encrypted room carries messages in both directions.
    const roomId = await page.evaluate(({ a, invite }) =>
      window.matrixTest.engine.createRoom(a, 'OIDC fixture room', 'native OIDC interop', invite),
    { a, invite: bob.userId })
    await page.evaluate(({ b, roomId }) => window.matrixTest.engine.join(b, roomId), { b, roomId })
    for (const id of [a, b]) await watch(page, id, roomId)
    await page.evaluate(({ a, roomId }) => window.matrixTest.engine.send(a, roomId, 'Hello from OIDC Alice'), { a, roomId })
    await expect.poll(() => page.evaluate(({ b, roomId }) => window.matrixTest.messages[b + '/' + roomId]
      ?.some(message => message.body === 'Hello from OIDC Alice') ?? false, { b, roomId })).toBe(true)
    await page.evaluate(({ b, roomId }) => window.matrixTest.engine.send(b, roomId, 'Hello from OIDC Bob'), { b, roomId })
    await expect.poll(() => page.evaluate(({ a, roomId }) => window.matrixTest.messages[a + '/' + roomId]
      ?.some(message => message.body === 'Hello from OIDC Bob') ?? false, { a, roomId })).toBe(true)
    // Room traffic is ciphertext on the wire.
    const raw = await request.fetch(fixture.base + '/_matrix/client/v3' + `/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=10`,
      { headers: { Authorization: 'Bearer ' + alice.token } })
    expect(raw.status()).toBeLessThan(300)
    const chunk = (await raw.json() as { chunk: { type: string }[] }).chunk
    expect(chunk.some(event => event.type === 'm.room.encrypted')).toBe(true)
    expect(JSON.stringify(chunk)).not.toContain('Hello from OIDC Alice')
    await page.evaluate(async () => { window.matrixTest?.stops.forEach(stop => stop()); await window.matrixTest?.engine.dispose() }).catch(() => {})
  } finally {
    await context.close()
  }
})

test('wrong provider password fails without persisting an account', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await boot(page)
    const started = await page.evaluate(({ base, callbackPage }) =>
      window.matrixTest.engine.startOidcLogin(base, callbackPage, undefined, true), { base: fixture.base, callbackPage })
    const auth = await page.context().newPage()
    try {
      await auth.goto(started.url)
      await auth.getByPlaceholder('Username').fill(alice.username)
      await auth.getByPlaceholder('Password').fill('wrong-password')
      await auth.getByRole('button', { name: 'Sign in' }).click()
      await expect(auth.locator('.error')).toBeVisible({ timeout: 15_000 })
      expect(auth.url()).toContain('/oauth2/authorize')
    } finally {
      await auth.close()
    }
    await page.evaluate(flowId => window.matrixTest.engine.cancelOidcLogin(flowId), started.flowId)
    expect(await page.evaluate(() => Object.keys(window.matrixTest.accounts))).toEqual([])
  } finally {
    await context.close()
  }
})
