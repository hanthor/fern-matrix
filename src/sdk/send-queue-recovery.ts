import type { RoomSendQueueUpdate } from './generated/matrix_sdk_ffi'

export type QueueReachability = 'authenticated' | 'unavailable' | 'unauthorized'

// A public /versions response is not sufficient to resume authenticated sends.
// Reject redirects and malformed/wrong-user responses; never return response
// bodies or credentials to diagnostics.
export async function probeQueueRecovery(
  session: { homeserverUrl: string; accessToken: string; userId: string },
  signal: AbortSignal,
): Promise<QueueReachability> {
  if (signal.aborted) return 'unavailable'
  try {
    const response = await fetch(session.homeserverUrl.replace(/\/+$/, '') + '/_matrix/client/v3/account/whoami', {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      cache: 'no-store', redirect: 'error', credentials: 'omit', signal,
    })
    if (signal.aborted) return 'unavailable'
    if (response.status === 401 || response.status === 403) return 'unauthorized'
    if (response.status !== 200) return 'unavailable'
    const body = await response.json()
    if (signal.aborted) return 'unavailable'
    return body?.user_id === session.userId ? 'authenticated' : 'unavailable'
  } catch { return 'unavailable' }
}

interface Failure { recoverable: boolean }

// This policy never resends content or unwedges permanent errors. It only
// re-enables SDK room queues whose observed failures were all recoverable,
// after a successful authenticated probe. The SDK retains transaction IDs.
export class SendQueueRecovery {
  private failures = new Map<string, Map<string, Failure>>()
  private stopped = false
  private running: Promise<QueueReachability | undefined> | undefined

  update(roomId: string, update: RoomSendQueueUpdate) {
    if (this.stopped) return
    if (update.tag === 'SendError') {
      let room = this.failures.get(roomId)
      if (!room) this.failures.set(roomId, room = new Map())
      room.set(update.inner.transactionId, { recoverable: update.inner.isRecoverable })
    } else if (update.tag === 'SentEvent' || update.tag === 'CancelledLocalEvent' || update.tag === 'RetryEvent') {
      const room = this.failures.get(roomId)
      room?.delete(update.inner.transactionId)
      if (room?.size === 0) this.failures.delete(roomId)
    }
  }

  recover(
    probe: () => Promise<QueueReachability>,
    resumeRoom: (roomId: string) => void,
    current: () => boolean,
  ): Promise<QueueReachability | undefined> {
    if (this.running) return this.running
    if (this.stopped || !current()) return Promise.resolve()
    const candidates = [...this.failures].filter(([, room]) =>
      room.size > 0 && [...room.values()].every(failure => failure.recoverable),
    ).map(([roomId, room]) => [roomId, new Map(room)] as const)
    if (candidates.length === 0) return Promise.resolve()
    const attempt = async (): Promise<QueueReachability | undefined> => {
      let result: QueueReachability
      try { result = await probe() } catch { return 'unavailable' }
      if (this.stopped || !current()) return
      if (result === 'unauthorized') { this.stop(); return result }
      if (result !== 'authenticated') return result
      let resumeFailed = false
      for (const [roomId, snapshot] of candidates) {
        if (this.stopped || !current()) return
        const room = this.failures.get(roomId)
        // A cancellation, manual retry, or newer failure during the probe
        // invalidates this room's permission to resume.
        if (!room || room.size !== snapshot.size
          || [...snapshot].some(([id, failure]) => room.get(id) !== failure)) continue
        try { resumeRoom(roomId) } catch { resumeFailed = true; continue }
        // A synchronous callback may already have reported a new failure.
        for (const [id, failure] of snapshot) if (room.get(id) === failure) room.delete(id)
        if (room.size === 0 && this.failures.get(roomId) === room) this.failures.delete(roomId)
      }
      return resumeFailed ? 'unavailable' : 'authenticated'
    }
    this.running = attempt().finally(() => { this.running = undefined })
    return this.running
  }

  stop() {
    this.stopped = true
    this.failures.clear()
  }
}
