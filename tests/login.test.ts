import { describe, expect, it } from 'vitest'
import { isPasswordLoginRejected } from '../src/login'

describe('password sign-in hint boundary', () => {
  it('recognizes only structured SDK refusal, never account existence', () => {
    expect(isPasswordLoginRejected({ tag: 'MatrixApi', inner: { code: 'M_FORBIDDEN' } })).toBe(true)
    expect(isPasswordLoginRejected({ tag: 'MatrixApi', inner: { kind: { tag: 'Forbidden' } } })).toBe(true)
  })
  it.each([undefined, null, 'M_FORBIDDEN', new Error('403 invalid password'),
    { tag: 'Generic', inner: { msg: 'M_FORBIDDEN' } },
    { tag: 'MatrixApi', inner: { code: 'M_LIMIT_EXCEEDED' } },
    { tag: 'MatrixApi', inner: { code: 'M_UNKNOWN' } },
    { tag: 'Oidc', inner: { code: 'M_FORBIDDEN' } },
  ])('does not turn connectivity, SSO, rate limits or prose into a registration hint: %s', error => {
    expect(isPasswordLoginRejected(error)).toBe(false)
  })
})

import { configureLoginServer, loginDestination, validMatrixServerName } from '../src/login'

describe('credential destination selection', () => {
  it('makes a full Matrix ID authoritative, including ports and IPv6', () => {
    for (const server of ['other.example', 'other.example:8448', '[2001:db8::1]:8448']) {
      expect(loginDestination(`@alice:${server}`, 'matrix.org')).toEqual({ server, logicalServer: true })
    }
    expect(loginDestination('@alice:other.example', 'https://custom.example')).toEqual({ server: 'other.example', logicalServer: true })
  })
  it('keeps an explicit endpoint for a short username', () => {
    expect(loginDestination('alice', 'https://custom.example/matrix')).toEqual({ server: 'https://custom.example/matrix', logicalServer: false })
  })
  it.each(['@alice', '@:other.example', '@alice:https://other.example', '@alice:other.example/path', '@alice:other.example?x=1', '@alice:other.example#fragment', '@alice:other.example:70000', '@alice:[not-ip]', '@alice:other..example', '@alice:other.example\\evil', '@alice:other.example@evil.example', '@alice:other.example%2fevil', '@alice: other.example'])('rejects malformed IDs locally: %s', username => {
    expect(loginDestination(username, 'matrix.org').error).toBe('invalidMxid')
  })
  it.each(['https://user:secret@example.org', 'https://example.org?x=1', 'https://example.org#fragment', 'file:///tmp/server', 'example.org/path', ' example.org', 'example..org'])('rejects malformed explicit destinations: %s', server => {
    expect(loginDestination('alice', server).error).toBe('invalidServer')
  })
  it('keeps registration localpart-only without deriving a destination', () => {
    expect(loginDestination('@alice:other.example', 'matrix.org', true).error).toBe('registrationLocalpart')
    expect(loginDestination('alice', 'matrix.org', true)).toEqual({ server: 'matrix.org', logicalServer: false })
  })
  it('selects SDK logical-name discovery without comparing delegated endpoint hosts', () => {
    const delegated = { endpoint: 'https://delegate.example.net' }
    const calls: string[] = []
    const builder = { serverName: () => { throw new Error('Strict well-known-only discovery is not used') }, serverNameOrHomeserverUrl: (server: string) => { calls.push(server); return delegated } }
    expect(configureLoginServer(builder, 'other.example', true)).toBe(delegated)
    expect(calls).toEqual(['other.example'])
    expect(validMatrixServerName('other.example:8448')).toBe(true)
    for (const server of ['other.example:8448', '[2001:db8::1]:8448']) configureLoginServer(builder, server, true)
    expect(calls).toEqual(['other.example', 'other.example:8448', '[2001:db8::1]:8448'])
    expect(() => configureLoginServer(builder, 'https://wrong.example', true)).toThrow('Invalid Matrix homeserver authority')
  })
})
