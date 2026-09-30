import { describe, expect, it } from 'vitest'
import { elementCallJoin, isCallJoinedEcho, parseWidgetEvent, unsupportedWidgetMessage, widgetCapabilitiesSummary } from '../src/widgets'

// Room widget parsing and classification (#45): supported kinds load through
// the widget driver, everything else is refused with an actionable message.
describe('parseWidgetEvent', () => {
  it('parses a Jitsi widget', () => {
    expect(parseWidgetEvent('jitsi1', '@mod:example.org', { type: 'jitsi', name: 'Standup', url: 'https://meet.example.org/standup' }))
      .toEqual({ id: 'jitsi1', kind: 'jitsi', name: 'Standup', url: 'https://meet.example.org/standup', type: 'jitsi', sender: '@mod:example.org' })
  })

  it('classifies Element Call widgets by type and by URL', () => {
    expect(parseWidgetEvent('call', '@m:example.org', { type: 'm.room.call', url: 'https://call.example.org/room' })?.kind).toBe('element_call')
    expect(parseWidgetEvent('call', '@m:example.org', { type: 'custom', url: 'https://call.element.io/room' })?.kind).toBe('element_call')
  })

  it('keeps unknown types for actionable refusal', () => {
    const widget = parseWidgetEvent('board', '@m:example.org', { type: 'net.nordeck.whiteboard', name: 'Board', url: 'https://board.example.org/x' })!
    expect(widget.kind).toBe('unknown')
    expect(unsupportedWidgetMessage(widget)).toContain('net.nordeck.whiteboard')
    expect(unsupportedWidgetMessage(widget)).toContain('Element Call and Jitsi')
  })

  it('falls back to the state key for unnamed widgets', () => {
    expect(parseWidgetEvent('w1', '@m:example.org', { type: 'jitsi', url: 'https://meet.example.org/x' })?.name).toBe('w1')
  })

  it('drops events without a URL or state key', () => {
    expect(parseWidgetEvent('w1', '@m:example.org', { type: 'jitsi' })).toBeUndefined()
    expect(parseWidgetEvent('', '@m:example.org', { type: 'jitsi', url: 'https://meet.example.org/x' })).toBeUndefined()
    expect(parseWidgetEvent('w1', '@m:example.org', { type: 'jitsi', url: 'not a url at all' })?.kind).toBe('jitsi')
    expect(parseWidgetEvent('w1', '@m:example.org', { type: 'custom', url: 'not a url at all' })?.kind).toBe('unknown')
  })

  it('summarizes granted capabilities without overclaiming', () => {
    expect(widgetCapabilitiesSummary('jitsi')).toContain('No account data')
    expect(widgetCapabilitiesSummary('element_call')).toContain('Nothing else leaves this room')
    expect(widgetCapabilitiesSummary('unknown')).toContain('No account data')
  })
})

describe('preloaded call join', () => {
  it('builds the host-to-widget join envelope', () => {
    expect(elementCallJoin('fern-call-1', 'req-1')).toEqual({
      api: 'toWidget',
      action: 'io.element.join',
      widgetId: 'fern-call-1',
      requestId: 'req-1',
      data: {},
    })
  })

  it('generates a request id when none is given', () => {
    const first = elementCallJoin('fern-call-1')
    const second = elementCallJoin('fern-call-1')
    expect(typeof first.requestId).toBe('string')
    expect(first.requestId.length).toBeGreaterThan(0)
    expect(second.requestId).not.toBe(first.requestId)
  })

  it('recognizes the join echo without matching other actions', () => {
    expect(isCallJoinedEcho({ action: 'io.element.join' })).toBe(true)
    expect(isCallJoinedEcho({ action: 'io.element.close' })).toBe(false)
    expect(isCallJoinedEcho(null)).toBe(false)
    expect(isCallJoinedEcho(undefined)).toBe(false)
  })
})
