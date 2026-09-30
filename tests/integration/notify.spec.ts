import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { MatrixEngine } from '../../src/sdk/engine'
import type { Account, Room, Message } from '../../src/types'
import type { NotifyMode } from '../../src/sdk/engine'

// Notification rules (#23) against live homeservers: per-room mute and
// mentions-only round-trip through the server, restore returns to the
// account default, account defaults and mention toggles read and write.
// Browser notification behavior lives in tests/browser/notify.spec.ts.
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
async function mode(page: Page, id: string, roomId: string): Promise<{ mode: NotifyMode; custom: boolean }> {
  return page.evaluate(({ id, roomId }) => window.matrixTest.engine.roomNotify(id, roomId), { id, roomId })
}

test('per-room modes, account defaults and mention toggles round-trip', async ({ browser }) => {
  const ca = await browser.newContext()
  const cb = await browser.newContext()
  const pa = await ca.newPage()
  const pb = await cb.newPage()
  try {
    await boot(pa); await boot(pb)
    const a = await login(pa, alice)
    const b = await login(pb, bob)
    const roomId = await pa.evaluate(({ id, invite }) =>
      window.matrixTest.engine.createRoom(id, 'Notify fixture', 'notify rules', invite), { id: a, invite: bob.userId })
    await expect.poll(() => pb.evaluate(({ accountId, room }) =>
      window.matrixTest.rooms[accountId]?.some(item => item.id === room && item.membership === 'invited') ?? false,
    { accountId: b, room: roomId })).toBe(true)
    await pb.evaluate(({ id, roomId }) => window.matrixTest.engine.join(id, roomId), { id: b, roomId })

    // A fresh room follows the account default with no override.
    const fresh = await mode(pb, b, roomId)
    expect(fresh.custom).toBe(false)
    expect(['all', 'mentions', 'mute']).toContain(fresh.mode)

    // Mute then mentions-only round-trip through the server. Reads come
    // from the sync-fed push-rule cache, so poll for each transition.
    await pb.evaluate(({ id, roomId }) => window.matrixTest.engine.setRoomNotify(id, roomId, 'mute'), { id: b, roomId })
    await expect.poll(() => mode(pb, b, roomId)).toEqual({ mode: 'mute', custom: true })
    await pb.evaluate(({ id, roomId }) => window.matrixTest.engine.setRoomNotify(id, roomId, 'mentions'), { id: b, roomId })
    await expect.poll(() => mode(pb, b, roomId)).toEqual({ mode: 'mentions', custom: true })
    // Restoring drops the override.
    await pb.evaluate(({ id, roomId }) => window.matrixTest.engine.setRoomNotify(id, roomId, 'default'), { id: b, roomId })
    await expect.poll(() => mode(pb, b, roomId)).toEqual({ mode: fresh.mode, custom: false })

    // Unknown rooms fail instead of inventing a mode.
    await expect(pb.evaluate(({ id }) => window.matrixTest.engine.roomNotify(id, '!missing:example'), { id: b }))
      .rejects.toThrow(/.+/)

    // Account defaults cover all four room kinds and persist a change.
    const before = await pa.evaluate(({ id }) => window.matrixTest.engine.notifyDefaults(id), { id: a })
    expect(before).toHaveLength(4)
    // Account defaults only span all messages and mentions-only: muting is
    // a per-room override, and the API rejects it to keep reads honest.
    await expect(pa.evaluate(({ id }) => window.matrixTest.engine.setNotifyDefault(id, true, false, 'mute' as never), { id: a }))
      .rejects.toThrow(/mute/i)
    await pa.evaluate(({ id }) => window.matrixTest.engine.setNotifyDefault(id, true, false, 'mentions'), { id: a })
    await expect.poll(() => pa.evaluate(({ id }) => window.matrixTest.engine.notifyDefaults(id)
      .then(all => all.find(entry => entry.encrypted && !entry.direct)?.mode), { id: a })).toBe('mentions')
    await pa.evaluate(({ id }) => window.matrixTest.engine.setNotifyDefault(id, true, false, 'all'), { id: a })
    await expect.poll(() => pa.evaluate(({ id }) => window.matrixTest.engine.notifyDefaults(id)
      .then(all => all.find(entry => entry.encrypted && !entry.direct)?.mode), { id: a })).toBe('all')

    // Mention toggles read and flip.
    const toggles = await pa.evaluate(({ id }) => window.matrixTest.engine.mentionToggles(id), { id: a })
    expect(typeof toggles.user).toBe('boolean')
    expect(typeof toggles.room).toBe('boolean')
    await pa.evaluate(({ id, enabled }) => window.matrixTest.engine.setMentionToggle(id, 'user', enabled),
      { id: a, enabled: !toggles.user })
    expect((await pa.evaluate(({ id }) => window.matrixTest.engine.mentionToggles(id), { id: a })).user).toBe(!toggles.user)
    await pa.evaluate(({ id, enabled }) => window.matrixTest.engine.setMentionToggle(id, 'user', enabled),
      { id: a, enabled: toggles.user })
  } finally {
    await ca.close(); await cb.close()
  }
})
