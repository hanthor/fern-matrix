import { test, expect, type Page } from '@playwright/test'
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
const fixture: Fixture = JSON.parse(readFileSync(process.env.FERN_MATRIX_FIXTURE!, 'utf8'))
const [alice] = fixture.users

// MSC4108 login-code bytes: MATRIX + version + intent + key + rendezvous URL
// (+ server name for reciprocate intent).
function loginBytes(intent: number, rendezvous: string, server?: string): number[] {
  const out: number[] = [77, 65, 84, 82, 73, 88, 2, intent, ...new Array(32).fill(7)]
  const url = [...rendezvous].map(c => c.charCodeAt(0))
  out.push((url.length >> 8) & 0xff, url.length & 0xff, ...url)
  if (server !== undefined) {
    const name = [...server].map(c => c.charCodeAt(0))
    out.push((name.length >> 8) & 0xff, name.length & 0xff, ...name)
  }
  return out
}

async function boot(page: Page) {
  await page.goto('http://127.0.0.1:5173/tests/integration/client.html')
  await page.evaluate(async () => {
    // @ts-expect-error This path is resolved by Vite in the browser.
    const { MatrixEngine } = await import('/src/sdk/engine.ts')
    // @ts-expect-error This path is resolved by Vite in the browser.
    const qr = await import('/src/qr.ts')
    const state = { engine: undefined as unknown as MatrixEngine,
      accounts: {}, rooms: {}, messages: {}, typing: {}, errors: [], stops: [], verification: [] } as Window['matrixTest']
    state.engine = new MatrixEngine({
      account: (account: Account) => { state.accounts[account.id] = account },
      rooms: (accountId: string, rooms: Room[]) => { state.rooms[accountId] = rooms },
      error: () => {},
    })
    window.matrixTest = state
    ;(window as unknown as { qrTest: unknown }).qrTest = qr
  })
}
function decode(page: Page, bytes: number[]) {
  return page.evaluate((raw: number[]) => (window as unknown as { qrTest: {
    decodeQrLoginBytes: (bytes: Uint8Array) => Promise<{ serverName?: string }> } }).qrTest.decodeQrLoginBytes(new Uint8Array(raw)), bytes)
}

test('qr login codes decode with actionable failures', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await boot(page)
    // Valid codes decode: login intent carries no server, reciprocate does.
    await expect(decode(page, loginBytes(3, 'http://127.0.0.1:9/x'))).resolves.toEqual({})
    await expect(decode(page, loginBytes(4, 'http://127.0.0.1:9/x', 'example:x'))).resolves.toEqual({ serverName: 'example:x' })
    // Corrupt codes fail before any server is contacted.
    await expect(decode(page, [1, 2, 3, 4])).rejects.toThrow('incomplete or damaged')
    await expect(decode(page, [77, 65, 84, 82, 73, 89, 2, 3])).rejects.toThrow('not a Matrix sign-in code')
    await expect(decode(page, [77, 65, 84, 82, 73, 88, 9, 3])).rejects.toThrow('not a Matrix sign-in code')
    await expect(decode(page, [77, 65, 84, 82, 73, 88, 2, 9])).rejects.toThrow('not a Matrix sign-in code')
    await expect(decode(page, [77, 65, 84, 82, 73, 88, 2, 3, 7])).rejects.toThrow('incomplete or damaged')
  } finally {
    await context.close()
  }
})

test('qr grant scan fails actionably without a live peer', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await boot(page)
    const id = await page.evaluate(({ base, username, password }) => window.matrixTest.engine.login(base, username, password),
      { base: fixture.base, username: alice.username, password: alice.password })
    // A well-formed code pointing at a dead relay cannot complete: the scan
    // rejects instead of hanging, with an actionable message.
    const bytes = loginBytes(3, 'http://127.0.0.1:9/x')
    const outcome = await page.evaluate(async ({ id, bytes }) => {
      const stages: string[] = []
      try {
        await window.matrixTest.engine.grantQrLogin(id, new Uint8Array(bytes),
          state => { stages.push(state.stage) })
        return 'unexpected-success:' + stages.join(',')
      } catch (error) {
        return 'rejected:' + (error instanceof Error ? error.message : String(error)).slice(0, 140) + '|stages:' + stages.join(',')
      }
    }, { id, bytes })
    expect(outcome).toMatch(/^rejected:/)
    expect(outcome).not.toMatch(/unexpected-success/)
    // Aborting the scan cancels silently through the signal path.
    const cancelled = await page.evaluate(async ({ id, bytes }) => {
      const controller = new AbortController()
      controller.abort()
      try {
        await window.matrixTest.engine.grantQrLogin(id, new Uint8Array(bytes), () => {}, controller.signal)
        return 'unexpected-success'
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }, { id, bytes })
    expect(cancelled).toMatch(/cancel/i)
    await page.evaluate(id => window.matrixTest.engine.dispose(), id)
  } finally {
    await context.close()
  }
})
