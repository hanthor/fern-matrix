import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { MatrixEngine } from '../../src/sdk/engine'
import type { Account, Room, Message } from '../../src/types'

interface FixtureUser { username: string; password: string; userId: string; token: string }
interface Fixture { base: string; version: string; users: FixtureUser[] }
declare global {
  interface Window {
    matrixTest: { engine: MatrixEngine; accounts: Record<string, Account>; rooms: Record<string, Room[]>;
      messages: Record<string, Message[]>; typing: Record<string, string[]>; errors: string[]; stops: (() => void)[];
      verification: { status: string; emojis?: { symbol: string; description: string }[]; numbers?: number[] }[] }
  }
}
const fixture: Fixture = JSON.parse(readFileSync(process.env.FERN_MATRIX_FIXTURE!, 'utf8'))
const [alice, , reference] = fixture.users

class NioPeer {
  private child: ChildProcessWithoutNullStreams
  private nextId = 0
  private pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>()
  private closed: Promise<void>
  constructor() {
    this.child = spawn(process.env.FERN_SYNAPSE_PYTHON ?? 'python3', ['tests/integration/nio_peer.py'], { stdio: 'pipe' })
    this.child.stderr.resume()
    const lines = createInterface({ input: this.child.stdout })
    lines.on('line', line => {
      let response: { id?: string; error?: string } & Record<string, unknown>
      try { response = JSON.parse(line) }
      catch { return }
      if (!response.id) return
      const pending = this.pending.get(response.id)
      if (!pending) return
      this.pending.delete(response.id)
      if (response.error) pending.reject(new Error(response.error))
      else pending.resolve(response)
    })
    this.closed = new Promise(resolve => this.child.once('close', () => resolve()))
    this.child.once('error', error => {
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
    })
    this.child.once('close', code => {
      if (code === 0) return
      for (const pending of this.pending.values()) pending.reject(new Error('Independent Matrix test client stopped unexpectedly.'))
      this.pending.clear()
    })
  }
  command(action: string, values: Record<string, unknown> = {}, timeoutMs = 45_000) {
    const id = String(++this.nextId)
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Independent Matrix test client timed out.'))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: value => { clearTimeout(timeout); resolve(value) },
        reject: error => { clearTimeout(timeout); reject(error) },
      })
      this.child.stdin.write(JSON.stringify({ id, action, ...values }) + '\n')
    })
  }
  async stop() {
    try { await this.command('stop') } finally { await this.closed }
  }
}

async function boot(page: Page) {
  await page.goto('http://127.0.0.1:5173/tests/integration/client.html')
  await page.evaluate(async () => {
    // @ts-expect-error This path is resolved by Vite in the browser.
    const { MatrixEngine } = await import('/src/sdk/engine.ts')
    const state = { engine: undefined as unknown as MatrixEngine,
      accounts: {}, rooms: {}, messages: {}, typing: {}, errors: [], stops: [], verification: [] } as Window['matrixTest']
    state.engine = new MatrixEngine({
      account: (account: Account) => { state.accounts[account.id] = account },
      rooms: (accountId: string, rooms: Room[]) => { state.rooms[accountId] = rooms },
      error: () => {},
    })
    window.matrixTest = state
  })
}
async function login(page: Page, user: FixtureUser) {
  return page.evaluate(({ base, username, password }) => window.matrixTest.engine.login(base, username, password),
    { base: fixture.base, username: user.username, password: user.password })
}
async function watch(page: Page, accountId: string, roomId: string) {
  await expect.poll(() => page.evaluate(({ accountId, roomId }) =>
    window.matrixTest.rooms[accountId]?.some(room => room.id === roomId && room.membership === 'joined') ?? false,
  { accountId, roomId })).toBe(true)
  await page.evaluate(async ({ accountId, roomId }) => {
    const state = window.matrixTest
    const key = accountId + '/' + roomId
    state.stops.push(await state.engine.watchRoom(accountId, roomId,
      messages => { state.messages[key] = messages }, () => {}))
  }, { accountId, roomId })
}
// Minimal mono 16-bit WAV of KNOWN_BYTES samples: recognized by every Matrix
// client as audio, trivially comparable byte-for-byte after decryption.
function wavBytes(samples: number[]): number[] {
  const header = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
    16, 0, 0, 0, 1, 0, 1, 0, 0x40, 0x1f, 0, 0, 0x80, 0x3e, 0, 0, 2, 0, 16, 0, 0x64, 0x61, 0x74, 0x61, 0, 0, 0, 0]
  const body: number[] = []
  for (const sample of samples) body.push(sample & 0xff, (sample >> 8) & 0xff)
  const size = 36 + body.length
  header[4] = size & 0xff; header[5] = (size >> 8) & 0xff; header[6] = (size >> 16) & 0xff; header[7] = (size >> 24) & 0xff
  header[40] = body.length & 0xff; header[41] = (body.length >> 8) & 0xff
  header[42] = (body.length >> 16) & 0xff; header[43] = (body.length >> 24) & 0xff
  return [...header, ...body]
}

