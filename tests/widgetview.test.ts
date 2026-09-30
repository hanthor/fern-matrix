import { describe, expect, it } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import WidgetView, { type WidgetStatus } from '../src/components/WidgetView.vue'
import type { WidgetInfo } from '../src/widgets'

// Widget chrome (#45): approval asks before any third-party load, supported
// kinds name their capabilities, unknown kinds are refused, and the frame
// keeps the sandbox guard rails in every state.
const jitsi: WidgetInfo = { id: 'standup', kind: 'jitsi', name: 'Team standup', url: 'https://meet.example.org/standup', type: 'jitsi', sender: '@maya:matrix.org' }
const unknown: WidgetInfo = { ...jitsi, id: 'board', kind: 'unknown', name: 'Sketch board', type: 'net.nordeck.whiteboard' }

async function render(widget: WidgetInfo, status: WidgetStatus, extra: Record<string, unknown> = {}) {
  const app = createSSRApp({ render: () => h(WidgetView, { widget, status, ...extra }) })
  return renderToString(app)
}

describe('WidgetView widget chrome', () => {
  it('asks approval with identity and capabilities before loading', async () => {
    const html = await render(jitsi, 'approval')
    expect(html).toContain('Open “Team standup”?')
    expect(html).toContain('Jitsi')
    expect(html).toContain('meet.example.org')
    expect(html).toContain('@maya:matrix.org')
    expect(html).toContain('No account data')
    expect(html).not.toContain('<iframe')
  })

  it('refuses unknown kinds with an actionable message and no approval', async () => {
    const html = await render(unknown, 'approval')
    expect(html).toContain('net.nordeck.whiteboard')
    expect(html).toContain('Element Call and Jitsi')
    expect(html).not.toContain('Approve and open')
    expect(html).not.toContain('<iframe')
  })

  it('shows loading, error and ended states', async () => {
    expect(await render(jitsi, 'loading')).toContain('Opening the widget')
    const error = await render(jitsi, 'error', { error: 'The widget could not start.' })
    expect(error).toContain('The widget could not start.')
    expect(error).toContain('Try again')
    const ended = await render(jitsi, 'ended')
    expect(ended).toContain('Widget closed')
    expect(ended).toContain('Reopen')
  })

  it('keeps the frame guard rails in every loaded state', async () => {
    for (const status of ['loading', 'active', 'error', 'ended'] as const) {
      const html = await render(jitsi, status)
      expect(html).toContain('title="Team standup"')
      expect(html).toContain('sandbox="allow-scripts allow-same-origin allow-forms allow-popups"')
    }
  })
})
