import { describe, expect, it } from 'vitest'
import { callServiceUrl, isCallMessage } from '../src/sdk/engine'

describe('call widget guard rails', () => {
  it('accepts the default and any HTTPS calling service', () => {
    expect(callServiceUrl(undefined, 'https://app.example').href).toBe('https://call.element.io/')
    expect(callServiceUrl('https://call.example.org/room', 'https://app.example').origin).toBe('https://call.example.org')
  })

  it('rejects remote plain-HTTP services but trusts this origin', () => {
    expect(() => callServiceUrl('http://call.example.org', 'https://app.example')).toThrow(/HTTPS/)
    expect(callServiceUrl('http://app.example/calls', 'http://app.example').origin).toBe('http://app.example')
  })

  it('only routes matching widget traffic to the driver', () => {
    const frame = {}
    const good = { origin: 'https://call.element.io', source: frame, data: { widgetId: 'w1' } }
    expect(isCallMessage(good, 'https://call.element.io', frame, 'w1')).toBe(true)
    expect(isCallMessage({ ...good, origin: 'https://evil.example' }, 'https://call.element.io', frame, 'w1')).toBe(false)
    expect(isCallMessage({ ...good, source: {} }, 'https://call.element.io', frame, 'w1')).toBe(false)
    expect(isCallMessage({ ...good, data: { widgetId: 'w2' } }, 'https://call.element.io', frame, 'w1')).toBe(false)
    expect(isCallMessage({ ...good, data: null }, 'https://call.element.io', frame, 'w1')).toBe(false)
  })
})
