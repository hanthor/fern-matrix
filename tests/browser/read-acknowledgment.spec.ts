import { expect, test, type Page } from '@playwright/test'
async function prepare(page: Page, options: { hiddenPhone?: boolean; filter?: boolean; count?: number } = {}) {
  await page.goto('/')
  await page.bringToFront()
  await page.evaluate(async options => {
    // @ts-expect-error Browser imports are resolved by the Vite development server.
    const store = await import('/src/store.ts')
    const { state, engine, selectRoom } = store
    const accountId = state.activeAccountId
    const room = state.rooms.find((item: { accountId: string; name: string }) => item.accountId === accountId && item.name === 'General')
    state.accounts.find((item: { id: string }) => item.id === accountId).connection = 'online'
    room.unread = 10; room.mentions = 2
    const messages = Array.from({ length: options.count ?? 1 }, (_, index) => ({
      id: '$visible-' + index, sender: '@test:x', name: 'Test', body: 'Visible test message ' + index,
      timestamp: index + 1, own: false, kind: 'text', reactions: [],
    }))
    const receipts: string[] = []
    let wholeRoomReads = 0
    engine.watchRoom = async (_account: string, _room: string, update: (messages: unknown[]) => void) => { update(messages); return () => {} }
    engine.markRead = async () => { ++wholeRoomReads }
    engine.markEventRead = async (_account: string, _room: string, eventId: string) => { receipts.push(eventId); return true }
    engine.members = async () => []
    engine.ignoredUsers = async () => []
    engine.pollModPower = async () => false
    const selected = selectRoom(room)
    if (options.hiddenPhone) state.mobileRoom = false
    if (options.filter) state.messageQuery = 'deliberately-no-match'
    await selected
    Object.assign(window, { receiptEvidence: () => ({ receipts, wholeRoomReads, unread: room.unread, mentions: room.mentions }) })
  }, options)
}
async function evidence(page: Page) {
  return page.evaluate(() => (window as unknown as { receiptEvidence(): { receipts: string[]; wholeRoomReads: number; unread: number; mentions: number } }).receiptEvidence())
}
async function frames(page: Page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))) }

test('hidden phone selection waits for the displayed latest event', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await prepare(page, { hiddenPhone: true })
  await frames(page)
  expect((await evidence(page)).receipts).toEqual([])
  await page.locator('.room-item').filter({ has: page.locator('strong', { hasText: /^General$/ }) }).click()
  await expect.poll(async () => (await evidence(page)).receipts).toEqual(['$visible-0'])
  expect(await evidence(page)).toMatchObject({ wholeRoomReads: 0, unread: 10, mentions: 2 })
})

test('desktop acknowledges its visible room even with the phone-pane flag false', async ({ page }) => {
  await prepare(page, { hiddenPhone: true })
  await expect.poll(async () => (await evidence(page)).receipts).toEqual(['$visible-0'])
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await frames(page)
  expect((await evidence(page)).receipts).toEqual(['$visible-0'])
})

test('filtered or scrolled history cannot acknowledge an unseen latest event', async ({ page }) => {
  await prepare(page, { filter: true, count: 80 })
  await frames(page)
  expect((await evidence(page)).receipts).toEqual([])
  await page.evaluate(async () => {
    // @ts-expect-error Browser imports are resolved by the Vite development server.
    const { state } = await import('/src/store.ts')
    state.messageQuery = ''
    // Let Vue's already-queued render flush, before the next animation frame.
    await Promise.resolve(); await Promise.resolve()
    const timeline = document.querySelector('.timeline')!
    timeline.scrollTop = 0
    timeline.dispatchEvent(new Event('scroll'))
  })
  await frames(page)
  expect((await evidence(page)).receipts).toEqual([])
  await page.locator('.timeline').evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')) })
  await expect.poll(async () => (await evidence(page)).receipts).toEqual(['$visible-79'])
  expect((await evidence(page)).wholeRoomReads).toBe(0)
})

test('a visible but unfocused/background document does not acknowledge', async ({ page }) => {
  await page.addInitScript(() => {
    let visible = false, focused = false
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible ? 'visible' : 'hidden' })
    document.hasFocus = () => focused
    Object.assign(window, { setReceiptForeground: (nextVisible: boolean, nextFocused: boolean) => {
      visible = nextVisible; focused = nextFocused
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event(nextFocused ? 'focus' : 'blur'))
    } })
  })
  await prepare(page)
  await frames(page)
  expect((await evidence(page)).receipts).toEqual([])
  await page.evaluate(() => (window as unknown as { setReceiptForeground(v: boolean, f: boolean): void }).setReceiptForeground(true, false))
  await frames(page)
  expect((await evidence(page)).receipts).toEqual([])
  await page.evaluate(() => (window as unknown as { setReceiptForeground(v: boolean, f: boolean): void }).setReceiptForeground(true, true))
  await expect.poll(async () => (await evidence(page)).receipts).toEqual(['$visible-0'])
})

