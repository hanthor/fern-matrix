import { chromium } from '@playwright/test'
import { readdir, readFile, mkdir } from 'node:fs/promises'
const origin = process.env.FERN_SMOKE_ORIGIN || 'http://127.0.0.1:4173'
const base = process.env.FERN_BASE_PATH || '/'
const browser = await chromium.launch({ executablePath: process.env.FERN_CHROMIUM_PATH || '/home/ubuntu/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
try {
  await page.goto(`${origin}${base}`)
  await page.getByRole('heading', { name: 'General', exact: true }).waitFor()
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
  const manifest = await page.evaluate(async base => (await fetch(`${base}manifest.webmanifest`)).json(), base)
  if (manifest.start_url !== base || manifest.icons.some(icon => !icon.src.startsWith(base))) throw new Error('Manifest base path is incorrect')
  let sdkFile
  for (const file of await readdir(new URL('../dist/assets/', import.meta.url))) {
    if (file.endsWith('.js') && (await readFile(new URL(`../dist/assets/${file}`, import.meta.url), 'utf8')).includes('as uniffiInitAsync')) sdkFile = file
  }
  if (!sdkFile) throw new Error('SDK chunk is missing')
  const sdkUrl = `${base}assets/${sdkFile}`
  async function initializeSdk() {
    return page.evaluate(async url => {
      const sdk = await import(url)
      await sdk.uniffiInitAsync()
      return typeof new sdk.ClientBuilder().build
    }, sdkUrl)
  }
  if (await initializeSdk() !== 'function') throw new Error('SDK did not initialize')
  await page.getByRole('button', { name: 'Room information' }).click()
  await mkdir(new URL('../docs/screenshots/', import.meta.url), { recursive: true })
  await page.screenshot({ path: 'docs/screenshots/desktop.png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: 'docs/screenshots/dark.png' })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.getByRole('button', { name: 'Close room details' }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await page.locator('.room-item').filter({ hasText: 'General' }).click()
  await page.screenshot({ path: 'docs/screenshots/mobile.png' })
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Mobile view overflows')
  await page.context().setOffline(true)
  await page.reload()
  await page.getByRole('searchbox', { name: 'Search conversations' }).waitFor()
  if (await initializeSdk() !== 'function') throw new Error('Cached SDK did not initialize offline')
  if (errors.length) throw new Error(errors.join('\n'))
  console.log('Production smoke passed: subdirectory assets, manifest, Rust WASM, desktop/dark/mobile, offline shell and offline SDK initialization.')
} finally { await browser.close() }
