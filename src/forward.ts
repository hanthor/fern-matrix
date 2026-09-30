// Message forwarding rules for issue #36. Forwarding re-sends content as the
// forwarder into an explicitly chosen room: it never moves ciphertext, never
// touches another account's rooms implicitly, and refuses content that cannot
// be faithfully reproduced (polls, notices, undecryptable or removed events,
// anything not yet sent).
import type { Message } from './types'
export function forwardBlockReason(message: Message): string | undefined {
  // Live send echoes carry transaction ids with a send status; anything with
  // a status that is not a server event is still in flight. Local-only demo
  // messages have neither a server id nor a status and are forwardable.
  if (message.status === 'sending' || message.status === 'failed'
    || (!message.id.startsWith('$') && message.status !== undefined)) {
    return 'Only sent messages can be forwarded. Wait for the send to finish first.'
  }
  if (message.kind === 'poll') return 'Polls cannot be forwarded. Create a new poll in the target room instead.'
  if (message.kind === 'notice') return 'This message cannot be forwarded because it was removed, could not be decrypted, or is a room notice.'
  if (message.kind === 'location' && !message.location) return 'This location cannot be forwarded.'
  if ((message.kind === 'file' || message.kind === 'image' || message.kind === 'video' || message.kind === 'audio') && !message.attachment) {
    return 'This attachment has not finished syncing yet.'
  }
  return undefined
}
// One-line preview for the forward dialog: never the full body.
export function forwardPreview(message: Message): string {
  if (message.kind === 'location' && message.location) return `Location ${message.location.lat}, ${message.location.lon}`
  if (message.attachment) return message.attachment.name
  if (message.kind === 'poll' && message.poll) return message.poll.question
  return message.body.length > 90 ? message.body.slice(0, 90) + '…' : message.body
}
