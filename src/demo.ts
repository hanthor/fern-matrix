import type { Account, Room, Message, Member } from './types'
export const demoAccounts: Account[] = [
  { id: 'demo-home', name: 'Alex Morgan', userId: '@alex:matrix.org', color: '#477962', connection: 'demo' },
  { id: 'demo-work', name: 'Alex · Work', userId: '@alex:studio.example', color: '#7973aa', connection: 'demo' },
]
const now = Date.now()
const room = (id: string, name: string, props: Partial<Room> = {}): Room => ({ id, name, accountId: 'demo-home', topic: '', direct: false, space: false, encrypted: true, favorite: false, unread: 0, mentions: 0, members: 12, preview: '', timestamp: now, membership: 'joined', ...props })
export const demoRooms: Room[] = [
  room('space-studio', 'Design studio', { space: true, members: 24 }),
  room('general', 'General', { parent: 'space-studio', favorite: true, members: 24, topic: 'A little bit of work. A little bit of everything else.', preview: 'Maya: Small details, big difference 🌿' }),
  room('design', 'Design', { parent: 'space-studio', unread: 3, preview: 'Leo: The new explorations are ready', members: 16, timestamp: now - 120000 }),
  room('development', 'Development', { parent: 'space-studio', unread: 2, mentions: 1, preview: 'Sam: @alex could you take a look?', members: 10, timestamp: now - 360000 }),
  room('random', 'Off topic', { parent: 'space-studio', preview: 'Nora: A very good weekend read', members: 24, timestamp: now - 780000 }),
  room('maya', 'Maya Chen', { direct: true, favorite: true, members: 2, preview: 'Thanks! See you tomorrow ☀️', timestamp: now - 1500000 }),
  room('leo', 'Leo Park', { direct: true, unread: 1, members: 2, preview: 'Have a minute to chat?', timestamp: now - 2200000 }),
  room('nora', 'Nora Williams', { direct: true, members: 2, preview: 'You: That looks lovely', timestamp: now - 7200000 }),
  room('community', 'Frappe community', { encrypted: false, members: 148, preview: 'Welcome to the community!', timestamp: now - 9000000, topic: 'Open tools. Thoughtful people.' }),
  room('invite', 'Weekend walkers', { membership: 'invited', members: 8, preview: 'Maya invited you', timestamp: now - 12000000 }),
  room('work-general', 'Team lounge', { accountId: 'demo-work', members: 9, preview: 'A new home for our team', favorite: true, topic: 'Keep the good ideas coming.' }),
  room('work-product', 'Product', { accountId: 'demo-work', members: 7, unread: 4, preview: 'Release notes are ready' }),
]
const msg = (id: string, sender: string, name: string, body: string, offset: number, props: Partial<Message> = {}): Message => ({ id, sender, name, body, timestamp: now - offset * 60000, own: sender === '@alex:matrix.org', kind: 'text', reactions: [], ...props })
export const demoMessages: Record<string, Message[]> = {
  general: [
    msg('m1', '@maya:matrix.org', 'Maya Chen', 'Good morning, everyone ☀️\nI’ve been thinking about how we can make our everyday tools feel a little more human.', 52),
    msg('m2', '@leo:matrix.org', 'Leo Park', 'Less noise, more room to think. I’m very much here for that.', 50, { reactions: [{ key: '💚', count: 3, own: false }], threadReplies: 2 }),
    msg('m2r1', '@maya:matrix.org', 'Maya Chen', 'Could not agree more — fewer pings, deeper work.', 49, { threadRoot: 'm2' }),
    msg('m2r2', '@nora:matrix.org', 'Nora Williams', 'Adding this to the principles doc.', 48, { threadRoot: 'm2' }),
    msg('m3', '@maya:matrix.org', 'Maya Chen', 'Exactly! Here’s a small moodboard for the next chapter. Warm neutrals, natural textures, and a bit of breathing room.', 47),
    msg('m4', '@maya:matrix.org', 'Maya Chen', 'A quieter kind of workspace', 47, { kind: 'image', attachment: { name: 'A quieter kind of workspace', size: 240000, mime: 'image/svg+xml', url: `${import.meta.env.BASE_URL}moodboard.svg` }, reactions: [{ key: '✨', count: 4, own: true }, { key: '🌿', count: 2, own: false }] }),
    msg('m5', '@alex:matrix.org', 'Alex Morgan', 'Love this direction. The best interface is one that gives the conversation space to breathe.', 40, { read: 3 }),
    msg('m6', '@nora:matrix.org', 'Nora Williams', 'Put together a few notes from our last conversation, too.', 28, { kind: 'file', attachment: { name: 'Design principles.md', size: 2840, mime: 'text/markdown', url: `${import.meta.env.BASE_URL}design-principles.md` } }),
    msg('m7', '@leo:matrix.org', 'Leo Park', 'Shall we try this out in the next iteration?', 19, { kind: 'poll', poll: { question: 'What should we explore first?', answers: [{ id: 'a', text: 'A calmer workspace', count: 7 }, { id: 'b', text: 'Better mobile conversations', count: 4 }, { id: 'c', text: 'All the little details', count: 3 }], kind: 'disclosed', ended: false, edited: false } }),
    msg('m8', '@maya:matrix.org', 'Maya Chen', 'Small details, big difference 🌿', 2),
  ],
  maya: [msg('dm1', '@maya:matrix.org', 'Maya Chen', 'Hey Alex! Thanks for the thoughtful feedback earlier.', 35), msg('dm2', '@alex:matrix.org', 'Alex Morgan', 'Of course. Excited to see where it goes!', 30), msg('dm3', '@maya:matrix.org', 'Maya Chen', 'Thanks! See you tomorrow ☀️', 25)],
}
export const demoMembers: Member[] = [{ id: '@maya:matrix.org', name: 'Maya Chen', role: 'Admin', membership: 'join' }, { id: '@alex:matrix.org', name: 'Alex Morgan', role: 'Member', membership: 'join' }, { id: '@leo:matrix.org', name: 'Leo Park', role: 'Member', membership: 'join' }, { id: '@nora:matrix.org', name: 'Nora Williams', role: 'Moderator', membership: 'join' }, { id: '@sam:matrix.org', name: 'Sam Rivera', role: 'Member', membership: 'join' }]
export function initialDemoMessages(room: Room): Message[] {
  return structuredClone(demoMessages[room.id] ?? [msg(`${room.id}-welcome`, '@maya:matrix.org', 'Maya Chen', `Welcome to ${room.name}. Make yourself at home.`, 60)])
}
