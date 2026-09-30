import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { MatrixEngine } from '../../src/sdk/engine'
import type { Account, Room, Message } from '../../src/types'

// Room settings and member management (#20) against live homeservers:
// an admin edits name/topic/avatar/history/join-rule, a member is denied,
// promoted to moderator, then removed, banned, unbanned and re-invited.
// UI validation and demo paths live in tests/browser/rooms.spec.ts.
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
// 1x1 transparent PNG for the room picture round trip.
const png = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5, 0, 1, 13, 10, 45, 180, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]

test('admin edits settings, member is denied, promoted, removed, banned and re-invited', async ({ browser }) => {
  const ca = await browser.newContext()
  const cb = await browser.newContext()
  const pa = await ca.newPage()
  const pb = await cb.newPage()
  try {
    await boot(pa); await boot(pb)
    const a = await login(pa, alice)
    const b = await login(pb, bob)
    const roomId = await pa.evaluate(({ id, invite }) =>
      window.matrixTest.engine.createRoom(id, 'Settings original', 'settings fixture', invite), { id: a, invite: bob.userId })
    await expect.poll(() => pb.evaluate(({ accountId, room }) =>
      window.matrixTest.rooms[accountId]?.some(item => item.id === room && item.membership === 'invited') ?? false,
    { accountId: b, room: roomId })).toBe(true)
    await pb.evaluate(({ id, roomId }) => window.matrixTest.engine.join(id, roomId), { id: b, roomId })
    await watch(pa, a, roomId); await watch(pb, b, roomId)

    // Admin reads full settings; creator holds top power.
    const before = await pa.evaluate(({ id, roomId }) => window.matrixTest.engine.roomSettings(id, roomId), { id: a, roomId })
    expect(before.name).toBe('Settings original')
    expect(before.permissions.state).toBe(true)
    expect(before.permissions.own).toBeGreaterThanOrEqual(50)

    // Admin edits name, topic, picture, history and join rule in one pass.
    await pa.evaluate(({ id, roomId, png }) => window.matrixTest.engine.saveRoomSettings(id, roomId, {
      name: 'Settings edited', topic: 'edited fixture', historyVisibility: 'invited', joinRule: 'knock',
      avatar: { mime: 'image/png', data: new Uint8Array(png).buffer },
    }), { id: a, roomId, png })
    const edited = await pa.evaluate(({ id, roomId }) => window.matrixTest.engine.roomSettings(id, roomId), { id: a, roomId })
    expect(edited.name).toBe('Settings edited')
    expect(edited.topic).toBe('edited fixture')
    expect(edited.historyVisibility).toBe('invited')
    expect(edited.joinRule).toBe('knock')
    expect(edited.avatar.startsWith('mxc://')).toBe(true)

    // An ordinary member is refused with an actionable server error.
    await expect(pb.evaluate(({ id, roomId }) => window.matrixTest.engine.saveRoomSettings(id, roomId,
      { name: 'Member takeover', topic: '', historyVisibility: 'shared', joinRule: 'invite' }), { id: b, roomId }))
      .rejects.toThrow(/refused|permission|power/i)

    // Promotion to moderator unlocks settings for the member.
    await pa.evaluate(({ id, roomId, user }) => window.matrixTest.engine.setPowerLevel(id, roomId, user, 50),
      { id: a, roomId, user: bob.userId })
    const promoted = await pa.evaluate(({ id, roomId }) => window.matrixTest.engine.roomSettings(id, roomId), { id: a, roomId })
    expect(promoted.power?.users[bob.userId]).toBe(50)
    await pb.evaluate(({ id, roomId }) => window.matrixTest.engine.saveRoomSettings(id, roomId,
      { name: 'Settings by moderator', topic: 'edited fixture', historyVisibility: 'invited', joinRule: 'knock' }), { id: b, roomId })
    const moderator = await pa.evaluate(({ id, roomId }) => window.matrixTest.engine.roomSettings(id, roomId), { id: a, roomId })
    expect(moderator.name).toBe('Settings by moderator')

    // Levels outside 0-100 never reach the server.
    await expect(pa.evaluate(({ id, roomId, user }) => window.matrixTest.engine.setPowerLevel(id, roomId, user, 150),
      { id: a, roomId, user: bob.userId })).rejects.toThrow(/0 to 100/)

    // Removal, ban, unban and re-invite form a full cycle.
    await pa.evaluate(({ id, roomId, user }) => window.matrixTest.engine.moderate(id, roomId, 'kick', user),
      { id: a, roomId, user: bob.userId })
    await expect.poll(() => pa.evaluate(({ id, roomId, user }) => window.matrixTest.engine.members(id, roomId)
      .then(members => members.some(member => member.id === user)), { id: a, roomId, user: bob.userId })).toBe(false)
    await pa.evaluate(({ id, roomId, user }) => window.matrixTest.engine.moderate(id, roomId, 'ban', user),
      { id: a, roomId, user: bob.userId })
    // The FFI join refusal carries the Matrix errcode in its inner payload
    // (its message is a bare tag). Synapse refuses a banned user's join
    // with 403 M_BAD_STATE ("Cannot join user who was banned").
    const bannedJoin = await pb.evaluate(async ({ id, roomId }) => {
      try { await window.matrixTest.engine.join(id, roomId); return 'joined' }
      catch (error) { const inner = error as { tag?: string; inner?: { code?: string; kind?: { tag?: string } } }
        return [inner?.tag, inner?.inner?.code, inner?.inner?.kind?.tag].filter(Boolean).join('/') }
    }, { id: b, roomId })
    expect(bannedJoin).toMatch(/M_BAD_STATE|M_FORBIDDEN|Forbidden/)
    await pa.evaluate(({ id, roomId, user }) => window.matrixTest.engine.moderate(id, roomId, 'unban', user),
      { id: a, roomId, user: bob.userId })
    await pa.evaluate(({ id, roomId, user }) => window.matrixTest.engine.invite(id, roomId, user),
      { id: a, roomId, user: bob.userId })
    await pb.evaluate(({ id, roomId }) => window.matrixTest.engine.join(id, roomId), { id: b, roomId })
    await expect.poll(() => pa.evaluate(({ id, roomId, user }) => window.matrixTest.engine.members(id, roomId)
      .then(members => members.some(member => member.id === user)), { id: a, roomId, user: bob.userId })).toBe(true)
  } finally {
    await ca.close(); await cb.close()
  }
})
