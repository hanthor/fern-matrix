import { describe, expect, it } from 'vitest'
import { parseKnockRequests } from '../src/knock'

// Knock request parsing (#41): knocking memberships become reviewable
// requests; anything malformed is skipped, never trusted.
describe('parseKnockRequests', () => {
  it('parses knockers with reasons', () => {
    expect(parseKnockRequests({ chunk: [
      { state_key: '@bob:example.org', sender: '@bob:example.org', content: { membership: 'knock', reason: 'Let me in' } },
      { state_key: '@carol:example.org', sender: '@carol:example.org', content: { membership: 'knock' } },
    ] })).toEqual([
      { userId: '@bob:example.org', reason: 'Let me in' },
      { userId: '@carol:example.org' },
    ])
  })

  it('falls back to the sender and trims blank reasons', () => {
    expect(parseKnockRequests({ chunk: [
      { sender: '@dave:example.org', content: { reason: '  ' } },
      { content: { membership: 'knock' } },
    ] })).toEqual([{ userId: '@dave:example.org' }])
  })

  it('rejects non-list bodies', () => {
    expect(parseKnockRequests(null)).toEqual([])
    expect(parseKnockRequests({})).toEqual([])
    expect(parseKnockRequests({ chunk: 'knock' })).toEqual([])
  })
})
