import { test, expect, type Page } from '@playwright/test'

// Room widgets (#45) approval flows on the demo samples: nothing third-party
// loads before approval, declining closes cleanly, approving without an
// account explains, and unsupported types are refused with an actionable
// message. Engine parsing and capability scoping ride tests/widgets.test.ts;
// live widget joins gate on #25.
async function openWidgetsTab(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Room members' }).click()
  await page.getByRole('button', { name: 'Widgets', exact: true }).click()
  await expect(page.getByText('ROOM WIDGETS')).toBeVisible()
}

test('widget approval can be declined without loading anything', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await openWidgetsTab(page)
  await expect(page.getByText('Team standup (sample)')).toBeVisible()
  await page.getByRole('button', { name: 'Open Team standup (sample)' }).click()
  const dialog = page.getByRole('dialog', { name: 'Room widget' })
  await expect(dialog.getByText('Open “Team standup (sample)”?')).toBeVisible()
  await expect(dialog.getByText(/No account data/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Decline' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('iframe[title="Team standup (sample)"]')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('approving a widget without an account explains and loads nothing', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await openWidgetsTab(page)
  await page.getByRole('button', { name: 'Open Team standup (sample)' }).click()
  const dialog = page.getByRole('dialog', { name: 'Room widget' })
  await dialog.getByRole('button', { name: 'Approve and open' }).click()
  await expect(page.getByText('Connect your Matrix account to open widgets').first()).toBeVisible()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('iframe[title="Team standup (sample)"]')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('unsupported widget types are refused with an actionable message', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await openWidgetsTab(page)
  await expect(page.getByText('Sketch board (sample)')).toBeVisible()
  await page.getByRole('button', { name: 'Open Sketch board (sample)' }).click()
  const dialog = page.getByRole('dialog', { name: 'Room widget' })
  await expect(dialog.getByText(/net\.nordeck\.whiteboard/)).toBeVisible()
  await expect(dialog.getByText(/Element Call and Jitsi/)).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Approve and open' })).toHaveCount(0)
  await dialog.locator('.dialog-actions > button', { hasText: 'Close' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('iframe[title="Sketch board (sample)"]')).toHaveCount(0)
  expect(errors).toEqual([])
})
