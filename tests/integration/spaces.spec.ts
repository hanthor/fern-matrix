import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { MatrixEngine } from '../../src/sdk/engine'
import type { Account, Room, Message, SpaceChild } from '../../src/types'

// Space creation, editing and hierarchy management (#21) against live
// homeservers: an admin creates a space, organizes rooms and a subspace,
// edits the space profile, and a member is denied, sees the shared
// hierarchy from their own client, but not an inaccessible child.
// UI validation and demo paths live in tests/browser/spaces.spec.ts.
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
async function children(page: Page, id: string, spaceId: string): Promise<SpaceChild[]> {
  return page.evaluate(({ id, spaceId }) => window.matrixTest.engine.spaceChildren(id, spaceId), { id, spaceId })
}
async function childIds(page: Page, id: string, spaceId: string): Promise<string[]> {
  return (await children(page, id, spaceId)).map(entry => entry.id)
}
// FFI mutation refusals carry the Matrix errcode in the inner payload
// (the message is a bare tag), so surface tag/code/kind for assertions.
async function childError(page: Page, id: string, spaceId: string, childId: string): Promise<string> {
  return page.evaluate(async ({ id, spaceId, childId }) => {
    try { await window.matrixTest.engine.addSpaceChild(id, spaceId, childId); return 'added' }
    catch (error) { const inner = error as { tag?: string; inner?: { code?: string; kind?: { tag?: string } }; message?: string }
      return [inner?.tag, inner?.inner?.code, inner?.inner?.kind?.tag, inner?.message].filter(Boolean).join('/') }
  }, { id, spaceId, childId })
}

test('admin organizes a space hierarchy, member is denied and sees shared children', async ({ browser }) => {
  const ca = await browser.newContext()
  const cb = await browser.newContext()
  const pa = await ca.newPage()
  const pb = await cb.newPage()
  try {
    await boot(pa); await boot(pb)
    const a = await login(pa, alice)
    const b = await login(pb, bob)

    // Empty names never reach the server.
    await expect(pa.evaluate(({ id }) => window.matrixTest.engine.createSpace(id, '  ', 'no name'), { id: a }))
      .rejects.toThrow(/name/)

    const spaceId = await pa.evaluate(({ id }) => window.matrixTest.engine.createSpace(id, 'Hierarchy home', 'space fixture'), { id: a })
    await expect.poll(() => pa.evaluate(({ accountId, space }) =>
      window.matrixTest.rooms[accountId]?.some(room => room.id === space && room.space && room.membership === 'joined') ?? false,
    { accountId: a, space: spaceId })).toBe(true)

    // The creator may organize; a space starts childless.
    await expect.poll(() => pa.evaluate(({ id, spaceId }) => window.matrixTest.engine.editableSpaces(id)
      .then(spaces => spaces.includes(spaceId)), { id: a, spaceId })).toBe(true)
    expect(await childIds(pa, a, spaceId)).toEqual([])

    const roomId = await pa.evaluate(({ id, invite }) =>
      window.matrixTest.engine.createRoom(id, 'Child room', 'child fixture', invite), { id: a, invite: bob.userId })
    await pa.evaluate(({ id, spaceId, childId }) => window.matrixTest.engine.addSpaceChild(id, spaceId, childId),
      { id: a, spaceId, childId: roomId })
    await expect.poll(() => childIds(pa, a, spaceId)).toContain(roomId)

    // An outsider cannot organize the space.
    expect(await childError(pb, b, spaceId, roomId)).toMatch(/M_FORBIDDEN|Forbidden|MatrixApi|refused|moderators/i)

    // Membership organizes visibility: once invited and joined, the member
    // reads the shared hierarchy from their own client.
    await pa.evaluate(({ id, spaceId, user }) => window.matrixTest.engine.invite(id, spaceId, user),
      { id: a, spaceId, user: bob.userId })
    await pb.evaluate(({ id, spaceId }) => window.matrixTest.engine.join(id, spaceId), { id: b, spaceId })
    await expect.poll(() => childIds(pb, b, spaceId)).toContain(roomId)

    // An invite-only child the member cannot join stays invisible to them
    // while the admin still lists it: inaccessible children are omitted,
    // not errors.
    const hiddenId = await pa.evaluate(({ id }) => window.matrixTest.engine.createRoom(id, 'Hidden room', 'hidden fixture'), { id: a })
    await pa.evaluate(({ id, spaceId, childId }) => window.matrixTest.engine.addSpaceChild(id, spaceId, childId),
      { id: a, spaceId, childId: hiddenId })
    await expect.poll(() => childIds(pa, a, spaceId)).toContain(hiddenId)
    await expect.poll(() => childIds(pb, b, spaceId)).toContain(roomId)
    await new Promise(resolve => setTimeout(resolve, 5000))
    expect(await childIds(pb, b, spaceId)).not.toContain(hiddenId)

    // Spaces edit through the same room-settings path as rooms.
    await pa.evaluate(({ id, spaceId }) => window.matrixTest.engine.saveRoomSettings(id, spaceId,
      { name: 'Hierarchy edited', topic: 'space fixture', historyVisibility: 'shared', joinRule: 'invite' }), { id: a, spaceId })
    const edited = await pa.evaluate(({ id, spaceId }) => window.matrixTest.engine.roomSettings(id, spaceId), { id: a, spaceId })
    expect(edited.name).toBe('Hierarchy edited')

    // Nested hierarchy: a subspace carries its own children.
    const nestedId = await pa.evaluate(({ id }) => window.matrixTest.engine.createSpace(id, 'Nested space', 'nested fixture'), { id: a })
    await pa.evaluate(({ id, spaceId, childId }) => window.matrixTest.engine.addSpaceChild(id, spaceId, childId),
      { id: a, spaceId, childId: nestedId })
    const leafId = await pa.evaluate(({ id }) => window.matrixTest.engine.createRoom(id, 'Leaf room', 'leaf fixture'), { id: a })
    await pa.evaluate(({ id, spaceId, childId }) => window.matrixTest.engine.addSpaceChild(id, spaceId, childId),
      { id: a, spaceId: nestedId, childId: leafId })
    await expect.poll(() => childIds(pa, a, spaceId)).toContain(nestedId)
    await expect.poll(() => childIds(pa, a, nestedId)).toContain(leafId)

    // A cycle attempt is refused or, if the server ever allowed it, the
    // listing still terminates instead of spinning on the graph.
    await childError(pa, a, nestedId, spaceId)
    expect((await children(pa, a, spaceId)).length).toBeLessThan(50)

    // Removal drops the child for both clients.
    await pa.evaluate(({ id, spaceId, childId }) => window.matrixTest.engine.removeSpaceChild(id, spaceId, childId),
      { id: a, spaceId, childId: roomId })
    await expect.poll(() => childIds(pa, a, spaceId)).not.toContain(roomId)
    await expect.poll(() => childIds(pb, b, spaceId)).not.toContain(roomId)
  } finally {
    await ca.close(); await cb.close()
  }
})
