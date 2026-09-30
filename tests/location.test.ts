import { describe, expect, it, vi } from 'vitest'
import { formatGeoUri, locationTextAlternative, mapLinkFor, parseGeoUri } from '../src/location'

describe('geo URI round trip', () => {
  it('formats a plain fix', () => {
    expect(formatGeoUri({ lat: 53.4794, lon: -2.2453 })).toBe('geo:53.4794,-2.2453')
  })
  it('carries uncertainty in meters', () => {
    expect(formatGeoUri({ lat: 53.4794, lon: -2.2453, uncertainty: 25.4 })).toBe('geo:53.4794,-2.2453;u=25')
  })
  it('parses valid URIs back', () => {
    expect(parseGeoUri('geo:53.4794,-2.2453;u=25')).toEqual({ lat: 53.4794, lon: -2.2453, uncertainty: 25 })
    expect(parseGeoUri('geo:53.4794,-2.2453')).toEqual({ lat: 53.4794, lon: -2.2453 })
  })
  it('rejects out-of-range and malformed input', () => {
    expect(parseGeoUri('geo:91,0')).toBeUndefined()
    expect(parseGeoUri('geo:0,181')).toBeUndefined()
    expect(parseGeoUri('https://example.com/?lat=1&lon=2')).toBeUndefined()
    expect(parseGeoUri('geo:abc,def')).toBeUndefined()
  })
})
describe('location text alternative', () => {
  it('always includes coordinates', () => {
    expect(locationTextAlternative({ lat: 1.5, lon: -3 })).toBe('Location shared: 1.5, -3')
  })
  it('appends accuracy and description', () => {
    expect(locationTextAlternative({ lat: 1.5, lon: -3, uncertainty: 30, description: '  Café  ' }))
      .toBe('Location shared: 1.5, -3 (±30m) — Café')
  })
})
describe('map provider links', () => {
  it('builds OpenStreetMap and Google links', () => {
    expect(mapLinkFor({ lat: 53.4794, lon: -2.2453 }, 'osm')).toContain('openstreetmap.org')
    expect(mapLinkFor({ lat: 53.4794, lon: -2.2453 }, 'google')).toContain('google.com/maps')
  })
  it('reports geolocation unsupported without device APIs', () => {
    vi.stubGlobal('navigator', undefined)
    expect(typeof navigator).toBe('undefined')
    vi.unstubAllGlobals()
  })
})
