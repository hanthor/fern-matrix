import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { MatrixEngine } from '../../src/sdk/engine'
import type { Account, Room, Message } from '../../src/types'

// User safety (#27) against live homeservers: ignoring is per-account and
// invisible to the other side, unignoring restores, and reporting sends the
// encrypted event to the room's server with a required reason. Display,
// mention and notification filtering live in tests/safety.test.ts with demo
// paths in tests/browser/safety.spec.ts.
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
      messages: (accountId: string, roomId: string, messages: Message[]) => { state.messages[`${accountId}/${roomId}`] = messages },
    })
    window.matrixTest = state
  })
}
async function login(page: Page, user: FixtureUser) {
  return page.evaluate(({ base, username, password }) => window.matrixTest.engine.login(base, username, password),
    { base: fixture.base, username: user.username, password: user.password })
}
async function ignored(page: Page, id: string) {
  return page.evaluate(({ id }) => window.matrixTest.engine.ignoredUsers(id), { id })
}

test('ignore is personal, reports reach the server with a reason', async ({ browser }) => {
  const ca = await browser.newContext()
  const cb = await browser.newContext()
  const pa = await ca.newPage()
  const pb = await cb.newPage()
  try {
    await boot(pa); await boot(pb)
    const a = await login(pa, alice)
    const b = await login(pb, bob)
    const roomId = await pa.evaluate(({ id, invite }) =>
      window.matrixTest.engine.createRoom(id, 'Safety fixture', 'ignore and report', invite), { id: a, invite: bob.userId })
    await expect.poll(() => pb.evaluate(({ accountId, room }) =>
      window.matrixTest.rooms[accountId]?.some(item => item.id === room && item.membership === 'invited') ?? false,
    { accountId: b, room: roomId })).toBe(true)
    await pb.evaluate(({ id, roomId }) => window.matrixTest.engine.join(id, roomId), { id: b, roomId })

    // Both sides start with a clean list; nobody can ignore themselves.
    expect(await ignored(pb, b)).toEqual([])
    await expect(pb.evaluate(({ id, user }) => window.matrixTest.engine.setIgnored(id, user, true),
      { id: b, user: bob.userId })).rejects.toThrow(/yourself/)

    // Bob ignores Alice: his list changes, hers does not.
    await pb.evaluate(({ id, user }) => window.matrixTest.engine.setIgnored(id, user, true),
      { id: b, user: alice.userId })
    await expect.poll(() => ignored(pb, b)).toContain(alice.userId)
    expect(await ignored(pa, a)).toEqual([])
    // Unignoring restores the empty list.
    await pb.evaluate(({ id, user }) => window.matrixTest.engine.setIgnored(id, user, false),
      { id: b, user: alice.userId })
    await expect.poll(() => ignored(pb, b)).toEqual([])

    // Reporting needs a reason and a real event: Alice posts in the
    // encrypted room, Bob reports what he receives.
    await pa.evaluate(({ id, roomId }) => window.matrixTest.engine.send(id, roomId, 'reported fixture message'),
      { id: a, roomId })
    await pb.evaluate(({ id, roomId }) => window.matrixTest.engine.watchRoom(id, roomId,
      (updated: Message[]) => { window.matrixTest.messages[`${id}/${roomId}`] = updated }, () => {}), { id: b, roomId })
    await expect.poll(() => pb.evaluate(({ accountId, roomId }) =>
      window.matrixTest.messages[`${accountId}/${roomId}`]?.find(item => item.body === 'reported fixture message')?.id,
    { accountId: b, roomId })).not.toBeUndefined()
    const eventId = await pb.evaluate(({ accountId, roomId }) =>
      window.matrixTest.messages[`${accountId}/${roomId}`]?.find(item => item.body === 'reported fixture message')?.id,
    { accountId: b, roomId })
    await expect(pb.evaluate(({ id, roomId }) => window.matrixTest.engine.reportEvent(id, roomId, 'missing', '  '),
      { id: b, roomId })).rejects.toThrow(/abusive|why/)
    await pb.evaluate(({ id, roomId, event }) => window.matrixTest.engine.reportEvent(id, roomId, event, 'spam fixture'),
      { id: b, roomId, event: String(eventId) })
    // Reporting a missing event fails instead of pretending.
    await expect(pb.evaluate(({ id, roomId }) => window.matrixTest.engine.reportEvent(id, roomId, '$missing:example', 'spam fixture'),
      { id: b, roomId })).rejects.toThrow(/report/i)
  } finally {
    await ca.close(); await cb.close()
  }
})
