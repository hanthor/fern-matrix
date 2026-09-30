import { test, expect } from '@playwright/test'

// Unified inbox: the demo ships two accounts, so the scope toggle is visible.
// Enabling it merges both accounts newest-first with per-row account labels,
// and opening a foreign-account room hops accounts.
test('unified inbox merges accounts with labels and cross-account open', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  const toggle = page.getByRole('button', { name: 'All inboxes' })
  await expect(toggle).toBeVisible()
  await expect(page.getByRole('button', { name: /Team lounge/ })).toHaveCount(0)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  const work = page.getByRole('button', { name: /Team lounge/ })
  await expect(work).toBeVisible()
  await expect(work.getByText('Alex · Work')).toBeVisible()
  await work.click()
  await expect(page.getByRole('heading', { name: 'Team lounge', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})
