import { beforeEach, describe, expect, it, vi } from 'vitest'
import { demoEnabled } from '../src/store'

// Demo availability: build flag, explicit URL override, test carve-out, and
// the login-gate default. Runs in the node environment (no location object),
// which also proves the non-URL guards.
describe('demoEnabled', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  it('enables the tour when the build flag is set', () => {
    vi.stubEnv('VITE_FERN_DEMO', '1')
    expect(demoEnabled()).toBe(true)
  })

  it('forces the login gate when the build flag is off', () => {
    vi.stubEnv('VITE_FERN_DEMO', '0')
    expect(demoEnabled()).toBe(false)
  })

  it('keeps the fixtures under unit tests with no flag', () => {
    expect(demoEnabled()).toBe(true)
  })
})
