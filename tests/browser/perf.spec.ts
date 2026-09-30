import { test, expect } from '@playwright/test'

// Startup, memory and scrolling budgets on the agreed low-end profile (4x CPU
// throttling; see docs/DEVELOPMENT.md). Thresholds are regression tripwires
// with headroom over measured values, not lab numbers: this box measures
// roughly 2-16s cold (dev-server transform noise), 1-2s cached, ~150 rows,
// 60-100MB heap, ~2.2s WASM init and 9-59fps scrolling (small-box variance).
test('startup, memory and scrolling stay within budget', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  let start = Date.now()
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  const cold = Date.now() - start
  // Rust SDK WASM compile plus platform init on first use (no account
  // needed; no network is touched until a client is built).
  const wasm = await page.evaluate(async () => {
    const start = performance.now()
    // @ts-expect-error Browser imports are resolved by the Vite development server.
    await import('/src/sdk/engine.ts').then(module => module.loadSdk())
    return Math.round(performance.now() - start)
  })
  start = Date.now()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  const cached = Date.now() - start
  // Multi-account switch render time on a warm page.
  start = Date.now()
  await page.getByRole('button', { name: 'Switch to Alex · Work' }).click()
  await expect(page.getByRole('heading', { name: 'Team lounge', exact: true })).toBeVisible()
  const switchMs = Date.now() - start
  await page.getByRole('button', { name: 'Switch to Alex Morgan' }).click()
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  const stats = await page.evaluate(async () => {
    // @ts-expect-error Browser imports are resolved by the Vite development server.
    const { state } = await import('/src/store.ts')
    const key = `${state.activeAccountId}/${state.activeRoomId}`
    const batch = Array.from({ length: 2000 }, (_, index) => ({
      id: `budget-${index}`, sender: '@perf:demo', name: 'Perf', body: `Budget message ${index}`,
      timestamp: Date.now() - (2000 - index) * 1000, own: false, kind: 'text', reactions: [],
    }))
    state.messages[key] = [...(state.messages[key] ?? []), ...batch]
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory
    return {
      loaded: state.messages[key].length,
      rows: document.querySelectorAll('article.message-row').length,
      heapMb: memory ? Math.round(memory.usedJSHeapSize / 1048576) : -1,
      feed: document.querySelector('.timeline')?.getAttribute('role'),
      first: document.querySelector('article.message-row')?.getAttribute('aria-posinset'),
      setsize: document.querySelector('article.message-row')?.getAttribute('aria-setsize'),
    }
  })
  // Scroll sweep across the whole windowed timeline, measuring frame rate.
  const fps = await page.evaluate(() => new Promise<number>(resolve => {
    const timeline = document.querySelector('.timeline')!
    timeline.scrollTop = 0
    const gaps: number[] = []
    let last = performance.now()
    const tick = () => {
      const now = performance.now()
      gaps.push(now - last)
      last = now
      if (timeline.scrollTop + timeline.clientHeight < timeline.scrollHeight - 50) {
        timeline.scrollTop += 600
        requestAnimationFrame(tick)
      } else resolve(Math.round(1000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length)))
    }
    requestAnimationFrame(tick)
  }))
  console.log(`perf: cold=${cold}ms cached=${cached}ms switch=${switchMs}ms wasm=${wasm}ms rows=${stats.rows}/${stats.loaded} heap=${stats.heapMb}MB fps=${fps} feed=${stats.feed} first-posinset=${stats.first} setsize=${stats.setsize}`)
  await session.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  await context.close()
  expect(cold).toBeLessThan(30000)
  expect(cached).toBeLessThan(8000)
  expect(switchMs).toBeLessThan(3000)
  expect(wasm).toBeLessThan(60000)
  expect(stats.rows).toBeLessThanOrEqual(170)
  if (stats.heapMb >= 0) expect(stats.heapMb).toBeLessThan(300)
  expect(fps).toBeGreaterThan(5)
  expect(stats.feed).toBe('feed')
  expect(Number(stats.first)).toBe(stats.loaded - stats.rows + 1)
  expect(Number(stats.setsize)).toBe(stats.loaded)
  expect(errors).toEqual([])
})
