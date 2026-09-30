import { describe, expect, it } from 'vitest'
import { parseSlashCommand } from '../src/slash'

// Slash parsing is UI-free: every supported command, its usage errors,
// the `//` escape and non-command text are covered without WASM.
describe('parseSlashCommand', () => {
  it('returns null for ordinary messages', () => {
    expect(parseSlashCommand('hello world')).toBeNull()
    expect(parseSlashCommand('')).toBeNull()
    expect(parseSlashCommand(' /me later')).toBeNull()
  })

  it('parses /me with its action text', () => {
    expect(parseSlashCommand('/me waves hello')).toEqual({ name: 'me', text: 'waves hello' })
  })

  it('rejects /me without action text', () => {
    expect(parseSlashCommand('/me')?.name).toBe('unknown')
    expect(parseSlashCommand('/me   ')?.name).toBe('unknown')
  })

  it('parses room commands', () => {
    expect(parseSlashCommand('/topic hello topic')).toEqual({ name: 'topic', text: 'hello topic' })
    expect(parseSlashCommand('/topic')).toEqual({ name: 'topic', text: '' })
    expect(parseSlashCommand('/name New name')).toEqual({ name: 'name', text: 'New name' })
    expect(parseSlashCommand('/invite @bob:example.org')).toEqual({ name: 'invite', userId: '@bob:example.org' })
    expect(parseSlashCommand('/join #room:example.org')).toEqual({ name: 'join', target: '#room:example.org' })
    expect(parseSlashCommand('/leave')).toEqual({ name: 'leave' })
    expect(parseSlashCommand('/part')).toEqual({ name: 'leave' })
  })

  it('rejects malformed room commands with usage', () => {
    for (const body of ['/name', '/invite not-a-user', '/invite @missing-domain', '/join']) {
      const parsed = parseSlashCommand(body)
      expect(parsed?.name).toBe('unknown')
      expect((parsed as { command: string }).command).toMatch('Usage:')
    }
  })

  it('flags unknown commands without sending', () => {
    const parsed = parseSlashCommand('/dance wildly')
    expect(parsed?.name).toBe('unknown')
    expect((parsed as { command: string }).command).toMatch('/dance')
  })

  it('escapes // to a literal slash message', () => {
    expect(parseSlashCommand('//me not a command')).toEqual({ name: 'literal', text: '/me not a command' })
  })

  it('matches commands case-insensitively', () => {
    expect(parseSlashCommand('/ME waves')).toEqual({ name: 'me', text: 'waves' })
  })
})
