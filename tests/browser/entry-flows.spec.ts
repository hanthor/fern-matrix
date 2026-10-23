import { test, expect } from '@playwright/test'

test('Register opens registration, and returning to inline sign-in resets it deliberately', async ({ page }) => {
  await page.goto('/?demo=0')
  await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only source import.
    const { engine } = await import('/src/store.ts')
    engine.loginMethods = async () => ({ password: true, sso: false, oidc: false })
  })
  await page.getByRole('button', { name: 'Register', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add a Matrix account' })
  await expect(dialog.getByRole('button', { name: 'Create account', exact: true })).toBeVisible()
  await expect(dialog.getByText('Fern checks availability first', { exact: false })).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page.locator('.gate-login').getByRole('button', { name: 'Connect account', exact: true })).toBeVisible()
})

test('explicit tour permits SSO discovery without an existing real account', async ({ page }) => {
  await page.goto('/?demo=1')
  await page.evaluate(async () => {
    // Mock only the capability boundary: no provider login or real account.
    // @ts-expect-error Vite resolves this browser-only source import.
    const { engine } = await import('/src/store.ts')
    engine.loginMethods = async () => ({ password: true, sso: false, oidc: false })
  })
  await page.locator('.demo-card').getByRole('button', { name: 'Connect your account', exact: true }).click()
  await page.getByRole('button', { name: 'Continue with SSO', exact: true }).click()
  await expect(page.getByText('This homeserver does not advertise SSO or modern login.', { exact: true })).toBeVisible()
  await expect(page.getByText('Connect an account to use SSO', { exact: true })).toHaveCount(0)
})

for (const action of ['signOut', 'remove', 'deactivate'] as const) {
  for (const text of ['', 'A private unfinished message']) {
    test(action + ' does not recreate an erased ' + (text ? 'nonempty' : 'empty') + ' draft', async ({ page }) => {
      await page.goto('/?demo=1')
      await page.evaluate(async () => {
        // Exercise the mounted App watcher without contacting a homeserver.
        // @ts-expect-error Vite resolves this browser-only source import.
        const { state, engine } = await import('/src/store.ts')
        const room = state.rooms.find((item: { id: string }) => item.id === 'general')!
        state.accounts = [{ id: 'real-exit', name: 'Test user', userId: '@test:example.org', color: '#477962', connection: 'online' }]
        state.rooms = [{ ...room, accountId: 'real-exit' }]
        state.activeAccountId = 'real-exit'
        state.activeRoomId = 'general'
        engine.typing = async () => {}
        // Use the actual shared tombstone/lock boundary so a late composer
        // write is rejected just as it is during real session cleanup.
        // @ts-expect-error Vite resolves this browser-only source import.
        const { markSessionRemoving, deleteSessionDrafts } = await import('/src/session-storage.ts')
        const eraseDrafts = async (id: string) => {
          markSessionRemoving(id)
          await deleteSessionDrafts(id)
          return { status: 'complete' as const }
        }
        engine.logout = async (id: string) => ({ ...await eraseDrafts(id), serverRevoked: true })
        engine.removeAccount = eraseDrafts
        engine.deactivate = async (id: string) => eraseDrafts(id)
      })
      const composer = page.getByRole('textbox', { name: 'Message composer' })
      await expect(composer).toBeVisible()
      await composer.fill('Temporary text')
      await composer.fill(text)
      await expect.poll(() => page.evaluate(() => localStorage.getItem('fern.draft.real-exit/general'))).toBe(text || null)
      await page.evaluate(async action => {
        // @ts-expect-error Vite resolves this browser-only source import.
        const store = await import('/src/store.ts')
        if (action === 'signOut') await store.signOut()
        else if (action === 'remove') await store.removeAccount('real-exit')
        else await store.deactivateAccount('test-only-password', false)
      }, action)
      await expect(page.getByRole('heading', { name: 'Good conversations start here' })).toBeVisible()
      expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('fern.draft.real-exit/')))).toEqual([])
    })
  }
}
