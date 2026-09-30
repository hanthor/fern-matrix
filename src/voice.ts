// Voice message recording for issue #17. Wraps MediaRecorder plus a live
// analyser so the composer can preview duration and an MSC1767-style
// waveform before sending through the encrypted voice transport.
export interface VoiceClip {
  blob: Blob
  mime: string
  durationMs: number
  waveform: number[]
  interrupted: boolean
}
export type VoiceFailure = 'unsupported' | 'denied' | 'no-microphone' | 'unavailable'
export class VoiceError extends Error {
  readonly code: VoiceFailure
  constructor(code: VoiceFailure, message: string) {
    super(message)
    this.code = code
  }
}
const RECORDER_PREFERENCE = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
// Browsers that can capture but have no encoder choice still record.
const RECORDER_FALLBACK = 'audio/webm'
export function recordingSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'
}
// First MIME type this browser can encode, so sends prefer Opus in WebM and
// degrade to whatever container the platform offers.
export function pickRecorderMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return undefined
  return RECORDER_PREFERENCE.find(mime => MediaRecorder.isTypeSupported(mime)) ?? RECORDER_FALLBACK
}
export function clipExtension(mime: string): string {
  if (mime.includes('mp4')) return 'm4a'
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('wav')) return 'wav'
  return 'webm'
}
// Collapse raw analyser levels into a fixed bar count, keeping peaks so quiet
// passages stay visible. Output is 0..1, rounded for stable snapshots.
export function normalizeWaveform(levels: number[], bars = 32): number[] {
  if (!levels.length || bars <= 0) return []
  const width = levels.length / bars
  return Array.from({ length: bars }, (_, index) => {
    const slice = levels.slice(Math.floor(index * width), Math.max(Math.floor((index + 1) * width), Math.floor(index * width) + 1))
    const peak = Math.max(0, ...slice)
    return Math.round(Math.min(1, peak) * 1000) / 1000
  })
}
export function formatVoiceDuration(durationMs: number): string {
  const total = Math.max(0, Math.round(durationMs / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
function failureOf(error: unknown): VoiceFailure {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return 'denied'
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') return 'no-microphone'
  }
  return 'unavailable'
}
export function voiceFailureMessage(code: VoiceFailure): string {
  if (code === 'denied') return 'Microphone access was denied. Allow microphone use in the browser site settings, then try again.'
  if (code === 'no-microphone') return 'No microphone was found. Connect a microphone and try again.'
  if (code === 'unsupported') return 'Voice recording is not supported in this browser. Try a recent Chrome, Edge, Firefox or Safari.'
  return 'Recording could not start. Check the microphone and try again.'
}
export interface VoiceRecorderEvents {
  onTick?: (elapsedMs: number) => void
  // Fires when the OS revokes the microphone mid-recording (call, device
  // removal). The recorder auto-stops and the partial clip stays sendable.
  onInterrupted?: () => void
}
const LEVEL_INTERVAL_MS = 100
const MAX_LEVELS = 3600
export class VoiceRecorder {
  private stream?: MediaStream
  private recorder?: MediaRecorder
  private analyser?: AnalyserNode
  private audioContext?: AudioContext
  private levelTimer?: ReturnType<typeof setInterval>
  private levels: number[] = []
  private chunks: Blob[] = []
  private startedAt = 0
  private pausedTotal = 0
  private pauseStartedAt?: number
  private mime = ''
  private interruptedFlag = false
  private stopped = false
  state: 'idle' | 'recording' | 'paused' = 'idle'
  constructor(private events: VoiceRecorderEvents = {}) {}
  async start(): Promise<void> {
    if (!recordingSupported()) throw new VoiceError('unsupported', voiceFailureMessage('unsupported'))
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch (error) {
      const code = failureOf(error)
      throw new VoiceError(code, voiceFailureMessage(code))
    }
    const mime = pickRecorderMime() ?? ''
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
    recorder.ondataavailable = event => { if (event.data.size) this.chunks.push(event.data) }
    const track = stream.getAudioTracks()[0]
    track?.addEventListener('ended', () => void this.autoStop())
    this.stream = stream
    this.recorder = recorder
    this.mime = recorder.mimeType || mime || 'audio/webm'
    this.chunks = []
    this.levels = []
    this.startedAt = performance.now()
    this.pausedTotal = 0
    this.pauseStartedAt = undefined
    this.interruptedFlag = false
    this.stopped = false
    this.watchLevels(stream)
    recorder.start(250)
    this.state = 'recording'
  }
  pause(): void {
    if (this.state !== 'recording' || !this.recorder) return
    this.recorder.pause()
    this.pauseStartedAt = performance.now()
    this.state = 'paused'
  }
  resume(): void {
    if (this.state !== 'paused' || !this.recorder) return
    this.recorder.resume()
    if (this.pauseStartedAt !== undefined) this.pausedTotal += performance.now() - this.pauseStartedAt
    this.pauseStartedAt = undefined
    this.state = 'recording'
  }
  elapsedMs(now = performance.now()): number {
    if (!this.startedAt) return 0
    const frozen = this.state === 'paused' && this.pauseStartedAt !== undefined ? this.pauseStartedAt : now
    return Math.max(0, frozen - this.startedAt - this.pausedTotal)
  }
  get interrupted(): boolean { return this.interruptedFlag }
  async stop(): Promise<VoiceClip> {
    if (!this.recorder || this.stopped) throw new VoiceError('unavailable', 'There is no recording to finish.')
    this.stopped = true
    const done = new Promise<void>((resolve, reject) => {
      this.recorder!.onstop = () => resolve()
      this.recorder!.onerror = () => reject(new VoiceError('unavailable', voiceFailureMessage('unavailable')))
    })
    if (this.state === 'paused') this.recorder.resume()
    this.recorder.stop()
    await done
    return this.finish()
  }
  cancel(): void {
    if (!this.recorder || this.stopped) { this.cleanup(); return }
    this.stopped = true
    try { this.recorder.onstop = null; this.recorder.stop() } catch { /* discard partial data */ }
    this.chunks = []
    this.cleanup()
    this.state = 'idle'
  }
  private async autoStop(): Promise<void> {
    if (this.stopped || this.state === 'idle') return
    this.interruptedFlag = true
    try { await this.stop() } catch { this.cleanup(); return }
    this.events.onInterrupted?.()
  }
  private finish(): VoiceClip {
    const durationMs = this.elapsedMs()
    const clip: VoiceClip = {
      blob: new Blob(this.chunks, { type: this.mime }),
      mime: this.mime,
      durationMs,
      waveform: normalizeWaveform(this.levels),
      interrupted: this.interruptedFlag,
    }
    this.chunks = []
    this.cleanup()
    this.state = 'idle'
    return clip
  }
  private watchLevels(stream: MediaStream): void {
    try {
      const context = new AudioContext()
      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      this.audioContext = context
      this.analyser = analyser
      const samples = new Float32Array(analyser.fftSize)
      this.levelTimer = setInterval(() => {
        if (this.state !== 'recording' || !this.analyser) return
        this.analyser.getFloatTimeDomainData(samples)
        let peak = 0
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
        if (this.levels.length < MAX_LEVELS) this.levels.push(Math.min(1, peak * 2))
        this.events.onTick?.(this.elapsedMs())
      }, LEVEL_INTERVAL_MS)
    } catch {
      // Waveform is decorative: recording continues with duration only.
      this.levelTimer = setInterval(() => { this.events.onTick?.(this.elapsedMs()) }, 500)
    }
  }
  private cleanup(): void {
    if (this.levelTimer) clearInterval(this.levelTimer)
    this.levelTimer = undefined
    this.stream?.getTracks().forEach(track => track.stop())
    this.stream = undefined
    void this.audioContext?.close().catch(() => {})
    this.audioContext = undefined
    this.analyser = undefined
    this.recorder = undefined
  }
}
