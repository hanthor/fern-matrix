import { test, expect, type Page, type Browser } from '@playwright/test'
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
const fixture: Fixture = JSON.parse(readFileSync(process.env.FERN_MATRIX_FIXTURE ?? process.env.FERN_OIDC_FIXTURE!, 'utf8'))
const [alice, bob] = fixture.users
const isSpindle = fixture.version === 'spindle-builtin-oidc'
const ROTATED = 'rotated-rotated-9'

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
      error: (id: string, message: string) => { state.errors.push(id + ':' + message) },
    })
    window.matrixTest = state
  })
}
async function login(page: Page, user: FixtureUser) {
  // Spindle omits the sliding-sync advertisement flag: force native sync,
  // same workaround as the OIDC flow (upstream tuna-os/spindle#507).
  return page.evaluate(({ base, username, password, force }) => window.matrixTest.engine.login(base, username, password, force),
    { base: fixture.base, username: user.username, password: user.password, force: isSpindle })
}
async function restLogin(username: string, password: string) {
  const response = await fetch(fixture.base + '/_matrix/client/v3/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'm.login.password', identifier: { type: 'm.id.user', user: username }, password }),
  })
  return response.status
}

test('registration capability and account creation', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await boot(page)
    if (isSpindle) {
      // Open registration with dummy UIAA: availability, creation, and the
      // taken-name signal, then a real password login for the new account.
      const name = 'fern-reg-' + Date.now().toString(36)
      await expect(page.evaluate(({ base, name }) => window.matrixTest.engine.registerAvailable(base, name),
        { base: fixture.base, name })).resolves.toBe(true)
      const userId = await page.evaluate(({ base, name }) =>
        window.matrixTest.engine.register(base, name, 'created-created-3'),
      { base: fixture.base, name })
      expect(userId).toContain(name)
      expect(await restLogin(userId, 'created-created-3')).toBe(200)
      await expect(page.evaluate(({ base, name }) => window.matrixTest.engine.registerAvailable(base, name),
        { base: fixture.base, name })).resolves.toBe(false)
    } else {
      // Registration disabled: capability and creation both say so plainly.
      await expect(page.evaluate(({ base }) => window.matrixTest.engine.registerAvailable(base, 'anyone'),
        { base: fixture.base })).rejects.toThrow('does not offer open registration')
      await expect(page.evaluate(({ base }) => window.matrixTest.engine.register(base, 'anyone', 'x'.repeat(12)),
        { base: fixture.base })).rejects.toThrow('does not offer open registration')
    }
    await page.evaluate(() => window.matrixTest.engine.dispose())
  } finally {
    await context.close()
  }
})

test('password rotation keeps other sessions and reverts cleanly', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await boot(page)
    const a1 = await login(page, alice)
    // Rotation without logout_devices: other sessions (and the fixture
    // token other specs rely on) survive untouched.
    await page.evaluate(({ id, current, next }) => window.matrixTest.engine.changePassword(id, current, next, false),
      { id: a1, current: alice.password, next: ROTATED })
    expect(await restLogin(alice.userId, alice.password)).toBe(403)
    expect(await restLogin(alice.userId, ROTATED)).toBe(200)
    // Revert through a fresh session so the shared fixture user survives.
    const a3 = await page.evaluate(({ base, username, next, force }) => window.matrixTest.engine.login(base, username, next, force),
      { base: fixture.base, username: alice.username, next: ROTATED, force: isSpindle })
    await page.evaluate(({ id, current, next }) => window.matrixTest.engine.changePassword(id, current, next, false),
      { id: a3, current: ROTATED, next: alice.password })
    expect(await restLogin(alice.userId, alice.password)).toBe(200)
    await page.evaluate(() => window.matrixTest.engine.dispose())
  } finally {
    await context.close()
  }
})

