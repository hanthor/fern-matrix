import { test, expect } from '@playwright/test'

// Mobile gestures (#44) via the shared Pointer Events path: swipe-to-reply on
// a message row and edge-swipe back to the room list on the phone layout.
// Intent thresholds live in tests/gestures.test.ts; vertical scrolling is
// never hijacked (rows declare touch-action: pan-y).
test('leftward swipe on a message starts a reply', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  const row = page.locator('.message-row', { hasText: 'Small details, big difference' }).first()
  await expect(row).toBeVisible()
  const box = (await row.boundingBox())!
  const startX = box.x + box.width - 60
  const y = box.y + box.height / 2
  await page.mouse.move(startX, y)
  await page.mouse.down()
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(startX - step * 20, y, { steps: 2 })
  }
  await page.mouse.up()
  await expect(page.getByText(/Replying to/).first()).toBeVisible()
  expect(errors).toEqual([])
})

test('vertical drag on a message starts no reply', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  const row = page.locator('.message-row', { hasText: 'Small details, big difference' }).first()
  await expect(row).toBeVisible()
  const box = (await row.boundingBox())!
  const x = box.x + box.width / 2
  await page.mouse.move(x, box.y + 20)
  await page.mouse.down()
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(x, box.y + 20 + step * 20, { steps: 2 })
  }
  await page.mouse.up()
  await expect(page.getByText(/Replying to/)).toHaveCount(0)
  const touchAction = await row.evaluate(element => getComputedStyle(element).touchAction)
  expect(touchAction).toContain('pan-y')
  expect(errors).toEqual([])
})

test('edge swipe returns to the room list on the phone layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'General' }).first().click()
  await expect(page.getByRole('button', { name: 'Back to conversations' })).toBeVisible()
  await page.mouse.move(8, 400)
  await page.mouse.down()
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(8 + step * 20, 400, { steps: 2 })
  }
  await page.mouse.up()
  await expect(page.getByRole('button', { name: 'Back to conversations' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'General' }).first()).toBeVisible()
  expect(errors).toEqual([])
})

test('right-click on a message opens the shared actions menu', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  const row = page.locator('.message-row', { hasText: 'Small details, big difference' }).first()
  await expect(row).toBeVisible()
  await row.click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Copy text' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Reply' })).toBeVisible()
  expect(errors).toEqual([])
})

test('right-click on a room peeks its details', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Development' }).first().click({ button: 'right' })
  await expect(page.getByText('Room details', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})
