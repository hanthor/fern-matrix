import { expect, test } from '@playwright/test'

test('a delayed search room selection cannot focus after newer room navigation', async ({ page }) => {
  await page.goto('/')
  await page.locator('.room-item').filter({ has: page.locator('strong', { hasText: /^Design$/ }) }).click()
  await page.evaluate(async () => {
    // @ts-expect-error Browser imports are resolved by the Vite development server.
    const { state, engine } = await import('/src/store.ts')
    const accountId = state.activeAccountId
    const general = state.rooms.find((item: { accountId: string; name: string }) => item.accountId === accountId && item.name === 'General')
    state.messages[accountId + '/' + general.id] = [{
      id: '$navigation-test', sender: '@test:example.org', name: 'Test', body: 'Navigationneedle',
      timestamp: 1, own: false, kind: 'text', reactions: [],
    }]
    state.accounts.find((item: { id: string }) => item.id === accountId).connection = 'online'
    let resolve!: (stop: () => void) => void
    const pending = new Promise<() => void>(done => { resolve = done })
    let focusCalls = 0
    engine.watchRoom = async (_account: string, roomId: string) => roomId === general.id ? pending : () => {}
    engine.markRead = async () => {}
    engine.members = async () => []
    engine.ignoredUsers = async () => []
    engine.pollModPower = async () => false
    engine.focusEvent = async () => { ++focusCalls; return () => {} }
    Object.assign(window, {
      finishNavigationWatch: () => resolve(() => {}),
      navigationFocusCalls: () => focusCalls,
    })
  })
  await page.getByRole('button', { name: 'Search messages', exact: true }).click()
  await page.getByRole('button', { name: 'All rooms', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search messages' }).fill('Navigationneedle')
  await page.getByRole('option', { name: 'Jump to message in General' }).click()
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await page.locator('.room-item').filter({ has: page.locator('strong', { hasText: /^Design$/ }) }).click()
  await expect(page.getByRole('heading', { name: 'Design', exact: true })).toBeVisible()
  await page.evaluate(() => (window as unknown as { finishNavigationWatch(): void }).finishNavigationWatch())
  // Flush both the delayed store selection and its component continuation.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect(await page.evaluate(() => (window as unknown as { navigationFocusCalls(): number }).navigationFocusCalls())).toBe(0)
  await expect(page.getByText('Viewing message context')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Design', exact: true })).toBeVisible()
})

test('a newer search jump wins while an earlier selection of the same room waits', async ({ page }) => {
  await page.goto('/')
  await page.locator('.room-item').filter({ has: page.locator('strong', { hasText: /^Design$/ }) }).click()
  await page.evaluate(async () => {
    // @ts-expect-error Browser imports are resolved by the Vite development server.
    const { state, engine } = await import('/src/store.ts')
    const accountId = state.activeAccountId
    const general = state.rooms.find((item: { accountId: string; name: string }) => item.accountId === accountId && item.name === 'General')
    const messages = [
      { id: '$older-jump', sender: '@test:example.org', name: 'Test', body: 'Olderneedle', timestamp: 1, own: false, kind: 'text', reactions: [] },
      { id: '$newer-jump', sender: '@test:example.org', name: 'Test', body: 'Newerneedle', timestamp: 2, own: false, kind: 'text', reactions: [] },
    ]
    state.messages[accountId + '/' + general.id] = messages
    state.accounts.find((item: { id: string }) => item.id === accountId).connection = 'online'
    let resolve!: (stop: () => void) => void
    const pending = new Promise<() => void>(done => { resolve = done })
    const focuses: string[] = [], scrolls: Array<string | null> = []
    engine.watchRoom = async () => pending
    engine.markRead = async () => {}
    engine.members = async () => []
    engine.ignoredUsers = async () => []
    engine.pollModPower = async () => false
    engine.focusEvent = async (_account: string, _room: string, event: string, update: (items: unknown[]) => void) => {
      focuses.push(event)
      update(messages.filter(item => item.id === event))
      return () => {}
    }
    Element.prototype.scrollIntoView = function () { scrolls.push(this.getAttribute('data-message-id')) }
    Object.assign(window, {
      finishNavigationWatch: () => resolve(() => {}),
      navigationEvidence: () => ({ focuses, scrolls }),
    })
  })
  await page.getByRole('button', { name: 'Search messages', exact: true }).click()
  await page.getByRole('button', { name: 'All rooms', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search messages' }).fill('Olderneedle')
  await page.getByRole('option', { name: 'Jump to message in General' }).click()
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  // Selection cleared the query, but the first jump is still awaiting its watch.
  await page.getByRole('searchbox', { name: 'Search messages' }).fill('Newerneedle')
  await page.getByRole('option', { name: 'Jump to message in General' }).click()
  await expect(page.getByText('Viewing message context')).toBeVisible()
  await page.evaluate(() => (window as unknown as { finishNavigationWatch(): void }).finishNavigationWatch())
  await expect(page.locator('article[data-message-id="$newer-jump"]')).toBeVisible()
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const evidence = await page.evaluate(() => (window as unknown as { navigationEvidence(): { focuses: string[]; scrolls: Array<string | null> } }).navigationEvidence())
  expect(evidence.focuses).toEqual(['$newer-jump'])
  expect(evidence.scrolls).toContain('$newer-jump')
  expect(evidence.scrolls).not.toContain('$older-jump')
  await expect(page.getByText('Viewing message context')).toBeVisible()
})
