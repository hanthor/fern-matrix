import { describe, expect, it } from 'vitest'
import { forwardBlockReason, forwardPreview } from '../src/forward'
import type { Message } from '../src/types'

function text(body: string): Message {
  return { id: '$event', sender: '@alice:example', name: 'Alice', body, timestamp: 1, own: false, kind: 'text', reactions: [] }
}

describe('forward eligibility', () => {
  it('allows ordinary sent text and media', () => {
    expect(forwardBlockReason(text('hello'))).toBeUndefined()
    expect(forwardBlockReason({ ...text('file'), kind: 'file', attachment: { name: 'a.bin', size: 1, mime: 'application/octet-stream' } })).toBeUndefined()
  })
  it('blocks unsent messages', () => {
    expect(forwardBlockReason({ ...text('hi'), status: 'sending' })).toContain('Wait for the send')
    expect(forwardBlockReason({ ...text('hi'), id: 'txn-1', status: 'failed' })).toContain('Only sent messages')
    expect(forwardBlockReason({ ...text('hi'), id: 'local-uuid' })).toBeUndefined()
  })
  it('blocks polls, notices, removed and undecryptable events', () => {
    expect(forwardBlockReason({ ...text('q'), kind: 'poll' })).toContain('Polls cannot be forwarded')
    expect(forwardBlockReason({ ...text('Message removed'), kind: 'notice' })).toContain('removed')
    expect(forwardBlockReason({ ...text('Unable to decrypt this message.'), kind: 'notice' })).toContain('decrypted')
  })
  it('blocks locations without coordinates', () => {
    expect(forwardBlockReason({ ...text('loc'), kind: 'location' })).toContain('location cannot be forwarded')
  })
})
describe('forward preview', () => {
  it('summarizes without dumping full bodies', () => {
    expect(forwardPreview(text('x'.repeat(200)))).toHaveLength(91)
    expect(forwardPreview({ ...text('f'), kind: 'file', attachment: { name: 'photo.png', size: 1, mime: 'image/png' } })).toBe('photo.png')
  })
})
