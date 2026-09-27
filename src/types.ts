export type Connection = 'demo' | 'connecting' | 'online' | 'offline' | 'error'
export interface Account { id: string; name: string; userId: string; color: string; connection: Connection; error?: string }
export interface Room { id: string; accountId: string; name: string; topic: string; direct: boolean; space: boolean; encrypted: boolean; favorite: boolean; unread: number; mentions: number; members: number; preview: string; timestamp: number; membership: 'joined' | 'invited' | 'left'; parent?: string; parents?: string[] }
export interface Reaction { key: string; count: number; own: boolean }
export interface Message { id: string; sender: string; name: string; body: string; timestamp: number; own: boolean; edited?: boolean; kind: 'text' | 'file' | 'image' | 'audio' | 'video' | 'poll' | 'notice'; reactions: Reaction[]; replyId?: string; replyBody?: string; status?: 'sending' | 'failed'; attachment?: { name: string; size: number; mime: string; url?: string }; poll?: { question: string; answers: { id: string; text: string; count: number }[]; voted?: string }; read?: number }
export interface Member { id: string; name: string; role: string }
export type VectorDiff<T> = { tag: string; inner?: { index?: number; value?: T; values?: T[]; length?: number } }

export interface DirectoryRoom { id: string; name: string; topic: string; members: number; alias?: string }
