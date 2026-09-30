import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { MatrixEngine } from '../../src/sdk/engine'
import type { Account, Room } from '../../src/types'

// Legacy-SSO round trip against the disposable OIDC fixture (see
// scripts/test-sso.mjs). Skipped in the standard suite, which has no IdP.
test.skip(!process.env.FERN_SSO_FIXTURE, 'SSO fixture only: run npm run test:sso')

interface FixtureUser { username: string; userId: string; token: string }
interface Fixture { base: string; users: FixtureUser[] }
const fixture: Fixture = process.env.FERN_SSO_FIXTURE
  ? JSON.parse(readFileSync(process.env.FERN_SSO_FIXTURE, 'utf8'))
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

async function matrix(request: APIRequestContext, user: FixtureUser, method: string, path: string, data?: unknown) {
  const response = await request.fetch(fixture.base + '/_matrix/client/v3' + path, {
    method, headers: { Authorization: 'Bearer ' + user.token }, data,
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

// Completes one legacy-SSO login by driving the real redirect chain
// (Synapse -> test IdP chooser -> Synapse -> callback page) in a popup page,
// then finishing through the engine under test.
async function ssoLogin(page: Page, name: 'Alice' | 'Bob') {
  const started = await page.evaluate(({ base, callbackPage }) =>
    window.matrixTest.engine.startSsoLogin(base, callbackPage), { base: fixture.base, callbackPage })
  expect(started.url).toContain('/login/sso/redirect')
  const auth = await page.context().newPage()
  try {
    await auth.goto(started.url)
    await auth.getByRole('button', { name: `Log in as ${name}` }).click()
    // Synapse confirms the client redirect before releasing the login token.
    await auth.waitForLoadState('load')
    const confirm = auth.getByRole('link', { name: 'Continue' })
    try {
      if (await confirm.count() > 0) {
        await Promise.all([
          auth.waitForURL(/oidc-callback\.html\?loginToken=/, { timeout: 30_000 }),
          confirm.first().click(),
        ])
      } else {
        await auth.waitForURL(/oidc-callback\.html\?loginToken=/, { timeout: 30_000 })
      }
    } catch (error) {
      const headings = await auth.locator('h1,h2').allTextContents().catch(() => [])
      console.log(`SSO stall for ${name} at ${auth.url().slice(0, 120)} :: ${headings.join(' / ')}`)
      throw error
    }
    const callbackUrl = auth.url()
    return await page.evaluate(({ flowId, callbackUrl }) =>
      window.matrixTest.engine.finishSsoLogin(flowId, callbackUrl), { flowId: started.flowId, callbackUrl })
  } finally {
    await auth.close()
  }
}

test('legacy SSO round trip authenticates two accounts independently', async ({ browser, request }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await boot(page)
    // The OIDC-only homeserver advertises no password login.
    const methods = await page.evaluate(base => window.matrixTest.engine.loginMethods(base), fixture.base)
    expect(methods).toEqual({ password: false, sso: true, oidc: false })
    const a = await ssoLogin(page, 'Alice')
    await expect.poll(() => page.evaluate(a => window.matrixTest.accounts[a]?.connection, a)).toBe('online')
    expect(await page.evaluate(a => window.matrixTest.engine.getClient(a).userId(), a)).toBe(alice.userId)
    const b = await ssoLogin(page, 'Bob')
    await expect.poll(() => page.evaluate(b => window.matrixTest.accounts[b]?.connection, b)).toBe('online')
    expect(await page.evaluate(b => window.matrixTest.engine.getClient(b).userId(), b)).toBe(bob.userId)
    expect(a).not.toBe(b)
    // Both SSO sessions are fully functional, independent Matrix sessions.
    const { room_id: roomId } = await matrix(request, alice, 'POST', '/createRoom', {
      name: 'SSO fixture room', visibility: 'private', preset: 'private_chat', invite: [bob.userId],
    })
    await matrix(request, bob, 'POST', `/rooms/${encodeURIComponent(roomId)}/join`, {})
    for (const id of [a, b]) await watch(page, id, roomId)
    await page.evaluate(({ a, roomId }) => window.matrixTest.engine.send(a, roomId, 'Hello from SSO Alice'), { a, roomId })
    await expect.poll(() => page.evaluate(({ b, roomId }) => window.matrixTest.messages[b + '/' + roomId]
      ?.some(message => message.body === 'Hello from SSO Alice') ?? false, { b, roomId })).toBe(true)
    await page.evaluate(async () => { window.matrixTest?.stops.forEach(stop => stop()); await window.matrixTest?.engine.dispose() }).catch(() => {})
  } finally {
    await context.close()
  }
})
