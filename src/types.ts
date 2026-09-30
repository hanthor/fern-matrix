export type Connection = 'demo' | 'connecting' | 'online' | 'offline' | 'error'
export interface Account { id: string; name: string; userId: string; color: string; connection: Connection; error?: string }
export interface Room { id: string; accountId: string; name: string; topic: string; direct: boolean; space: boolean; encrypted: boolean; favorite: boolean; unread: number; mentions: number; members: number; preview: string; timestamp: number; membership: 'joined' | 'invited' | 'left'; parent?: string; parents?: string[]; successor?: string }
export interface Reaction { key: string; count: number; own: boolean }
export interface Message { id: string; sender: string; name: string; body: string; formattedBody?: string; threadRoot?: string; threadReplies?: number; timestamp: number; own: boolean; edited?: boolean; kind: 'text' | 'emote' | 'file' | 'image' | 'audio' | 'video' | 'location' | 'poll' | 'notice'; reactions: Reaction[]; replyId?: string; replyBody?: string; status?: 'sending' | 'failed'; shield?: { level: 'red' | 'grey'; message?: string }; attachment?: { name: string; size: number; mime: string; url?: string; duration?: number; waveform?: number[]; voice?: boolean }; poll?: { question: string; answers: { id: string; text: string; count: number }[]; voted?: string; kind: 'disclosed' | 'undisclosed'; ended: boolean; edited: boolean }; location?: { lat: number; lon: number; uncertainty?: number; description?: string; zoom?: number }; read?: number }
export interface Member { id: string; name: string; role: string; membership: string }
export interface SpaceChild { id: string; name: string; topic: string; space: boolean; members: number; children: number; membership: string; via: string[] }
export type VectorDiff<T> = { tag: string; inner?: { index?: number; value?: T; values?: T[]; length?: number } }

export interface DirectoryRoom { id: string; name: string; topic: string; members: number; alias?: string; knockable?: boolean }
