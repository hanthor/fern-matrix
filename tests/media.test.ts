import { describe, expect, it } from 'vitest'
import { safeMediaMime } from '../src/sdk/engine'

describe('safe download MIME mapping', () => {
  it('keeps renderable image, audio and video types', () => {
    expect(safeMediaMime('image/png')).toBe('image/png')
    expect(safeMediaMime('image/jpeg')).toBe('image/jpeg')
    expect(safeMediaMime('image/webp')).toBe('image/webp')
    expect(safeMediaMime('image/gif')).toBe('image/gif')
    expect(safeMediaMime('audio/ogg')).toBe('audio/ogg')
    expect(safeMediaMime('video/mp4')).toBe('video/mp4')
  })
  it('downgrades executable document types to bytes', () => {
    expect(safeMediaMime('text/html')).toBe('application/octet-stream')
    expect(safeMediaMime('image/svg+xml')).toBe('application/octet-stream')
    expect(safeMediaMime('application/xhtml+xml')).toBe('application/octet-stream')
    expect(safeMediaMime(undefined)).toBe('application/octet-stream')
    expect(safeMediaMime('')).toBe('application/octet-stream')
  })
  it('rejects MIME smuggling with parameters or casing', () => {
    expect(safeMediaMime('image/png;script=1')).toBe('application/octet-stream')
    expect(safeMediaMime('IMAGE/PNG')).toBe('application/octet-stream')
    expect(safeMediaMime(' text/html')).toBe('application/octet-stream')
  })
})