test('encrypted voice messages interoperate with an independent client', async ({ page, request }) => {
  const nio = new NioPeer()
  let nioStarted = false
  try {
    await boot(page)
    const a = await login(page, alice)
    await nio.command('start', { homeserver: fixture.base, username: reference.username, password: reference.password })
    nioStarted = true
    const roomId = await page.evaluate(({ a, invite }) =>
      window.matrixTest.engine.createRoom(a, 'Voice fixture', 'encrypted voice interop', invite),
    { a, invite: reference.userId })
    await watch(page, a, roomId)
    await nio.command('join', { roomId })

    // Independent client -> Fern: real m.audio with MSC1767 waveform and the
    // MSC3245 voice flag must parse into a playable voice attachment.
    const nioWav = wavBytes([0, 1000, -1000, 3000, -3000])
    await nio.command('send_audio', { roomId, name: 'nio-voice.wav', bytes: nioWav,
      mime: 'audio/wav', duration: 1000, waveform: [0, 256, 512, 768, 1024] })
    await expect.poll(() => page.evaluate(({ a, roomId }) => window.matrixTest.messages[a + '/' + roomId]
      ?.some(message => message.kind === 'audio' && message.attachment?.name === 'nio-voice.wav') ?? false,
    { a, roomId })).toBe(true)
    const nioVoice = await page.evaluate(({ a, roomId }) => window.matrixTest.messages[a + '/' + roomId]!
      .find(message => message.attachment?.name === 'nio-voice.wav')!, { a, roomId })
    expect(nioVoice.attachment?.voice).toBe(true)
    expect(nioVoice.attachment?.duration).toBe(1000)
    expect(nioVoice.attachment?.waveform).toEqual([0, 0.25, 0.5, 0.75, 1])
    const nioDownloaded = await page.evaluate(async ({ a, roomId, message }) => {
      const url = await window.matrixTest.engine.download(a, roomId, message)
      return [...new Uint8Array(await (await fetch(url)).arrayBuffer())]
    }, { a, roomId, message: nioVoice })
    expect(nioDownloaded).toEqual(nioWav)

    // Fern -> independent client: the voice transport must arrive decrypted
    // with duration, waveform metadata and the voice flag intact.
    const fernWav = wavBytes([500, -500, 1500, -1500, 2500])
    await page.evaluate(({ a, roomId, bytes }) => window.matrixTest.engine.sendVoice(a, roomId,
      { bytes: new Uint8Array(bytes).buffer, filename: 'voice-message.wav', mime: 'audio/wav',
        durationMs: 1000, waveform: [0, 0.25, 0.5, 0.75, 1] }).then(operation => operation.done),
    { a, roomId, bytes: fernWav })
    const received = await nio.command('wait_audio', { roomId, name: 'voice-message.wav' })
    expect(received.decrypted).toBe(true)
    expect(received.msgtype).toBe('m.audio')
    expect(received.bytes).toBe(btoa(String.fromCharCode(...fernWav)))
    console.log('FERN VOICE WIRE: info=' + JSON.stringify(received.info) + ' audio=' + JSON.stringify(received.audioBlock) + ' voice=' + JSON.stringify(received.voiceFlag))
    expect(received.voiceFlag).toEqual({})
    const wireAudio = received.audioBlock as { duration?: number; waveform?: number[] }
    expect(wireAudio.duration).toBe(1000)
    expect(wireAudio.waveform).toEqual([0, 256, 512, 768, 1024])

    // The voice filename must never appear outside the ciphertext.
    const raw = await request.fetch(fixture.base + '/_matrix/client/v3' + `/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=20`,
      { headers: { Authorization: 'Bearer ' + alice.token } })
    expect(raw.status()).toBeLessThan(300)
    const chunk = (await raw.json() as { chunk: { type: string }[] }).chunk
    expect(chunk.some(event => event.type === 'm.room.encrypted')).toBe(true)
    expect(JSON.stringify(chunk)).not.toContain('voice-message.wav')
    await page.evaluate(a => window.matrixTest.engine.dispose(), a)
  } finally {
    if (nioStarted) await nio.stop()
  }
})