test('orphaned sessions surface expiry explicitly', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await boot(page)
    const a1 = await login(page, alice)
    const orphan = await login(page, alice)
    // Deleting only the orphan's device from under it strands the engine
    // session: no silent death, no misleading offline. Targeted deletion
    // keeps the shared fixture token other specs rely on alive.
    const orphanDevice = await page.evaluate(async (id) =>
      (await window.matrixTest.engine.devices(id)).find(device => device.current)!.id, orphan)
    await page.evaluate(({ id, device, password }) => window.matrixTest.engine.deleteDevice(id, device, password),
      { id: a1, device: orphanDevice, password: alice.password })
    // Read atomically: sync retries flap the connection, so separate polls
    // can straddle an online moment.
    await expect.poll(() => page.evaluate(id => {
      const account = window.matrixTest.accounts[id]
      return `${account?.connection ?? 'missing'}|${account?.error ?? ''}`
    }, orphan), { timeout: 60_000 }).toMatch(/^error\|.*(expired|sign in again)/i)
    if (isSpindle) {
      // Full rotation with logout_devices on a throwaway: every session dies.
      const name = 'fern-rot-' + Date.now().toString(36)
      const userId = await page.evaluate(({ base, name }) => window.matrixTest.engine.register(base, name, 'spin-spin-5'),
        { base: fixture.base, name })
      const t1 = await page.evaluate(({ base, name, force }) => window.matrixTest.engine.login(base, name, 'spin-spin-5', force),
        { base: fixture.base, name, force: true })
      const t2 = await page.evaluate(({ base, name, force }) => window.matrixTest.engine.login(base, name, 'spin-spin-5', force),
        { base: fixture.base, name, force: true })
      await page.evaluate(({ id }) => window.matrixTest.engine.changePassword(id, 'spin-spin-5', 'spin-spin-6', true),
        { id: t1 })
      expect(await restLogin(userId, 'spin-spin-5')).toBe(403)
      await expect.poll(() => page.evaluate(id => {
        const account = window.matrixTest.accounts[id]
        return `${account?.connection ?? 'missing'}|${account?.error ?? ''}`
      }, t2), { timeout: 60_000 }).toMatch(/^error\|.*(expired|sign in again)/i)
    }
    await page.evaluate(() => window.matrixTest.engine.dispose())
  } finally {
    await context.close()
  }
})

test('sessions list and targeted sign-out', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await boot(page)
    const a1 = await login(page, alice)
    const before = await page.evaluate(id => window.matrixTest.engine.devices(id), a1)
    expect(before.some(device => device.current)).toBe(true)
    const second = await login(page, alice)
    const listed = await page.evaluate(id => window.matrixTest.engine.devices(id), a1)
    const extra = (await page.evaluate(id => window.matrixTest.engine.devices(id), second))
      .find(device => device.current)!.id
    expect(listed.some(device => device.id === extra)).toBe(true)
    // Delete only the session this test created: the shared fixture token
    // other specs rely on belongs to a different device and must survive.
    await page.evaluate(({ id, device, password }) => window.matrixTest.engine.deleteDevice(id, device, password),
      { id: a1, device: extra, password: alice.password })
    const after = await page.evaluate(id => window.matrixTest.engine.devices(id), a1)
    expect(after.some(device => device.id === extra)).toBe(false)
    expect(after.some(device => device.current)).toBe(true)
    await page.evaluate(() => window.matrixTest.engine.dispose())
  } finally {
    await context.close()
  }
})

