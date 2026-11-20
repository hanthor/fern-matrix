import { test, expect, type Page } from '@playwright/test'

async function fillLogin(page: Page) {
  const form = page.locator('.gate-login')
  await form.getByLabel(/^Homeserver\s*\*?\s*\(required\)$/).fill('example.org')
  await form.getByLabel(/^Username\s*\*?\s*\(required\)$/).fill('synthetic-user')
  await form.getByLabel(/^Password\s*\*?\s*\(required\)$/).fill('synthetic-password')
  return form
}

test('inline login uses native required validation without contacting the SDK', async ({ page }) => {
  await page.goto('/?demo=0')
  await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only source import.
    const { engine } = await import('/src/store.ts')
    engine.loginMethods = async () => ({ password: true, sso: false, oidc: false })
    const probe = window as unknown as { loginCalls: number }
    probe.loginCalls = 0
    engine.login = async () => { probe.loginCalls++; throw new Error('Unexpected SDK login') }
  })
  const form = page.locator('.gate-login')
  await form.getByRole('button', { name: 'Connect account', exact: true }).click()
  expect(await form.evaluate(el => (el as HTMLFormElement).checkValidity())).toBe(false)
  await expect(form.getByLabel(/^Username\s*\*?\s*\(required\)$/)).toBeFocused()
  expect(await page.evaluate(() => (window as unknown as { loginCalls: number }).loginCalls)).toBe(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

for (const rejected of [true, false]) {
  test(`inline ${rejected ? 'credential rejection offers a neutral registration hint' : 'network failure does not imply registration is needed'}`, async ({ page }) => {
    await page.goto('/?demo=0')
    await page.evaluate(async rejected => {
      // @ts-expect-error Vite resolves this browser-only source import.
      const { engine } = await import('/src/store.ts')
      engine.loginMethods = async () => ({ password: true, sso: false, oidc: false })
      engine.login = async () => {
        if (rejected) throw { tag: 'MatrixApi', inner: { kind: { tag: 'Forbidden' } } }
        throw new Error('Synthetic network unavailable')
      }
      // A hint must never check whether a username exists.
      engine.registerAvailable = async () => { throw new Error('Unexpected account enumeration') }
    }, rejected)
    const form = await fillLogin(page)
    await form.getByRole('button', { name: 'Connect account', exact: true }).click()
    if (rejected) {
      await expect(page.getByText('New to Matrix?', { exact: false })).toBeVisible()
      await form.getByLabel(/^Username\s*\*?\s*\(required\)$/).fill('another-synthetic-user')
      await expect(page.getByText('New to Matrix?', { exact: false })).toHaveCount(0)
    } else {
      await expect(page.getByText('Sign-in could not finish. Check your connection and homeserver, then try again.')).toBeVisible()
      await expect(page.getByText('Synthetic network unavailable')).toHaveCount(0)
      await expect(page.getByText('New to Matrix?', { exact: false })).toHaveCount(0)
    }
    await expect(page.getByText('Unexpected account enumeration')).toHaveCount(0)
    expect(new URL(page.url()).searchParams.toString()).toBe('demo=0')
  })
}

test('repeated submit events share one pending inline sign-in', async ({ page }) => {
  await page.goto('/?demo=0')
  await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only source import.
    const { engine } = await import('/src/store.ts')
    engine.loginMethods = async () => ({ password: true, sso: false, oidc: false })
    const probe = window as unknown as { loginCalls: number; finishLogin: () => void }
    probe.loginCalls = 0
    engine.login = async () => {
      probe.loginCalls++
      await new Promise<void>(resolve => { probe.finishLogin = resolve })
      throw new Error('Synthetic login finished')
    }
  })
  const form = await fillLogin(page)
  await form.evaluate(el => {
    el.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    el.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await expect.poll(() => page.evaluate(() => (window as unknown as { loginCalls: number }).loginCalls)).toBe(1)
  await page.evaluate(() => (window as unknown as { finishLogin: () => void }).finishLogin())
  await expect(page.getByText('Sign-in could not finish. Check your connection and homeserver, then try again.')).toBeVisible()
})

test('Register routes an SSO-only server through the existing provider flow', async ({ page }) => {
  await page.goto('/?demo=0')
  await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only source import.
    const { engine } = await import('/src/store.ts')
    engine.loginMethods = async () => ({ password: false, sso: true, oidc: false })
    engine.startSsoLogin = async () => { throw new Error('Synthetic SSO started') }
    engine.registerAvailable = async () => { throw new Error('Unexpected password registration') }
  })
  await page.getByRole('button', { name: 'Register', exact: true }).click()
  await expect(page.getByText('Synthetic SSO started')).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText('Unexpected password registration')).toHaveCount(0)
})

