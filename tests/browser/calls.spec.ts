import { test, expect } from '@playwright/test'

// Calls (#25) and call re-skin (#46) UI validation and demo paths: the demo
// opens the Fern call lobby but joining needs a real account. The lobby keeps
// the Element Call iframe guard rails; leaving or declining never starts the
// widget bridge. Live compatibility gating lives in
// tests/integration/calls.spec.ts; widget origin and service-URL guards in
// tests/calls.test.ts; lobby/joining/error/ended chrome in
// tests/callview.test.ts.
test('demo opens the call lobby and joining asks for a connected account', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Start room call' }).click()
  const dialog = page.getByRole('dialog', { name: 'Room call' })
  await expect(dialog.getByText('Call with General')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Join call' })).toBeVisible()
  const frame = dialog.locator('iframe[title="Element Call"]')
  await expect(frame).toHaveCount(1)
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups')
  await dialog.getByRole('button', { name: 'Join call' }).click()
  await expect(page.getByText('Connect your Matrix account to start a call').first()).toBeVisible()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('iframe[title="Element Call"]')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('demo can decline the call lobby without starting anything', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Start room call' }).click()
  const dialog = page.getByRole('dialog', { name: 'Room call' })
  await expect(dialog.getByText('Call with General')).toBeVisible()
  await dialog.getByRole('button', { name: 'Not now' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('iframe[title="Element Call"]')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('demo can leave the call lobby from the header without starting anything', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Start room call' }).click()
  const dialog = page.getByRole('dialog', { name: 'Room call' })
  await expect(dialog.getByText('Call with General')).toBeVisible()
  await dialog.getByRole('button', { name: 'Leave call' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('iframe[title="Element Call"]')).toHaveCount(0)
  expect(errors).toEqual([])
})
