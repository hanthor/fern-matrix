import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { MatrixEngine } from '../../src/sdk/engine'
import type { Account, Room, Message } from '../../src/types'
import type { KnockRequest } from '../../src/knock'

// Knock requests (#41) against live homeservers: knocking, moderator review,
// accept-by-invite, decline-by-kick and the invite-only refusal, across two
// engine clients. Restricted-room server-name routing stays a documented
// follow-up: this homeserver pair needs no extra authorization.
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

async function login(page: Page, user: FixtureUser): Promise<string> {
  return page.evaluate(({ base, username, password }) =>
    window.matrixTest.engine.login(base, username, password),
    { base: fixture.base, username: user.username, password: user.password })
}

async function setJoinRule(roomId: string, rule: string) {
  const response = await fetch(`${fixture.base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.join_rules/`, {
    method: 'PUT', headers: { Authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ join_rule: rule }),
  })
  if (!response.ok) throw new Error(`put join rule failed: ${response.status}`)
}

test('knock, review, accept and decline across two live clients', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await boot(page)
    const a = await login(page, alice)
    const b = await login(page, bob)
    const roomId: string = await page.evaluate(({ id }) =>
      window.matrixTest.engine.createRoom(id, 'Knock fixture', 'knock moderation', undefined), { id: a })
    await setJoinRule(roomId, 'knock')

    await page.evaluate(({ id, roomId }) => window.matrixTest.engine.knockRoom(id, roomId), { id: b, roomId })
    await expect.poll(() => page.evaluate(({ id, roomId }) =>
      window.matrixTest.engine.pollKnockRequests(id, roomId), { id: a, roomId })).toEqual([{ userId: bob.userId }])

    await page.evaluate(({ id, roomId, userId }) =>
      window.matrixTest.engine.answerKnock(id, roomId, userId, true), { id: a, roomId, userId: bob.userId })
    await expect.poll(() => page.evaluate(({ id, roomId }) =>
      (window.matrixTest.rooms[id] ?? []).some(room => room.id === roomId), { id: b, roomId })).toBe(true)
    const afterAccept: KnockRequest[] = await page.evaluate(({ id, roomId }) =>
      window.matrixTest.engine.pollKnockRequests(id, roomId), { id: a, roomId })
    expect(afterAccept).toEqual([])

    await page.evaluate(({ id, roomId }) => window.matrixTest.engine.leave(id, roomId), { id: b, roomId })
    await page.evaluate(({ id, roomId }) => window.matrixTest.engine.knockRoom(id, roomId), { id: b, roomId })
    await expect.poll(() => page.evaluate(({ id, roomId }) =>
      window.matrixTest.engine.pollKnockRequests(id, roomId), { id: a, roomId })).toEqual([{ userId: bob.userId }])
    await page.evaluate(({ id, roomId, userId }) =>
      window.matrixTest.engine.answerKnock(id, roomId, userId, false), { id: a, roomId, userId: bob.userId })
    // The declined knocker is out server-side: membership reads 'leave'.
    const membership = await fetch(`${fixture.base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(bob.userId)}`, {
      headers: { Authorization: `Bearer ${alice.token}` },
    }).then(async response => (await response.json()).membership)
    expect(membership).toBe('leave')
    const afterDecline: KnockRequest[] = await page.evaluate(({ id, roomId }) =>
      window.matrixTest.engine.pollKnockRequests(id, roomId), { id: a, roomId })
    expect(afterDecline).toEqual([])

    // Account isolation: the declined knocker cannot accept their own knock.
    await expect(page.evaluate(({ id, roomId, userId }) =>
      window.matrixTest.engine.answerKnock(id, roomId, userId, true), { id: b, roomId, userId: bob.userId })).rejects.toThrow(/refused|not in room|could not be accepted/)
  } finally {
    await context.close()
  }
})

test('knocking on an invite-only room fails actionably', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await boot(page)
    const a = await login(page, alice)
    const b = await login(page, bob)
    const roomId: string = await page.evaluate(({ id }) =>
      window.matrixTest.engine.createRoom(id, 'Private fixture', 'no knocks', undefined), { id: a })
    await expect(page.evaluate(({ id, roomId }) =>
      window.matrixTest.engine.knockRoom(id, roomId), { id: b, roomId })).rejects.toThrow()
  } finally {
    await context.close()
  }
})
