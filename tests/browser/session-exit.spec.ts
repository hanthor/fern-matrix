import { test, expect, type Page } from '@playwright/test'

// UI-only sessions use explicit engine doubles; never contact a real account.
async function setup(page: Page) {
  await page.goto('/?demo=0')
  await expect(page.getByRole('heading', { name: 'Good conversations start here' })).toBeVisible()
  await page.evaluate(async () => {
    // @ts-expect-error Vite serves the source module to the browser fixture.
    const { state, engine } = await import('/src/store.ts')
    const calls: string[] = []
    ;(window as unknown as { exitCalls: string[] }).exitCalls = calls
    engine.sessionExitStatus = async () => ({ recovery: 'Unknown', backupExists: 'unknown', lastDevice: 'unknown' })
    engine.logout = async (id: string) => { calls.push('logout:' + id); return { serverRevoked: false } }
    engine.removeAccount = async (id: string) => { calls.push('remove:' + id) }
    state.accounts = [
      { id: 'exit-a', userId: '@alice:example.org', name: 'Alice', color: '#477962', connection: 'offline' },
      { id: 'exit-b', userId: '@bob:example.org', name: 'Bob', color: '#477962', connection: 'offline' },
    ]
    state.rooms = []; state.messages = {}; state.activeAccountId = 'exit-a'; state.activeRoomId = ''
  })
  await page.getByRole('button', { name: 'Open settings', exact: true }).click()
  await page.getByRole('button', { name: 'Accounts', exact: true }).click()
}
async function calls(page: Page) {
  return page.evaluate(() => (window as unknown as { exitCalls: string[] }).exitCalls)
}

test('local removal identifies the selected account and cancellation erases nothing', async ({ page }) => {
  await setup(page)
  await page.locator('.settings-account').filter({ hasText: '@bob:example.org' })
    .getByRole('button', { name: 'Remove', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Remove this session from this device?' })
  await expect(dialog.getByText('@bob:example.org', { exact: false })).toBeVisible()
  await expect(dialog.getByText('This erases local credentials', { exact: false })).toBeVisible()
  await expect(dialog.getByText('Recovery status could not be confirmed', { exact: false })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Erase local session data' })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.settings-account')).toHaveCount(2)
  expect(await calls(page)).toEqual([])
})

test('sign out requires acknowledgement and remains bound to its original session', async ({ page }) => {
  await setup(page)
  await page.getByRole('button', { name: 'Sign out of current account' }).click()
  const dialog = page.getByRole('dialog', { name: 'Sign out of this session?' })
  await expect(dialog.getByText('@alice:example.org', { exact: false })).toBeVisible()
  await expect(dialog.getByText('The server backup could not be checked.')).toBeVisible()
  await page.evaluate(async () => {
    // @ts-expect-error Vite browser fixture.
    const { switchAccount } = await import('/src/store.ts')
    switchAccount('exit-b')
  })
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: 'Sign out and erase local data' }).click()
  await expect(dialog).toHaveCount(0)
  expect(await calls(page)).toEqual(['logout:exit-a'])
  await expect(page.getByText('The server session may still be active.', { exact: false })).toBeVisible()
  expect(await page.evaluate(async () => {
    // @ts-expect-error Vite browser fixture.
    const { state } = await import('/src/store.ts')
    return state.activeAccountId
  })).toBe('exit-b')
})

test('Escape cancels without deleting either local session', async ({ page }) => {
  await setup(page)
  await page.getByRole('button', { name: 'Sign out of current account' }).click()
  const dialog = page.getByRole('dialog', { name: 'Sign out of this session?' })
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(await calls(page)).toEqual([])
  expect(await page.evaluate(async () => {
    // @ts-expect-error Vite browser fixture.
    const { state } = await import('/src/store.ts')
    return state.accounts.length
  })).toBe(2)
})

test('mounted security controls react to Enabled, Unknown, and account switches', async ({ page }) => {
  await setup(page)
  await page.evaluate(async () => {
    // @ts-expect-error Vite browser fixture.
    const { engine } = await import('/src/store.ts')
    engine.security = async () => ({ deviceId: 'A', fingerprint: '', recovery: 'Enabled', verified: 'Verified' })
    engine.listenForVerificationRequests = async () => {}
  })
  await page.getByRole('button', { name: 'Security', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Reset recovery', exact: true })).toBeVisible()
  await page.evaluate(async () => {
    // @ts-expect-error Vite browser fixture.
    const { engine } = await import('/src/store.ts')
    engine.security = async () => ({ deviceId: 'A', fingerprint: '', recovery: 'Unknown', verified: 'Unknown' })
  })
  await page.getByRole('button', { name: 'Accounts', exact: true }).click()
  await page.getByRole('button', { name: 'Security', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Reset recovery', exact: true })).toHaveCount(0)
  await page.evaluate(async () => {
    // @ts-expect-error Vite browser fixture.
    const { engine } = await import('/src/store.ts')
    engine.security = async () => ({ deviceId: 'A', fingerprint: '', recovery: 'Enabled', verified: 'Verified' })
  })
  await page.getByRole('button', { name: 'Accounts', exact: true }).click()
  await page.getByRole('button', { name: 'Security', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Reset recovery', exact: true })).toBeVisible()
  await page.evaluate(async () => {
    // @ts-expect-error Vite browser fixture.
    const { switchAccount } = await import('/src/store.ts')
    switchAccount('exit-b')
  })
  await expect(page.getByRole('button', { name: 'Reset recovery', exact: true })).toHaveCount(0)
})

test('locking cancels an acknowledged exit and Enter cannot execute it', async ({ page }) => {
  await setup(page)
  await page.getByRole('button', { name: 'Sign out of current account' }).click()
  const dialog = page.getByRole('dialog', { name: 'Sign out of this session?' })
  await dialog.getByRole('checkbox').check()
  await page.evaluate(async () => {
    // @ts-expect-error Vite browser fixture.
    const { appLocked } = await import('/src/store.ts')
    appLocked.value = true
  })
  await expect(dialog).toHaveCount(0)
  await page.keyboard.press('Enter')
  expect(await calls(page)).toEqual([])
})
