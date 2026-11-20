import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('public client deployment', () => {
  it('does not seed the demo on GitHub Pages', () => {
    const workflow = readFileSync(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8')
    expect(workflow).toContain("VITE_FERN_DEMO: '0'")
    expect(workflow).not.toContain("VITE_FERN_DEMO: '1'")
  })
})
