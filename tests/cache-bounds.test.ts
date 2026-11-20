import { describe, expect, it, vi } from 'vitest'
import { boundedSet, EVENT_CACHE_LIMIT, OBJECT_URL_LIMIT } from '../src/sdk/engine'

describe('boundedSet', () => {
  it('evicts the oldest entry once the limit is reached', () => {
    const map = new Map<string, number>()
    boundedSet(map, 'a', 1, 2)
    boundedSet(map, 'b', 2, 2)
    boundedSet(map, 'c', 3, 2)
    expect([...map.keys()]).toEqual(['b', 'c'])
    expect(map.size).toBe(2)
  })

  it('refreshes an existing key instead of evicting', () => {
    const map = new Map<string, number>()
    boundedSet(map, 'a', 1, 2)
    boundedSet(map, 'b', 2, 2)
    boundedSet(map, 'a', 10, 2)
    boundedSet(map, 'c', 3, 2)
    expect([...map.entries()]).toEqual([['a', 10], ['c', 3]])
  })

  it('reports the evicted value so object URLs can be revoked', () => {
    const map = new Map<string, string>()
    const onEvict = vi.fn()
    boundedSet(map, 'a', 'url-a', 1, onEvict)
    boundedSet(map, 'b', 'url-b', 1, onEvict)
    expect(onEvict).toHaveBeenCalledTimes(1)
    expect(onEvict).toHaveBeenCalledWith('url-a')
  })

  it('keeps production limits generous enough for visible content', () => {
    expect(EVENT_CACHE_LIMIT).toBeGreaterThanOrEqual(1000)
    expect(OBJECT_URL_LIMIT).toBeGreaterThanOrEqual(100)
  })
})
