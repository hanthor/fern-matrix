import { describe, expect, it } from 'vitest'
import { state, openThread, closeThread, threadUnread, threadReply } from '../src/store'

describe('thread state', () => {
  it('opens demo threads from loaded messages and tracks seen replies', async () => {
    await openThread('demo-home', 'general', 'm2')
    expect(state.thread?.root?.id).toBe('m2')
    expect(state.thread?.messages.map(message => message.id)).toEqual(['m2', 'm2r1', 'm2r2'])
    expect(state.thread?.end).toBe(true)
    expect(threadUnread('demo-home', 'general', 'm2', 2)).toBe(0)
    expect(threadUnread('demo-home', 'general', 'm2', 5)).toBe(3)
    closeThread()
    expect(state.thread).toBeUndefined()
  })
  it('appends demo thread replies and keeps unseen counts honest', async () => {
    await openThread('demo-home', 'general', 'm2')
    expect(await threadReply('A threaded hello')).toBe(true)
    expect(state.thread?.messages.at(-1)?.body).toBe('A threaded hello')
    expect(state.thread?.messages.at(-1)?.threadRoot).toBe('m2')
    closeThread()
    const stored = state.messages['demo-home/general']
    stored.pop()
    delete state.threadSeen['demo-home/general/m2']
  })
  it('falls back gracefully when the root is missing', async () => {
    await openThread('demo-home', 'general', '$missing')
    expect(state.thread?.root).toBeUndefined()
    expect(state.thread?.messages).toEqual([])
    closeThread()
  })
})
