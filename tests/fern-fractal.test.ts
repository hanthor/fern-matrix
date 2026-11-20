import { describe, expect, it } from 'vitest'
import { fernPaths } from '../src/fern-fractal'

describe('Barnsley fern artwork', () => {
  it('is deterministic and batches a bounded 6000 points into 24 fronds', () => {
    const paths = fernPaths()
    expect(paths).toEqual(fernPaths())
    expect(paths).toHaveLength(24)
    expect(paths.join('').match(/M/g)).toHaveLength(6000)
    expect(fernPaths(100000)).toEqual(paths)
  })
  it('keeps every point within the centered SVG viewBox', () => {
    const points = [...fernPaths().join('').matchAll(/M([\d.]+) ([\d.]+)h/g)]
    expect(points).toHaveLength(6000)
    const xs = points.map(point => Number(point[1]))
    expect(Math.abs((Math.min(...xs) + Math.max(...xs) + 0.65) / 2 - 100)).toBeLessThan(1)
    for (const [, x, y] of points) {
      expect(Number(x)).toBeGreaterThan(40)
      expect(Number(x)).toBeLessThan(160)
      expect(Number(y)).toBeGreaterThan(9)
      expect(Number(y)).toBeLessThanOrEqual(230)
    }
  })
  it('handles invalid and fractional budgets without unbounded work', () => {
    for (const count of [-1, NaN, Infinity, 0]) expect(fernPaths(count).join('')).toBe('')
    expect(fernPaths(12.9).join('').match(/M/g)).toHaveLength(12)
  })
})
