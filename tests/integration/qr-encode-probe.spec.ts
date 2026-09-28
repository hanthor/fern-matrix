// SCRATCH PROBE - not for commit. Verifies the fork's QrCodeData.toBytes/
// toBase64 through Fern's real vendored wasm + generated TS. Run only with
// candidate artifacts swapped in; delete after the probe run.
import { test, expect, type Page } from '@playwright/test'

// Same synthetic MSC4108 builder as qr.spec.ts.
function loginBytes(intent: number, rendezvous: string, server?: string): number[] {
  const out: number[] = [77, 65, 84, 82, 73, 88, 2, intent, ...new Array(32).fill(7)]
  const url = [...rendezvous].map(c => c.charCodeAt(0))
  out.push((url.length >> 8) & 0xff, url.length & 0xff, ...url)
  if (server !== undefined) {
    const name = [...server].map(c => c.charCodeAt(0))
    out.push((name.length >> 8) & 0xff, name.length & 0xff, ...name)
  }
  return out
}

async function roundTrip(page: Page, bytes: number[]) {
  return page.evaluate(async (raw: number[]) => {
    // @ts-expect-error Resolved by Vite in the browser.
    const sdk = await import('/src/sdk/index.ts')
    await sdk.uniffiInitAsync()
    const code = sdk.QrCodeData.fromBytes(new Uint8Array(raw).buffer)
    // toBytes/toBase64 only exist with the fork-candidate artifacts.
    const out = {
      base64: (code as unknown as { toBase64: () => string }).toBase64(),
      bytes: Array.from(new Uint8Array((code as unknown as { toBytes: () => ArrayBuffer }).toBytes())),
    }
    const again = sdk.QrCodeData.fromBytes(new Uint8Array(out.bytes).buffer)
    return { ...out, serverName: again.serverName() ?? null }
  }, bytes)
}

test('fork QrCodeData serializes back to identical bytes and base64', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await page.goto('http://127.0.0.1:5173/tests/integration/client.html')
    const raw = loginBytes(4, 'http://127.0.0.1:9/x', 'example:x')
    const got = await roundTrip(page, raw)
    expect(got.bytes).toEqual(raw)
    expect(got.base64).toBe(Buffer.from(raw).toString('base64'))
    expect(got.serverName).toBe('example:x')
  } finally {
    await context.close()
  }
})
