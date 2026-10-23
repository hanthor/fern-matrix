import { test, expect } from '@playwright/test'

for (const viewport of [{ width: 360, height: 800 }, { width: 320, height: 568 }, { width: 800, height: 360 }]) {
  test(`entry stays centered and reachable at ${viewport.width} × ${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' })
    await page.goto('/?demo=0')
    const gate = page.locator('.welcome-gate')
    await expect(gate.getByRole('heading')).toBeVisible()
    const content = await page.locator('.gate-content').boundingBox()
    expect(content).not.toBeNull()
    expect(Math.abs(content!.x + content!.width / 2 - viewport.width / 2)).toBeLessThan(2)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width)
    const buttons = gate.getByRole('button')
    await expect(buttons).toHaveCount(3)
    for (const button of await buttons.all()) {
      await button.scrollIntoViewIfNeeded()
      const box = await button.boundingBox()
      expect(box!.height).toBeGreaterThanOrEqual(44)
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
    }
    await gate.evaluate(el => { el.scrollTop = 0 })
    // Signed-out artwork only: never collect account/session screenshots.
    await page.screenshot({ path: testInfo.outputPath('entry-dark.png') })
    await gate.getByRole('button', { name: 'Connect your account', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Add a Matrix account' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await gate.getByRole('button', { name: 'Create an account', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'Create account', exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await gate.getByRole('button', { name: 'Explore the demo', exact: true }).click()
    await expect(gate).toHaveCount(0)
    await expect(page.locator('.fern-fractal')).toHaveCount(0)
  })
}

test('fern pauses behind auth, follows motion preference and removes listeners on unmount', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/?demo=0')
  const fern = page.locator('.fern-fractal')
  await expect(fern).not.toHaveClass(/is-still/)
  await expect(fern.locator('path')).toHaveCount(24)
  const timings = await fern.locator('path').evaluateAll(paths => paths.map(path => {
    const style = getComputedStyle(path)
    return { iterations: style.animationIterationCount, end: parseFloat(style.animationDuration) + parseFloat(style.animationDelay) }
  }))
  expect(timings.every(timing => timing.iterations === '1')).toBe(true)
  expect(Math.max(...timings.map(timing => timing.end))).toBeLessThanOrEqual(3.02)
  await page.getByRole('button', { name: 'Connect your account', exact: true }).click()
  await expect(fern).toHaveClass(/is-paused/)
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(fern).not.toHaveClass(/is-paused/)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(fern).toHaveClass(/is-paused/)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(fern).not.toHaveClass(/is-paused/)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(fern).toHaveClass(/is-still/)
  expect(await fern.locator('path').first().evaluate(el => getComputedStyle(el).animationName)).toBe('none')
  await page.getByRole('button', { name: 'Explore the demo', exact: true }).click()
  await expect(fern).toHaveCount(0)
})

test('large text and a keyboard-sized viewport keep every entry action reachable', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 320 })
  await page.goto('/?demo=0')
  // Text-only enlargement, rather than scaling a screenshot of the page.
  await page.addStyleTag({ content: '.welcome-gate h1 { font-size: 58px !important; } .welcome-gate p, .welcome-gate button { font-size: 24px !important; }' })
  const gate = page.locator('.welcome-gate')
  const buttons = gate.getByRole('button')
  await expect(buttons).toHaveCount(3)
  expect(await gate.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  for (const button of await buttons.all()) {
    await button.scrollIntoViewIfNeeded()
    await expect(button).toBeInViewport()
    const box = await button.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(360)
  }
})

test('unmount releases the fern visibility and motion listeners', async ({ page }) => {
  await page.goto('/?demo=1')
  const counts = await page.evaluate(async () => {
    // Mount only the art component so unrelated app listeners cannot hide leaks.
    // @ts-expect-error Vite resolves this browser-only source import.
    const { createApp } = await import('/node_modules/.vite/deps/vue.js')
    // @ts-expect-error Vite resolves this browser-only source import.
    const { default: FernFractal } = await import('/src/components/FernFractal.vue')
    const host = document.createElement('div')
    document.body.append(host)
    const originalMatchMedia = window.matchMedia
    const originalAdd = document.addEventListener
    const originalRemove = document.removeEventListener
    const added: EventListenerOrEventListenerObject[] = []
    const removed: EventListenerOrEventListenerObject[] = []
    let motionAdded = 0, motionRemoved = 0
    const media = originalMatchMedia.call(window, '(prefers-reduced-motion: reduce)')
    window.matchMedia = () => ({
      matches: media.matches,
      addEventListener: () => { motionAdded++ },
      removeEventListener: () => { motionRemoved++ },
    } as unknown as MediaQueryList)
    document.addEventListener = function(this: Document, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
      if (type === 'visibilitychange') added.push(listener)
      originalAdd.call(this, type, listener, options)
    } as typeof document.addEventListener
    document.removeEventListener = function(this: Document, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) {
      if (type === 'visibilitychange') removed.push(listener)
      originalRemove.call(this, type, listener, options)
    } as typeof document.removeEventListener
    const app = createApp(FernFractal)
    try { app.mount(host); app.unmount() }
    finally {
      window.matchMedia = originalMatchMedia
      document.addEventListener = originalAdd
      document.removeEventListener = originalRemove
      host.remove()
    }
    return { added: added.length, released: added.every(listener => removed.includes(listener)), motionAdded, motionRemoved }
  })
  expect(counts).toEqual({ added: 1, released: true, motionAdded: 1, motionRemoved: 1 })
})
