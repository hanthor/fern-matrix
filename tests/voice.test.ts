import { describe, expect, it, vi } from 'vitest'
import { clipExtension, formatVoiceDuration, normalizeWaveform, pickRecorderMime, recordingSupported } from '../src/voice'

describe('voice waveform normalization', () => {
  it('keeps peaks across a fixed bar count', () => {
    expect(normalizeWaveform([0, 0.5, 0, 1, 0, 0.25], 3)).toEqual([0.5, 1, 0.25])
  })
  it('clamps and rounds levels into 0..1', () => {
    expect(normalizeWaveform([2, -1, 0.12345], 3)).toEqual([1, 0, 0.123])
  })
  it('returns no bars for empty input', () => {
    expect(normalizeWaveform([], 32)).toEqual([])
  })
})
describe('voice clip helpers', () => {
  it('formats durations as m:ss', () => {
    expect(formatVoiceDuration(1000)).toBe('0:01')
    expect(formatVoiceDuration(65000)).toBe('1:05')
  })
  it('maps MIME types to playable extensions', () => {
    expect(clipExtension('audio/webm;codecs=opus')).toBe('webm')
    expect(clipExtension('audio/mp4')).toBe('m4a')
    expect(clipExtension('audio/ogg')).toBe('ogg')
  })
  it('reports recording unsupported without device APIs', () => {
    vi.stubGlobal('navigator', undefined)
    expect(recordingSupported()).toBe(false)
    vi.unstubAllGlobals()
  })
  it('prefers Opus in WebM when the browser can encode it', () => {
    vi.stubGlobal('MediaRecorder', { isTypeSupported: (mime: string) => mime === 'audio/webm;codecs=opus' })
    expect(pickRecorderMime()).toBe('audio/webm;codecs=opus')
    vi.unstubAllGlobals()
  })
})
