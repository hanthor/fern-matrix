import { expect, type Page } from '@playwright/test'

/** Fresh document, real adapter cleanup, and physical deletion: no test-side deletes. */
export async function finishLocalCleanup(page: Page, id: string, boot: (page: Page) => Promise<void>) {
  await boot(page) // Disposes the old document's WASM references, not another account's storage.
  await page.evaluate(() => window.matrixTest.engine.restoreAll())
  await expect.poll(() => page.evaluate(async id => ({
    databases: (await indexedDB.databases()).filter(db => [
      `fern-${id}`, `fern-${id}::matrix-sdk-crypto`, `fern-${id}::matrix-sdk-state`,
    ].includes(db.name ?? '')).length,
    routing: !!JSON.parse(localStorage.getItem('fern.sessions.v1') ?? '{}')[id],
    secret: localStorage.getItem(`fern.secrets.v1.${id}`) !== null,
    drafts: Object.keys(localStorage).some(key => key.startsWith(`fern.draft.${id}/`)),
    restored: !!window.matrixTest.accounts[id],
    tombstone: localStorage.getItem(`fern.removing.${id}`),
  }), id)).toEqual({ databases: 0, routing: false, secret: false, drafts: false, restored: false, tombstone: '1' })
}
