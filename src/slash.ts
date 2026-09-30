// Slash commands typed in the composer (/me, /topic, /name, /invite,
// /join, /leave). Parsing stays UI-free so unit tests cover it without WASM.

export type SlashCommand =
  | { name: 'literal'; text: string }
  | { name: 'me'; text: string }
  | { name: 'topic'; text: string }
  | { name: 'name'; text: string }
  | { name: 'invite'; userId: string }
  | { name: 'join'; target: string }
  | { name: 'leave' }
  | { name: 'unknown'; command: string }

export const SLASH_USAGE: Record<string, string> = {
  me: '/me <action>',
  topic: '/topic <topic>',
  name: '/name <room name>',
  invite: '/invite <@user:server>',
  join: '/join <#alias:server or !room:server>',
  leave: '/leave',
}

function fail(command: string): SlashCommand {
  return { name: 'unknown', command: `Usage: ${SLASH_USAGE[command] ?? `/${command}`}` }
}

export function parseSlashCommand(body: string): SlashCommand | null {
  if (!body.startsWith('/')) return null
  // `//text` escapes to a literal `/text` message, matching Element.
  if (body.startsWith('//')) return { name: 'literal', text: body.slice(1) }
  const space = body.indexOf(' ')
  const command = (space === -1 ? body.slice(1) : body.slice(1, space)).toLowerCase()
  const arg = space === -1 ? '' : body.slice(space + 1).trim()
  switch (command) {
    case 'me': return arg ? { name: 'me', text: arg } : fail('me')
    case 'topic': return { name: 'topic', text: arg }
    case 'name': return arg ? { name: 'name', text: arg } : fail('name')
    case 'invite':
      if (!arg || !arg.startsWith('@') || !arg.includes(':')) return fail('invite')
      return { name: 'invite', userId: arg.split(/\s/)[0] }
    case 'join': return arg ? { name: 'join', target: arg.split(/\s/)[0] } : fail('join')
    case 'leave':
    case 'part': return { name: 'leave' }
    default: return { name: 'unknown', command: `Unknown command /${command}. Try /me, /topic, /name, /invite, /join or /leave.` }
  }
}
