// Room widget discovery and classification (#45). State events come from the
// server-authoritative room state (m.widget and im.vector.modular.widgets);
// this module stays DOM-free for unit testing. Fern grants widgets exactly:
// the room timeline events matching their event filter, its own widget ID,
// and nothing else (no account data, no other rooms, no device keys).

export const WIDGET_STATE_TYPES = ['m.widget', 'im.vector.modular.widgets'] as const

export type WidgetKind = 'element_call' | 'jitsi' | 'unknown'

export interface WidgetInfo {
  id: string
  kind: WidgetKind
  name: string
  url: string
  type: string
  sender: string
}

interface WidgetEventContent {
  type?: unknown
  name?: unknown
  url?: unknown
}

/**
 * Parse one widget state event into a WidgetInfo, or undefined when the event
 * carries no usable widget (missing URL or ID). Unknown types are kept with
 * kind 'unknown' so the UI can refuse them with an actionable message.
 */
export function parseWidgetEvent(stateKey: string, sender: string, content: WidgetEventContent): WidgetInfo | undefined {
  const rawUrl = typeof content.url === 'string' ? content.url.trim() : ''
  const id = stateKey.trim()
  if (!rawUrl || !id) return undefined
  const type = typeof content.type === 'string' ? content.type : ''
  const name = typeof content.name === 'string' && content.name.trim() ? content.name.trim() : id
  return { id, kind: classifyWidget(type, rawUrl), name, url: rawUrl, type, sender }
}

function classifyWidget(type: string, url: string): WidgetKind {
  if (type === 'jitsi') return 'jitsi'
  if (type === 'm.room.call' || type === 'io.element.call') return 'element_call'
  let host = ''
  try { host = new URL(url).hostname.toLowerCase() } catch { return 'unknown' }
  if (host === 'call.element.io' || host.endsWith('.element.call') || host.includes('element-call')) return 'element_call'
  if (type.startsWith('m.') || type.startsWith('io.element.') || type.startsWith('im.vector.')) return 'unknown'
  return 'unknown'
}

/** Actionable refusal for widget kinds Fern does not support. */
export function unsupportedWidgetMessage(widget: WidgetInfo): string {
  return `“${widget.name}” is a “${widget.type || 'custom'}” widget, which Fern does not support. Fern opens Element Call and Jitsi widgets only.`
}

/**
 * Host-to-widget join request for a preloaded Element Call. With
 * `preload` the webview waits for this action instead of showing its own
 * lobby, so Fern's lobby stays the single prescreen (the Cinny arrangement:
 * EC as RTC engine, native chrome around it). The envelope follows the
 * standard widget transport (`api: 'toWidget'`).
 */
export interface CallJoinMessage {
  api: 'toWidget'
  action: 'io.element.join'
  widgetId: string
  requestId: string
  data: Record<string, never>
}

export function elementCallJoin(widgetId: string, requestId?: string): CallJoinMessage {
  return {
    api: 'toWidget',
    action: 'io.element.join',
    widgetId,
    requestId: requestId ?? (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `fern-${Date.now()}`),
    data: {},
  }
}

/** Widget-to-host echo Element Call posts once it has joined. */
export function isCallJoinedEcho(data: { action?: unknown } | null | undefined): boolean {
  return !!data && data.action === 'io.element.join'
}

/** Human capability summary shown on the approval screen. */
export function widgetCapabilitiesSummary(kind: WidgetKind): string {
  if (kind === 'element_call') return 'Sees room call events and its own participant media. Nothing else leaves this room.'
  return 'Sees the messages it needs to run in this room. No account data, other rooms or device keys.'
}
