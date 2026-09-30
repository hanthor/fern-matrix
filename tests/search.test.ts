import { describe, expect, it } from 'vitest'
import { matchMessage } from '../src/store'
import type { Message } from '../src/types'

function text(body: string, name = 'Alice'): Message {
  return { id: 'x', sender: '@alice:example', name, body, timestamp: 1, own: false, kind: 'text', reactions: [] }
}

describe('message search matcher', () => {
  it('matches body case-insensitively', () => {
    expect(matchMessage(text('Hello Fern world'), 'fern')).toBe(true)
    expect(matchMessage(text('Hello world'), 'fern')).toBe(false)
  })
  it('requires every query word', () => {
    expect(matchMessage(text('calm fern workspace'), 'fern workspace')).toBe(true)
    expect(matchMessage(text('calm fern chat'), 'fern workspace')).toBe(false)
  })
  it('matches sender, attachment and poll fields', () => {
    expect(matchMessage(text('hi', 'Fern Bot'), 'bot')).toBe(true)
    expect(matchMessage({ ...text('see attached'), kind: 'file', attachment: { name: 'budget.pdf', size: 1, mime: 'application/pdf' } }, 'budget')).toBe(true)
    expect(matchMessage({ ...text('vote now'), kind: 'poll', poll: { question: 'Lunch venue?', answers: [], voted: undefined, kind: 'disclosed', ended: false, edited: false } }, 'venue')).toBe(true)
  })
  it('treats an empty query as a match', () => {
    expect(matchMessage(text('anything'), '')).toBe(true)
  })
})
