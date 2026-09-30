import { test, expect } from '@playwright/test'

// Slash commands (#41) through the real composer in the demo: /me sends,
// unknown commands surface an error without sending, and // escapes.
test('composer slash commands send emotes and reject unknown commands', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()

  await page.getByRole('textbox', { name: 'Message composer' }).fill('/me waves from the demo')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const emote = page.locator('article').filter({ hasText: 'waves from the demo' })
  await expect(emote).toBeVisible()
  await expect(emote.locator('.message-text.emote')).toBeVisible()

  await page.getByRole('textbox', { name: 'Message composer' }).fill('/dance wildly')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByText('Unknown command /dance', { exact: false })).toBeVisible()
  await expect(page.locator('article').filter({ hasText: 'dance wildly' })).toHaveCount(0)

  await page.getByRole('textbox', { name: 'Message composer' }).fill('//me stays literal')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.locator('article').filter({ hasText: '/me stays literal' })).toBeVisible()
  expect(errors).toEqual([])
})
