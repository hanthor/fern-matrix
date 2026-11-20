import { expect, test, type Page } from '@playwright/test'
async function prepare(page: Page, count = 1) {
  await page.goto('/')
  await page.bringToFront()
  await page.evaluate(async count => {
    // @ts-expect-error Vite resolves browser source imports.
    const store = await import('/src/store.ts')
    const { state, engine, selectRoom, openThread } = store
    const id = state.activeAccountId
    const room = state.rooms.find((value: { accountId: string; name: string }) => value.accountId === id && value.name === 'General')
    state.accounts.find((value: { id: string }) => value.id === id).connection = 'online'
    const root = { id: '$root', sender: '@test:x', name: 'Test', body: 'Thread root', timestamp: 1, own: false, kind: 'text', reactions: [], threadReplies: count }
    const replies = Array.from({ length: count }, (_, index) => ({ ...root, id: '$reply-' + index, threadRoot: '$root', body: 'Thread reply ' + index, timestamp: index + 2 }))
    let listener: (messages: unknown[]) => void = () => {}
    const receipts: string[] = []
    let legacyReads = 0
    engine.watchRoom = async (_a: string, _r: string, update: (messages: unknown[]) => void) => { update([root]); return () => {} }
    engine.members = async () => []; engine.ignoredUsers = async () => []; engine.pollModPower = async () => false
    engine.markEventRead = async () => true
    engine.watchThread = async (_a: string, _r: string, _root: string, update: (messages: unknown[]) => void) => { listener = update; update([root, ...replies]); return () => {} }
    engine.markThreadRead = async () => { ++legacyReads }
    engine.markThreadEventRead = async (_a: string, _r: string, _root: string, event: string) => { receipts.push(event); return true }
    await selectRoom(room)
    state.details = false
    await openThread(id, room.id, '$root')
    Object.assign(window, {
      threadEvidence: () => ({ receipts, legacyReads, seen: state.threadSeen[id + '/' + room.id + '/$root'] ?? 0 }),
      updateThreadFixture: (ids: string[]) => listener([root, ...ids.map((event, index) => ({ ...root, id: event, threadRoot: '$root', body: event, timestamp: index + 2 }))]),
    })
  }, count)
}
async function evidence(page: Page) { return page.evaluate(() => (window as unknown as { threadEvidence(): { receipts: string[]; legacyReads: number; seen: number } }).threadEvidence()) }
async function frames(page: Page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))) }
async function show(page: Page, visible = true) {
  await page.evaluate(async visible => {
    // @ts-expect-error Vite source import.
    const { state } = await import('/src/store.ts')
    state.details = visible
  }, visible)
}
test('hidden thread subscription never reads incoming replies; reopening acknowledges visible target', async ({ page }) => {
  await prepare(page)
  await frames(page)
  expect(await evidence(page)).toMatchObject({ receipts: [], seen: 0, legacyReads: 0 })
  await show(page)
  await expect.poll(async () => (await evidence(page)).receipts).toEqual(['$reply-0'])
  await show(page, false)
  await page.evaluate(() => (window as unknown as { updateThreadFixture(ids: string[]): void }).updateThreadFixture(['$reply-0', '$hidden']))
  await frames(page)
  expect(await evidence(page)).toMatchObject({ receipts: ['$reply-0'], seen: 1 })
  await show(page)
  await expect.poll(async () => (await evidence(page)).receipts).toEqual(['$reply-0', '$hidden'])
  expect((await evidence(page)).seen).toBe(2)
})
test('scrolled older thread replies do not acknowledge the unseen latest reply', async ({ page }) => {
  await prepare(page, 80)
  await show(page)
  await frames(page)
  expect((await evidence(page)).receipts).toEqual([])
  await page.locator('.thread-replies').evaluate(pane => { pane.scrollTop = pane.scrollHeight; pane.dispatchEvent(new Event('scroll')) })
  await expect.poll(async () => (await evidence(page)).receipts).toEqual(['$reply-79'])
})
test('visible thread in an unfocused document waits for foreground focus', async ({ page }) => {
  await page.addInitScript(() => {
    let focused = false
    document.hasFocus = () => focused
    Object.assign(window, { focusThreadFixture: () => { focused = true; window.dispatchEvent(new Event('focus')) } })
  })
  await prepare(page)
  await show(page)
  await frames(page)
  expect((await evidence(page)).receipts).toEqual([])
  await page.evaluate(() => (window as unknown as { focusThreadFixture(): void }).focusThreadFixture())
  await expect.poll(async () => (await evidence(page)).receipts).toEqual(['$reply-0'])
})
test('Forward overlay blocks visible thread receipts', async ({ page }) => {
  await prepare(page)
  await page.evaluate(async () => {
    // @ts-expect-error Vite source import.
    const { state, beginForward } = await import('/src/store.ts')
    beginForward(state.messages[state.activeAccountId + '/' + state.activeRoomId][0])
    state.details = true
  })
  await expect(page.getByRole('dialog', { name: 'Forward message', exact: true })).toBeVisible()
  await frames(page)
  expect((await evidence(page)).receipts).toEqual([])
  await page.evaluate(async () => {
    // @ts-expect-error Vite source import.
    const { cancelForward } = await import('/src/store.ts')
    cancelForward()
  })
  await expect.poll(async () => (await evidence(page)).receipts).toEqual(['$reply-0'])
})
test('a root without confirmed replies and a trailing local echo are not read targets', async ({ page }) => {
  await prepare(page, 0)
  await show(page)
  await frames(page)
  expect((await evidence(page)).receipts).toEqual([])
  await page.evaluate(async () => {
    // @ts-expect-error Vite source import.
    const { state } = await import('/src/store.ts')
    const root = state.thread.messages[0]
    state.thread.messages.push({ ...root, id: 'txn-unchanged', threadRoot: '$root', status: 'sending' })
  })
  await frames(page)
  expect((await evidence(page)).receipts).toEqual([])
  await page.evaluate(async () => {
    // @ts-expect-error Vite source import.
    const { state } = await import('/src/store.ts')
    state.thread.messages.splice(-1, 0, { ...state.thread.messages[0], id: '$confirmed', threadRoot: '$root', body: 'Confirmed before local echo' })
  })
  await expect.poll(async () => (await evidence(page)).receipts).toEqual(['$confirmed'])
})
test('locking prevents late thread snapshots from acknowledging', async ({ page }) => {
  await prepare(page)
  await page.evaluate(async () => {
    // @ts-expect-error Vite source import.
    const { appLocked } = await import('/src/store.ts')
    appLocked.value = true
    ;(window as unknown as { updateThreadFixture(ids: string[]): void }).updateThreadFixture(['$late'])
  })
  await frames(page)
  expect((await evidence(page)).receipts).toEqual([])
})

test('phone-hidden details cannot acknowledge even when details state is true', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await prepare(page)
  await page.evaluate(async () => {
    // @ts-expect-error Vite source import.
    const { state } = await import('/src/store.ts')
    state.mobileRoom = false
  })
  await show(page)
  await expect(page.locator('.details-panel')).toBeHidden()
  await frames(page)
  expect((await evidence(page)).receipts).toEqual([])
})
test('adding older visible replies refreshes local seen count without a duplicate receipt', async ({ page }) => {
  await prepare(page)
  await show(page)
  await expect.poll(async () => (await evidence(page)).seen).toBe(1)
  await page.evaluate(() => (window as unknown as { updateThreadFixture(ids: string[]): void }).updateThreadFixture(['$older', '$reply-0']))
  await expect.poll(async () => (await evidence(page)).seen).toBe(2)
  expect((await evidence(page)).receipts).toEqual(['$reply-0'])
})