test('historical focused context waits until the live latest event is displayed', async ({ page }) => {
  await prepare(page, { filter: true })
  await page.evaluate(async () => {
    // @ts-expect-error Browser imports are resolved by the Vite development server.
    const { state, focused } = await import('/src/store.ts')
    focused.value = { accountId: state.activeAccountId, roomId: state.activeRoomId, eventId: '$historical', messages: [
      { id: '$historical', sender: '@test:x', name: 'Test', body: 'Historical context', timestamp: 0, own: false, kind: 'text', reactions: [] },
    ] }
    state.messageQuery = ''
  })
  await expect(page.getByText('Viewing message context')).toBeVisible()
  await frames(page)
  expect((await evidence(page)).receipts).toEqual([])
  await page.getByRole('button', { name: 'Back to live', exact: true }).click()
  await expect.poll(async () => (await evidence(page)).receipts).toEqual(['$visible-0'])
})

test('Forward overlay blocks receipts for the live row behind it', async ({ page }) => {
  await prepare(page, { filter: true })
  await page.evaluate(async () => {
    // @ts-expect-error Vite source import for the SDK-boundary fixture.
    const { state, beginForward } = await import('/src/store.ts')
    const key = state.activeAccountId + '/' + state.activeRoomId
    beginForward(state.messages[key][0])
    state.messageQuery = ''
    state.messages[key].push({ ...state.messages[key][0], id: '$behind-forward', body: 'Behind Forward' })
  })
  await expect(page.getByRole('dialog', { name: 'Forward message', exact: true })).toBeVisible()
  await frames(page)
  expect((await evidence(page)).receipts).toEqual([])
  await page.evaluate(async () => {
    // @ts-expect-error Vite source import for the SDK-boundary fixture.
    const { cancelForward } = await import('/src/store.ts')
    cancelForward()
  })
  await expect.poll(async () => (await evidence(page)).receipts).toEqual(['$behind-forward'])
})

test('session-exit overlay blocks receipts even after the settings modal is cleared', async ({ page }) => {
  await prepare(page, { filter: true })
  await page.evaluate(async () => {
    // @ts-expect-error Vite source import for the SDK-boundary fixture.
    const { engine } = await import('/src/store.ts')
    engine.sessionExitStatus = async () => ({ recovery: 'Unknown', backupExists: 'unknown', lastDevice: 'unknown' })
  })
  await page.getByRole('button', { name: 'Open settings', exact: true }).click()
  await page.getByRole('button', { name: 'Accounts', exact: true }).click()
  await page.getByRole('button', { name: 'Sign out of current account', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Sign out of this session?', exact: true })
  await expect(dialog).toBeVisible()
  await page.evaluate(async () => {
    // @ts-expect-error Vite source import for the SDK-boundary fixture.
    const { state } = await import('/src/store.ts')
    state.messageQuery = ''
    const key = state.activeAccountId + '/' + state.activeRoomId
    state.messages[key].push({ ...state.messages[key][0], id: '$behind-exit', body: 'Behind Exit' })
  })
  await frames(page)
  expect((await evidence(page)).receipts).toEqual([])
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await evidence(page)).receipts).toEqual(['$behind-exit'])
})

test('confirmed targets update while the trailing local echo ID stays unchanged', async ({ page }) => {
  await prepare(page, { filter: true })
  await page.evaluate(async () => {
    // @ts-expect-error Vite source import for the SDK-boundary fixture.
    const { state } = await import('/src/store.ts')
    const key = state.activeAccountId + '/' + state.activeRoomId
    state.messages[key].push({ ...state.messages[key][0], id: 'unchanged-local', status: 'sending', body: 'Local echo' })
    state.messageQuery = ''
  })
  await expect.poll(async () => (await evidence(page)).receipts).toEqual(['$visible-0'])
  await page.evaluate(async () => {
    // @ts-expect-error Vite source import for the SDK-boundary fixture.
    const { state } = await import('/src/store.ts')
    const key = state.activeAccountId + '/' + state.activeRoomId
    state.messages[key].splice(-1, 0, { ...state.messages[key][0], id: '$incoming-before-local', body: 'Incoming confirmed' })
  })
  await expect.poll(async () => (await evidence(page)).receipts).toEqual(['$visible-0', '$incoming-before-local'])
  await page.evaluate(async () => {
    // @ts-expect-error Vite source import for the SDK-boundary fixture.
    const { state } = await import('/src/store.ts')
    const key = state.activeAccountId + '/' + state.activeRoomId
    state.messages[key].splice(-1, 0, { ...state.messages[key][0], id: '$confirmation-status', status: 'sending', body: 'Waiting for confirmation' })
  })
  await frames(page)
  expect((await evidence(page)).receipts).toEqual(['$visible-0', '$incoming-before-local'])
  await page.evaluate(async () => {
    // @ts-expect-error Vite source import for the SDK-boundary fixture.
    const { state } = await import('/src/store.ts')
    const key = state.activeAccountId + '/' + state.activeRoomId
    state.messages[key].find((item: { id: string }) => item.id === '$confirmation-status').status = undefined
  })
  await expect.poll(async () => (await evidence(page)).receipts).toEqual(['$visible-0', '$incoming-before-local', '$confirmation-status'])
})
