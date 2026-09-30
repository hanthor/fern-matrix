import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const worker = readFileSync(join(root, 'public/sw.js'), 'utf8')
const builder = readFileSync(join(root, 'scripts/build-sw.mjs'), 'utf8')

describe('service worker cache scope', () => {
  it('only caches same-origin GET requests for listed app assets', () => {
    expect(worker).toContain("request.method !== 'GET'")
    expect(worker).toContain('url.origin !== self.location.origin')
    expect(worker).toContain('assets/')
    expect(worker).toContain('APP_ASSETS')
    expect(worker.match(/cache\.put/g)?.length).toBe(1)
  })
  it('never names Matrix, media or credentialed endpoints as cacheable', () => {
    for (const forbidden of ['_matrix', 'mxc', '/media/', 'Authorization', 'access_token']) {
      expect(worker).not.toContain(forbidden)
      expect(builder).not.toContain(forbidden)
    }
  })
  it('precaches only hashed bundles and listed public files', () => {
    expect(builder).toContain('/\\.(js|css|woff2)$/')
    expect(builder).toContain("'index.html', 'fern.svg', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'")
    expect(worker).toContain('cache.addAll(APP_ASSETS)')
  })
})
