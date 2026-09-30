import { describe, expect, it } from 'vitest'
import { MatrixEngine } from '../src/sdk/engine'

// The OIDC happy path needs the real SDK (urlForOidc, callbacks); these tests
// cover the flow bookkeeping that guards it: expiry, redirect-target matching
// and idempotent cancellation. Nothing is persisted until the callback lands.
function engineWithFlow() {
  const engine = new MatrixEngine({ account() {}, rooms() {}, error() {} })
  const calls: string[] = []
  const flows = (engine as unknown as { oidcFlows: Map<string, unknown> }).oidcFlows
  flows.set('flow-1', {
    client: {
      loginWithOidcCallback: async () => { calls.push('finish') },
      abortOidcAuth: async () => { calls.push('abort') },
    },
    auth: {},
    data: { storeId: 'pending', passphrase: 'pending', session: undefined },
    redirectUri: 'https://app.example/oidc-callback.html',
  })
  return { engine, calls, flows }
}

describe('OIDC flow bookkeeping', () => {
  it('rejects unknown or already-completed flows', async () => {
    const { engine } = engineWithFlow()
    await expect(engine.finishOidcLogin('nope', 'https://app.example/oidc-callback.html?code=x')).rejects.toThrow('expired or was already completed')
  })

  it('rejects callbacks that do not match the pending redirect target', async () => {
    const { engine, flows } = engineWithFlow()
    await expect(engine.finishOidcLogin('flow-1', 'https://evil.example/cb?code=x')).rejects.toThrow('does not match the pending request')
    // The mismatched attempt consumes the flow instead of leaving it reusable.
    expect(flows.has('flow-1')).toBe(false)
    await expect(engine.finishOidcLogin('flow-1', 'https://app.example/oidc-callback.html?code=x')).rejects.toThrow('expired or was already completed')
  })

  it('cancels pending flows idempotently', async () => {
    const { engine, calls, flows } = engineWithFlow()
    await engine.cancelOidcLogin('flow-1')
    expect(calls).toEqual(['abort'])
    expect(flows.has('flow-1')).toBe(false)
    await engine.cancelOidcLogin('flow-1')
    await engine.cancelOidcLogin('unknown')
    expect(calls).toEqual(['abort'])
  })

  it('tracks legacy SSO flows with the same bookkeeping', async () => {
    const engine = new MatrixEngine({ account() {}, rooms() {}, error() {} })
    const calls: string[] = []
    const flows = (engine as unknown as { ssoFlows: Map<string, unknown> }).ssoFlows
    flows.set('sso-1', {
      client: {},
      handler: { finish: async () => { calls.push('finish') } },
      data: { storeId: 'pending', passphrase: 'pending', session: undefined },
      redirectUri: 'https://app.example/oidc-callback.html',
    })
    await expect(engine.finishSsoLogin('missing', 'https://app.example/oidc-callback.html?x=1')).rejects.toThrow('expired or was already completed')
    await expect(engine.finishSsoLogin('sso-1', 'https://evil.example/cb')).rejects.toThrow('does not match the pending request')
    expect(flows.has('sso-1')).toBe(false)
    await engine.cancelSsoLogin('sso-1')
    await engine.cancelSsoLogin('missing')
    expect(calls).toEqual([])
  })

  // The dynamic SDK import dominates this test's wall time on loaded
  // machines, so it carries its own timeout; the assertion is unchanged.
  it('starts no flow without the SDK and persists nothing beforehand', async () => {
    const engine = new MatrixEngine({ account() {}, rooms() {}, error() {} })
    const flows = (engine as unknown as { oidcFlows: Map<string, unknown> }).oidcFlows
    // loadSdk is attempted first; with no browser WASM this rejects, and no
    // pending flow may be recorded by a failed start.
    await expect(engine.startOidcLogin('https://matrix.example', 'https://app.example/oidc-callback.html')).rejects.toThrow()
    expect(flows.size).toBe(0)
  }, 30000)
})
