import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { MatrixEngine } from '../../src/sdk/engine'
import type { Account, Room, Message } from '../../src/types'
import type { WidgetInfo } from '../../src/widgets'

// Room widgets (#45) against live homeservers: widget state events written
// over REST are discovered through the engine's server-authoritative state
// read, unknown types refuse with an actionable message before anything
// loads, and live widget media still gates on #25 (same RTC block as calls).
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

async function putWidget(base: string, token: string, roomId: string, stateKey: string, content: unknown) {
  const response = await fetch(`${base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.widget/${encodeURIComponent(stateKey)}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(content),
  })
  if (!response.ok) throw new Error(`put widget state failed: ${response.status}`)
}

test('room widget state is discovered live and unknown types refuse', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await boot(page)
    const a: string = await page.evaluate(({ base, username, password }) =>
      window.matrixTest.engine.login(base, username, password),
      { base: fixture.base, username: alice.username, password: alice.password })
    const roomId: string = await page.evaluate(({ id }) =>
      window.matrixTest.engine.createRoom(id, 'Widget fixture', 'widget discovery', undefined), { id: a })
    await putWidget(fixture.base, alice.token, roomId, 'standup',
      { type: 'jitsi', name: 'Standup', url: 'https://meet.example.org/standup' })
    await putWidget(fixture.base, alice.token, roomId, 'board',
      { type: 'net.nordeck.whiteboard', name: 'Board', url: 'https://board.example.org/x' })
    const widgets: WidgetInfo[] = await page.evaluate(({ id, roomId }) =>
      window.matrixTest.engine.listRoomWidgets(id, roomId), { id: a, roomId })
    expect(widgets.map(widget => `${widget.id}:${widget.kind}`).sort()).toEqual(['board:unknown', 'standup:jitsi'])
    expect(widgets.find(widget => widget.id === 'standup')).toMatchObject({ name: 'Standup', sender: alice.userId })
    const outcome: { refusal: string; src: string } = await page.evaluate(async ({ id, roomId, widgets }) => {
      const frame = document.createElement('iframe')
      try {
        await window.matrixTest.engine.startWidget(id, roomId, widgets.find(widget => widget.id === 'board')!, frame, () => {})
        return { refusal: 'started', src: frame.src }
      } catch (error) { return { refusal: error instanceof Error ? error.message : String(error), src: frame.src } }
    }, { id: a, roomId, widgets })
    expect(outcome.refusal).toMatch(/does not support/)
    // The refused widget never touches the network: no frame source is set.
    expect(outcome.src).toBe('')
  } finally {
    await context.close()
  }
})
