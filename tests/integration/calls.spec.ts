import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { MatrixEngine } from '../../src/sdk/engine'
import type { Account, Room, Message } from '../../src/types'

// Calls (#25) against live homeservers: starting a call first checks
// MatrixRTC support and fails with an actionable compatibility error when
// the homeserver does not advertise it, without side effects. Live
// two-party media needs an RTC-capable homeserver plus real media devices
// and is tracked as the remaining gap on the issue.
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

test('call start is gated on advertised MatrixRTC support', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await boot(page)
    const a: string = await page.evaluate(({ base, username, password }) =>
      window.matrixTest.engine.login(base, username, password),
      { base: fixture.base, username: alice.username, password: alice.password })
    const roomId: string = await page.evaluate(({ id, invite }) =>
      window.matrixTest.engine.createRoom(id, 'Call fixture', 'rtc gate', invite), { id: a, invite: bob.userId })
    const frame = await page.evaluateHandle(() => document.createElement('iframe'))
    const outcome: string = await page.evaluate(async ({ id, roomId }) => {
      try {
        const stop = await window.matrixTest.engine.startCall(id, roomId,
          document.createElement('iframe'), () => {})
        stop()
        return 'started'
      } catch (error) { return error instanceof Error ? error.message : String(error) }
    }, { id: a, roomId })
    // The disposable Synapse advertises no MatrixRTC support: the call must
    // refuse with the compatibility error, never a half-open widget.
    expect(outcome).toMatch(/does not advertise MatrixRTC support/)
    // The session is untouched by the refused call.
    const rooms = await page.evaluate(({ id }) => window.matrixTest.rooms[id]?.length ?? 0, { id: a })
    expect(rooms).toBeGreaterThan(0)
    await frame.dispose()
  } finally {
    await context.close()
  }
})
