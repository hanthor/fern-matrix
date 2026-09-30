import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { MatrixEngine } from '../../src/sdk/engine'
import type { Account, Room, Message } from '../../src/types'

interface FixtureUser { username: string; password: string; userId: string; token: string }
interface Fixture { base: string; version: string; users: FixtureUser[] }
const fixture: Fixture = JSON.parse(readFileSync(process.env.FERN_MATRIX_FIXTURE ?? process.env.FERN_OIDC_FIXTURE!, 'utf8'))
const [alice] = fixture.users
declare global {
  interface Window {
    matrixTest: { engine: MatrixEngine; accounts: Record<string, Account>; rooms: Record<string, Room[]>;
      messages: Record<string, Message[]>; typing: Record<string, string[]>; errors: string[]; stops: (() => void)[];
      verification: { status: string; emojis?: { symbol: string; description: string }[]; numbers?: number[] }[] }
  }
}

test('expiry emission probe', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
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
    const login = (username: string, password: string) => page.evaluate(({ base, username, password }) =>
      window.matrixTest.engine.login(base, username, password, true), { base: fixture.base, username, password })
    const a1 = await login(alice.username, alice.password)
    const a2 = await login(alice.username, alice.password)
    await page.evaluate(() => {
      (window as unknown as { emissionLog: string[] }).emissionLog = []
    })
    await page.evaluate(({ id, current }) => window.matrixTest.engine.changePassword(id, current, 'rotated-rotated-9', true),
      { id: a1, current: alice.password })
    for (let round = 0; round < 6; round++) {
      await new Promise(resolve => setTimeout(resolve, 10000))
      const snapshot = await page.evaluate(id => ({
        account: window.matrixTest.accounts[id],
        errors: window.matrixTest.errors.slice(-3),
      }), a2)
      console.log('PROBE_T' + round + ' ' + JSON.stringify(snapshot).slice(0, 400))
    }
    const a3 = await login(alice.username, 'rotated-rotated-9')
    await page.evaluate(({ id, password }) => window.matrixTest.engine.changePassword(id, 'rotated-rotated-9', password, true), { id: a3, password: alice.password })
    await page.evaluate(() => window.matrixTest.engine.dispose())
  } finally {
    await context.close()
  }
})
