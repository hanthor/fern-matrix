import { test, expect } from '@playwright/test'

async function forwardFromGeneral(page: import('@playwright/test').Page, body: string) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'Message composer' }).fill(body)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const target = page.locator('article').filter({ hasText: body }).last()
  await target.hover()
  await target.getByRole('button', { name: 'Message actions' }).click()
  await page.getByRole('menuitem', { name: 'Forward' }).click()
  return page.getByRole('dialog', { name: 'Forward message' })
}

test('forward dialog sends into the chosen room', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const dialog = await forwardFromGeneral(page, 'Forwardable demo text')
  await expect(dialog.getByText(/in General \(Alex Morgan\)/)).toBeVisible()
  // Design is preselected (first room of the source account); forward as-is.
  await expect(dialog.getByRole('combobox', { name: 'Forward to' })).toContainText('Alex Morgan · Design')
  await dialog.getByRole('button', { name: 'Forward', exact: true }).click()
  await page.locator('.room-item', { has: page.locator('strong', { hasText: /^Design$/ }) }).click()
  await expect(page.getByRole('heading', { name: 'Design', exact: true })).toBeVisible()
  await expect(page.locator('article').filter({ hasText: 'Forwardable demo text' })).toHaveCount(1)
  expect(errors).toEqual([])
})
test('cancelled forward sends nothing', async ({ page }) => {
  const dialog = await forwardFromGeneral(page, 'Never forwarded text')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Forward message' })).toHaveCount(0)
  await page.locator('.room-item', { has: page.locator('strong', { hasText: /^Design$/ }) }).click()
  await expect(page.locator('article').filter({ hasText: 'Never forwarded text' })).toHaveCount(0)
})
test('cross-account forward warns before sending', async ({ page }) => {
  const dialog = await forwardFromGeneral(page, 'Cross-account demo text')
  await dialog.locator('[data-slot="trigger"]').click()
  await page.getByRole('option', { name: 'Alex · Work · Team lounge' }).click()
  await expect(dialog.getByText('will be able to read it')).toBeVisible()
  await dialog.getByRole('button', { name: 'Forward', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Forward message' })).toHaveCount(0)
})
test('share falls back to a copied link', async ({ context, page }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  const target = page.locator('article').filter({ hasText: 'A quieter kind of workspace' }).first()
  await target.hover()
  await target.getByRole('button', { name: 'Message actions' }).click()
  await page.getByRole('menuitem', { name: 'Share' }).click()
  const clipped = await page.evaluate(() => navigator.clipboard.readText())
  expect(clipped).toContain('matrix.to')
  await expect(page.getByText('Message link copied').first()).toBeVisible()
})