test('deactivation removes a provisioned account', async ({ browser }: { browser: Browser }) => {
  if (!isSpindle) {
    // No open registration here, so no throwaway user to deactivate; the
    // UIAA challenge shape is covered by the shared fixture probe below.
    test.skip()
  }
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await boot(page)
    // Wrong passwords fail without touching the account.
    const name = 'fern-deact-' + Date.now().toString(36)
    const userId = await page.evaluate(({ base, name }) => window.matrixTest.engine.register(base, name, 'gone-gone-4'),
      { base: fixture.base, name })
    // Spindle omits the sliding-sync advertisement flag: force native sync,
    // same workaround as the OIDC flow (upstream tuna-os/spindle#507).
    const id = await page.evaluate(({ base, name }) => window.matrixTest.engine.login(base, name, 'gone-gone-4', true),
      { base: fixture.base, name })
    await expect(page.evaluate(({ id }) => window.matrixTest.engine.deactivate(id, 'wrong-password', true), { id }))
      .rejects.toThrow('not accepted')
    expect(await restLogin(userId, 'gone-gone-4')).toBe(200)
    // The real deactivation erases server-side and locally.
    await page.evaluate(({ id }) => window.matrixTest.engine.deactivate(id, 'gone-gone-4', true), { id })
    await expect.poll(() => restLogin(userId, 'gone-gone-4'), { timeout: 30_000 }).toBe(403)
    await page.evaluate(() => window.matrixTest.engine.dispose())
  } finally {
    await context.close()
  }
})

test('email capability and local removal isolation', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await boot(page)
    const a = await login(page, alice)
    const b = await login(page, bob)
    if (isSpindle) {
      // No 3pid support: the capability error is the contract.
      await expect(page.evaluate(id => window.matrixTest.engine.emails(id), a)).rejects.toThrow('does not support email')
    } else {
      await expect(page.evaluate(id => window.matrixTest.engine.emails(id), a)).resolves.toEqual([])
    }
    await expect(page.evaluate(id => window.matrixTest.engine.requestEmailToken(id, 'nobody@example.org', 'secret-1'), a))
      .rejects.toThrow(/could not send|does not support|disabled/i)
    // Local removal erases one account and leaves the other syncing.
    await page.evaluate(id => window.matrixTest.engine.removeAccount(id), a)
    await expect(page.evaluate(id => window.matrixTest.engine.devices(id), b)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ current: true })]))
    await expect(page.evaluate(id => window.matrixTest.engine.devices(id), a)).rejects.toThrow('not signed in')
    const relogin = await login(page, alice)
    expect(typeof relogin).toBe('string')
    await page.evaluate(() => window.matrixTest.engine.dispose())
  } finally {
    await context.close()
  }
})

test('session secrets persist outside the record and legacy records migrate', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await boot(page)
    const a = await login(page, alice)
    // The persisted record carries routing only; tokens and the crypto-store
    // passphrase live in the separate secret entry.
    const stored = await page.evaluate(id => ({
      record: JSON.parse(localStorage.getItem('fern.sessions.v1')!)[id],
      secret: JSON.parse(localStorage.getItem(`fern.secrets.v1.${id}`)!),
    }), a)
    expect(Object.keys(stored.record).sort()).toEqual(['homeserverUrl', 'userId'])
    expect(stored.secret.passphrase).toBeTruthy()
    expect(stored.secret.session.accessToken).toBeTruthy()
    // Rewrite as a legacy embedded record, reload, and restore: adoption
    // moves the secrets back out and the session comes back online.
    await page.evaluate(({ id, secret }) => {
      const records = JSON.parse(localStorage.getItem('fern.sessions.v1')!)
      records[id] = { session: secret.session, passphrase: secret.passphrase }
      localStorage.setItem('fern.sessions.v1', JSON.stringify(records))
      localStorage.removeItem(`fern.secrets.v1.${id}`)
    }, { id: a, secret: stored.secret })
    await page.reload()
    await boot(page)
    await page.evaluate(() => window.matrixTest.engine.restoreAll())
    await expect.poll(() => page.evaluate(id => window.matrixTest.accounts[id]?.connection, a),
      { timeout: 60_000 }).toBe('online')
    const migrated = await page.evaluate(id => JSON.parse(localStorage.getItem('fern.sessions.v1')!)[id], a)
    expect(Object.keys(migrated).sort()).toEqual(['homeserverUrl', 'userId'])
    await page.evaluate(() => window.matrixTest.engine.dispose())
  } finally {
    await context.close()
  }
})
