import { describe, expect, it } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import CallView, { type CallStatus } from '../src/components/CallView.vue'

// Call re-skin (#46): Fern owns the lobby/header/loading/error/ended chrome
// around the Element Call widget. SSR covers every owned state plus the
// widget iframe guard rails (title, allow list, sandbox); the live bridge and
// lobby interactions ride the browser suite.
async function render(status: CallStatus, extra: Record<string, unknown> = {}) {
  const app = createSSRApp({
    render: () => h(CallView, { roomName: 'General', direct: false, encrypted: true, status, ...extra }),
  })
  return renderToString(app)
}

describe('CallView call chrome', () => {
  it('lobbies with the room identity and a join action', async () => {
    const html = await render('lobby')
    expect(html).toContain('Call with General')
    expect(html).toContain('Encrypted call')
    expect(html).toContain('Join call')
    expect(html).toContain('Not now')
  })

  it('marks unencrypted rooms without the encrypted label', async () => {
    const html = await render('lobby', { encrypted: false })
    expect(html).not.toContain('Encrypted call')
  })

  it('shows joining with a cancel action', async () => {
    const html = await render('joining')
    expect(html).toContain('Joining the call')
    expect(html).toContain('Cancel')
  })

  it('shows failures with the engine message and a retry action', async () => {
    const html = await render('error', { error: 'This homeserver does not advertise MatrixRTC support.' })
    expect(html).toContain('This homeserver does not advertise MatrixRTC support.')
    expect(html).toContain('Try again')
  })

  it('shows the ended state with a rejoin action', async () => {
    const html = await render('ended')
    expect(html).toContain('Call ended')
    expect(html).toContain('Rejoin')
  })

  it('keeps the widget iframe guard rails in every state', async () => {
    for (const status of ['lobby', 'joining', 'active', 'error', 'ended'] as const) {
      const html = await render(status)
      expect(html).toContain('title="Element Call"')
      expect(html).toContain('allow="camera; microphone; display-capture; autoplay; encrypted-media"')
      expect(html).toContain('sandbox="allow-scripts allow-same-origin allow-forms allow-popups"')
    }
  })

  it('always offers leaving the call', async () => {
    for (const status of ['lobby', 'joining', 'active', 'error', 'ended'] as const) {
      expect(await render(status)).toContain('Leave call')
    }
  })
})
