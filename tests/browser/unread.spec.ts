import { test, expect } from '@playwright/test'

// First-unread jump (#41) in the demo: seeding two unread messages through
// the persisted demo snapshot surfaces the "N new" pill on load, and
// clicking it jumps and dismisses the pill.
test('unread pill jumps to the first unread message', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'Message composer' }).fill('seed for the unread pill')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.locator('article').filter({ hasText: 'seed for the unread pill' })).toBeVisible()

  await page.evaluate(() => {
    const seed = JSON.parse(localStorage.getItem('fern.demo.v1')!)
    const general = seed.rooms.find((room: { name: string }) => room.name === 'General')
    general.unread = 2
    localStorage.setItem('fern.demo.v1', JSON.stringify(seed))
  })
  await page.reload()
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  const pill = page.getByRole('button', { name: 'Jump to first unread message, 2 new' })
  await expect(pill).toBeVisible()
  await expect(pill).toContainText('2 new')
  await pill.click()
  await expect(pill).toHaveCount(0)
  expect(errors).toEqual([])
})
