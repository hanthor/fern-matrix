import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { MatrixEngine } from '../../src/sdk/engine'
import type { Account, Room, Message } from '../../src/types'

// Invitations, upgrades and discovery failures (#22) against live
// homeservers: a tombstoned room advertises its replacement to both
// members, remote and knock-guarded joins fail actionably with the session
// intact. Directory, invite acceptance and DM creation live in
// tests/integration/core.spec.ts; link routing in tests/browser/client.spec.ts.
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
async function successor(page: Page, accountId: string, roomId: string): Promise<string | undefined> {
  return page.evaluate(({ accountId, roomId }) =>
    window.matrixTest.rooms[accountId]?.find(room => room.id === roomId)?.successor, { accountId, roomId })
}

test('tombstoned room advertises its replacement and failed joins stay actionable', async ({ browser }) => {
  const ca = await browser.newContext()
  const cb = await browser.newContext()
  const pa = await ca.newPage()
  const pb = await cb.newPage()
  try {
    await boot(pa); await boot(pb)
    const a = await login(pa, alice)
    const b = await login(pb, bob)

    // A reason is required before anything reaches the server.
    const oldId = await pa.evaluate(({ id, invite }) =>
      window.matrixTest.engine.createRoom(id, 'Old room', 'upgrade fixture', invite), { id: a, invite: bob.userId })
    await expect.poll(() => pb.evaluate(({ accountId, room }) =>
      window.matrixTest.rooms[accountId]?.some(item => item.id === room && item.membership === 'invited') ?? false,
    { accountId: b, room: oldId })).toBe(true)
    await pb.evaluate(({ id, roomId }) => window.matrixTest.engine.join(id, roomId), { id: b, roomId: oldId })
    const newId = await pa.evaluate(({ id, invite }) =>
      window.matrixTest.engine.createRoom(id, 'New room', 'upgrade target', invite), { id: a, invite: bob.userId })
    await expect(pa.evaluate(({ id, roomId }) => window.matrixTest.engine.tombstoneRoom(id, roomId, 'x', '  '),
      { id: a, roomId: oldId })).rejects.toThrow(/why/)
    await pa.evaluate(({ id, roomId, replacement }) => window.matrixTest.engine.tombstoneRoom(id, roomId, replacement, 'moved to version 2'),
      { id: a, roomId: oldId, replacement: newId })

    // Both members learn the replacement; the old room stays joined.
    await expect.poll(() => successor(pa, a, oldId)).toBe(newId)
    await expect.poll(() => successor(pb, b, oldId)).toBe(newId)
    const membership = await pb.evaluate(({ accountId, room }) =>
      window.matrixTest.rooms[accountId]?.find(item => item.id === room)?.membership, { accountId: b, room: oldId })
    expect(membership).toBe('joined')
    await pb.evaluate(({ id, roomId }) => window.matrixTest.engine.join(id, roomId), { id: b, roomId: newId })
    const joined = await pb.evaluate(({ accountId, room }) =>
      window.matrixTest.rooms[accountId]?.some(item => item.id === room && item.membership === 'joined') ?? false,
    { accountId: b, room: newId })
    expect(joined).toBe(true)

    // A knock-guarded room refuses a direct join with a mapped error.
    const knockId = await pa.evaluate(({ id }) => window.matrixTest.engine.createRoom(id, 'Knock room', 'knock fixture'), { id: a })
    await pa.evaluate(({ id, roomId }) => window.matrixTest.engine.saveRoomSettings(id, roomId,
      { name: 'Knock room', topic: 'knock fixture', historyVisibility: 'shared', joinRule: 'knock' }), { id: a, roomId: knockId })
    await expect(pb.evaluate(({ id, roomId }) => window.matrixTest.engine.join(id, roomId), { id: b, roomId: knockId }))
      .rejects.toThrow(/refused|forbidden|permission|not.*invit|join/i)

    // A remote alias that resolves nowhere fails actionably and the
    // session keeps working afterwards.
    await expect(pb.evaluate(({ id }) => window.matrixTest.engine.join(id, '#missing:unreachable.invalid'), { id: b }))
      .rejects.toThrow(/.+/)
    const stillThere = await pb.evaluate(({ accountId, room }) =>
      window.matrixTest.rooms[accountId]?.some(item => item.id === room) ?? false, { accountId: b, room: oldId })
    expect(stillThere).toBe(true)
  } finally {
    await ca.close(); await cb.close()
  }
})
