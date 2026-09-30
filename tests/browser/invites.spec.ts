import { test, expect } from '@playwright/test'
import type { Room } from '../../src/types'

// Invitation, upgrade and discovery UX (#22): a tombstoned room shows the
// upgrade banner and continues into the replacement. Live upgrade and join
// failure coverage lives in tests/integration/invites.spec.ts.
test('upgrade banner continues into the replacement room', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await expect(page.getByText('This room was upgraded.', { exact: false })).toHaveCount(0)
  await page.evaluate(async () => {
    // @ts-expect-error This path is resolved by Vite in the browser.
    const store = await import('/src/store.ts')
    const accountId = store.state.activeAccountId
    const general = store.state.rooms.find((item: Room) => item.id === 'general' && item.accountId === accountId)
    const design = store.state.rooms.find((item: Room) => item.id === 'design' && item.accountId === accountId)
    const index = store.state.rooms.indexOf(general)
    store.state.rooms[index] = { ...general, successor: design.id }
  })
  // The demo persist watcher snapshots the mutated rooms; reloading boots
  // the app's own instance with the tombstone in place.
  await page.waitForTimeout(500)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await expect(page.getByText('This room was upgraded.')).toBeVisible()
  await page.getByRole('button', { name: 'Continue in replacement' }).click()
  await expect(page.getByRole('heading', { name: 'Design', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})
