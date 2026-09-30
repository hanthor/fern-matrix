// One-time location sharing for issue #18. Only single fixes leave this
// module: background tracking (watchPosition, beacons) is deliberately absent
// — shares always begin with an explicit user gesture and a preview.
export interface Coordinates { lat: number; lon: number; uncertainty?: number }
export interface ShareableLocation extends Coordinates { description?: string }
export type LocationFailure = 'unsupported' | 'denied' | 'unavailable' | 'timeout'
export class LocationError extends Error {
  readonly code: LocationFailure
  constructor(code: LocationFailure, message: string) {
    super(message)
    this.code = code
  }
}
export function geolocationSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.geolocation?.getCurrentPosition
}
// RFC 5870 geo URI. Uncertainty rides the u parameter in meters.
export function formatGeoUri(location: Coordinates): string {
  const base = `geo:${location.lat},${location.lon}`
  return location.uncertainty !== undefined && Number.isFinite(location.uncertainty) && location.uncertainty > 0
    ? `${base};u=${Math.round(location.uncertainty)}`
    : base
}
// Parse back what we (or another client) sent. Returns undefined for anything
// outside valid ranges so hostile or corrupt events never render a map link.
export function parseGeoUri(uri: string): Coordinates | undefined {
  const match = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:;u=(\d+(?:\.\d+)?))?(?:;.*)?$/.exec(uri.trim())
  if (!match) return undefined
  const lat = Number(match[1])
  const lon = Number(match[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined
  const uncertainty = match[3] !== undefined ? Number(match[3]) : undefined
  return { lat, lon, ...(uncertainty !== undefined && Number.isFinite(uncertainty) && uncertainty > 0 ? { uncertainty } : {}) }
}
// Accessible text alternative: coordinates always render as text, never only
// as a visual map.
export function locationTextAlternative(location: ShareableLocation): string {
  const point = `${location.lat}, ${location.lon}`
  const accuracy = location.uncertainty !== undefined ? ` (±${Math.round(location.uncertainty)}m)` : ''
  const note = location.description?.trim() ? ` — ${location.description.trim()}` : ''
  return `Location shared: ${point}${accuracy}${note}`
}
export function locationFailureMessage(code: LocationFailure): string {
  if (code === 'denied') return 'Location access was denied. Allow location use in the browser site settings, then try again.'
  if (code === 'timeout') return 'Finding your location timed out. Try again with a clearer view of the sky or a network connection.'
  if (code === 'unsupported') return 'Location sharing is not supported in this browser.'
  return 'Your location could not be determined. Check location services and try again.'
}
function failureOf(error: unknown): LocationFailure {
  // Numeric codes mirror GeolocationPositionError (1 denied, 3 timeout); the
  // shape check keeps synthetics and shims classifiable too.
  const code = error instanceof GeolocationPositionError ? error.code
    : typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code: unknown }).code === 'number'
      ? (error as { code: number }).code
      : undefined
  if (code === 1) return 'denied'
  if (code === 3) return 'timeout'
  return 'unavailable'
}
// Single fix with a bounded wait: resolves once, never watches.
export function requestCurrentPosition(timeoutMs = 15_000): Promise<Coordinates> {
  if (!geolocationSupported()) return Promise.reject(new LocationError('unsupported', locationFailureMessage('unsupported')))
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      position => resolve({ lat: position.coords.latitude, lon: position.coords.longitude,
        ...(Number.isFinite(position.coords.accuracy) && position.coords.accuracy > 0 ? { uncertainty: position.coords.accuracy } : {}) }),
      error => { const code = failureOf(error); reject(new LocationError(code, locationFailureMessage(code))) },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
    )
  })
}
export type MapProvider = 'osm' | 'google'
export function mapLinkFor(location: Coordinates, provider: MapProvider): string {
  if (provider === 'google') return `https://www.google.com/maps/search/?api=1&query=${location.lat},${location.lon}`
  return `https://www.openstreetmap.org/?mlat=${location.lat}&mlon=${location.lon}#map=16/${location.lat}/${location.lon}`
}