test('front-page QR dismissal clears flow and can reopen without starting the camera', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: () => { throw new Error('Camera must be explicitly requested') },
    } })
  })
  await page.goto('/?demo=0')
  const button = page.getByRole('button', { name: 'Scan QR code to sign in', exact: true })
  await button.click()
  await expect(page.getByRole('region', { name: 'Sign in with QR code' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only source import.
    return (await import('/src/store.ts')).qrFlow.value
  })).toBeUndefined()
  await expect(button).toBeFocused()
  await button.click()
  await expect(page.getByRole('button', { name: 'Use camera', exact: true })).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByText('Camera must be explicitly requested')).toHaveCount(0)
})

test('closing QR while camera permission is pending stops a late stream', async ({ page }) => {
  await page.addInitScript(() => {
    const probe = window as unknown as { releaseCamera: () => void; stoppedTracks: number }
    probe.stoppedTracks = 0
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: () => new Promise(resolve => {
        probe.releaseCamera = () => resolve({ getTracks: () => [{ stop: () => { probe.stoppedTracks++ } }] })
      }),
    } })
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { configurable: true, set() {}, get() { return null } })
    HTMLMediaElement.prototype.play = async () => {}
  })
  await page.goto('/?demo=0')
  await page.getByRole('button', { name: 'Scan QR code to sign in', exact: true }).click()
  await page.getByRole('button', { name: 'Use camera', exact: true }).click()
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseCamera?: () => void }).releaseCamera)).toBe('function')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.evaluate(() => (window as unknown as { releaseCamera: () => void }).releaseCamera())
  await expect.poll(() => page.evaluate(() => (window as unknown as { stoppedTracks: number }).stoppedTracks)).toBeGreaterThanOrEqual(1)
  await expect(page.locator('.gate-login')).toBeVisible()
})

for (const action of ['register', 'sso'] as const) {
  test(`dismissed ${action} discovery cannot reopen auth or start a provider`, async ({ page }) => {
    await page.goto('/?demo=1')
    await page.locator('.demo-card').getByRole('button', { name: 'Connect your account', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Add a Matrix account' })
    await expect(dialog).toBeVisible()
    await page.evaluate(async () => {
      // @ts-expect-error Vite resolves this browser-only source import.
      const { engine } = await import('/src/store.ts')
      const probe = window as unknown as { finishDiscovery: () => void; providerCalls: number }
      probe.providerCalls = 0
      engine.loginMethods = async () => {
        await new Promise<void>(resolve => { probe.finishDiscovery = resolve })
        return { password: false, sso: true, oidc: false }
      }
      engine.startSsoLogin = async () => { probe.providerCalls++; throw new Error('Unexpected stale provider') }
    })
    await dialog.getByRole('button', { name: action === 'register' ? 'Create an account' : 'Continue with SSO', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await page.evaluate(async () => {
      (window as unknown as { finishDiscovery: () => void }).finishDiscovery()
      // Flush the promise chain and Vue updates, without a timed race.
      for (let i = 0; i < 8; i++) await Promise.resolve()
    })
    expect(await page.evaluate(() => (window as unknown as { providerCalls: number }).providerCalls)).toBe(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByText('Unexpected stale provider')).toHaveCount(0)
  })
}

test('dismissed SSO startup cancels the late flow without opening a popup', async ({ page }) => {
  await page.goto('/?demo=1')
  await page.locator('.demo-card').getByRole('button', { name: 'Connect your account', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add a Matrix account' })
  await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only source import.
    const { engine } = await import('/src/store.ts')
    const probe = window as unknown as { finishProvider: () => void; popupCalls: number; cancelledFlows: string[] }
    probe.popupCalls = 0; probe.cancelledFlows = []
    engine.loginMethods = async () => ({ password: false, sso: true, oidc: false })
    engine.startSsoLogin = async () => {
      await new Promise<void>(resolve => { probe.finishProvider = resolve })
      return { flowId: 'synthetic-stale-flow', url: 'https://example.org/synthetic-provider' }
    }
    engine.cancelSsoLogin = async (id: string) => { probe.cancelledFlows.push(id) }
    window.open = () => { probe.popupCalls++; return null }
  })
  await dialog.getByRole('button', { name: 'Continue with SSO', exact: true }).click()
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { finishProvider?: () => void }).finishProvider)).toBe('function')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await page.evaluate(() => (window as unknown as { finishProvider: () => void }).finishProvider())
  await expect.poll(() => page.evaluate(() => (window as unknown as { cancelledFlows: string[] }).cancelledFlows)).toEqual(['synthetic-stale-flow'])
  expect(await page.evaluate(() => (window as unknown as { popupCalls: number }).popupCalls)).toBe(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
