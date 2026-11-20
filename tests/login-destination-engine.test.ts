import { beforeEach, describe, expect, it, vi } from 'vitest'
const probe = vi.hoisted(() => ({ configured: [] as [string, string][], credentials: [] as [string, string, string][], fail: false }))
vi.mock('../src/sdk/index', () => {
  class ClientBuilder {
    server = ''
    inMemoryStore() { return this }
    indexeddbStore() { return this }
    backupDownloadStrategy() { return this }
    threadsEnabled() { return this }
    autoEnableCrossSigning() { return this }
    setSessionDelegate() { return this }
    slidingSyncVersionBuilder() { return this }
    serverName() { throw new Error('Strict well-known-only discovery must not be selected') }
    serverNameOrHomeserverUrl(server: string) { probe.configured.push(['sdk-discovery', server]); this.server = server; return this }
    async build() {
      if (probe.fail) throw new Error('Discovery failed')
      // Synthetic SDK discovery contract: legitimate endpoint delegation.
      const endpoint = this.server === 'other.example' ? 'https://delegate.example.net' : this.server.startsWith('https://') ? this.server : `https://${this.server}`
      return {
        homeserver: () => endpoint,
        homeserverLoginDetails: async () => ({ supportsPasswordLogin: () => true, supportsSsoLogin: () => false, supportsOidcLogin: () => false }),
        login: async (username: string, password: string) => { probe.credentials.push([endpoint, username, password]); throw new Error('Stop after synthetic credential dispatch') },
      }
    }
  }
  return { ClientBuilder, IndexedDbStoreBuilder: class { passphrase() { return this } }, BackupDownloadStrategy: { AfterDecryptionFailure: 1 }, SlidingSyncVersionBuilder: { DiscoverNative: 1 }, LogLevel: { Warn: 1 }, uniffiInitAsync: async () => {}, initPlatform: () => {} }
})
import { MatrixEngine } from '../src/sdk/engine'
beforeEach(() => { probe.configured.length = 0; probe.credentials.length = 0; probe.fail = false })
describe('SDK destination adapter', () => {
  it('discovers and sends full-ID credentials through the same logical-server policy, allowing delegation', async () => {
    const engine = new MatrixEngine({ account() {}, rooms() {}, error() {} })
    expect(await engine.loginMethods('other.example', true)).toMatchObject({ password: true, homeserverUrl: 'https://delegate.example.net' })
    expect(probe.credentials).toEqual([])
    await expect(engine.login('other.example', '@alice:other.example', 'synthetic', false, true)).rejects.toThrow('Stop after synthetic')
    expect(probe.configured).toEqual([['sdk-discovery', 'other.example'], ['sdk-discovery', 'other.example']])
    expect(probe.credentials).toEqual([['https://delegate.example.net', '@alice:other.example', 'synthetic']])
  })
  it('does not dispatch credentials or fall back when logical discovery fails', async () => {
    probe.fail = true
    const engine = new MatrixEngine({ account() {}, rooms() {}, error() {} })
    await expect(engine.login('other.example', '@alice:other.example', 'synthetic', false, true)).rejects.toThrow('Discovery failed')
    expect(probe.configured).toEqual([['sdk-discovery', 'other.example']])
    expect(probe.credentials).toEqual([])
  })
  it('preserves a custom endpoint with a short username', async () => {
    const engine = new MatrixEngine({ account() {}, rooms() {}, error() {} })
    await expect(engine.login('https://custom.example', 'alice', 'synthetic')).rejects.toThrow('Stop after synthetic')
    expect(probe.configured).toEqual([['sdk-discovery', 'https://custom.example']])
    expect(probe.credentials[0]?.[0]).toBe('https://custom.example')
  })
})

it('allows the SDK to use a direct endpoint on the same logical authority without a well-known document', async () => {
  const engine = new MatrixEngine({ account() {}, rooms() {}, error() {} })
  expect(await engine.loginMethods('direct.example:8448', true)).toMatchObject({ homeserverUrl: 'https://direct.example:8448' })
  await expect(engine.login('direct.example:8448', '@alice:direct.example:8448', 'synthetic', false, true)).rejects.toThrow('Stop after synthetic')
  expect(probe.configured).toEqual([['sdk-discovery', 'direct.example:8448'], ['sdk-discovery', 'direct.example:8448']])
  expect(probe.credentials[0]?.[0]).toBe('https://direct.example:8448')
})
