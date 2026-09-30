// Knock request moderation (#41). Knockers appear as m.room.member events
// with membership 'knock'; this module parses the server-authoritative member
// list and stays DOM-free for unit testing. Accepting invites the knocker,
// declining kicks the knocking membership, mirroring the SDK actions.

export interface KnockRequest {
  userId: string
  reason?: string
}

/** Parse a /members?membership=knock response into knock requests. */
export function parseKnockRequests(body: unknown): KnockRequest[] {
  const chunk = (body as { chunk?: unknown })?.chunk
  if (!Array.isArray(chunk)) return []
  const requests: KnockRequest[] = []
  for (const event of chunk) {
    const record = event as { state_key?: unknown; sender?: unknown; content?: { reason?: unknown } | null }
    const userId = typeof record.state_key === 'string' && record.state_key
      ? record.state_key
      : typeof record.sender === 'string' ? record.sender : ''
    if (!userId) continue
    const reason = typeof record.content?.reason === 'string' && record.content.reason.trim()
      ? record.content.reason.trim()
      : undefined
    requests.push(reason ? { userId, reason } : { userId })
  }
  return requests
}
