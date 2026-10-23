import { reactive } from 'vue'

export type ExitOutcome =
  | { status: 'complete' | 'restart-required'; serverRevoked?: boolean }
  | { status: 'error'; cleanupStarted: boolean }
export type SessionExitMode = 'signout' | 'remove'
export type RecoveryState = 'Unknown' | 'Enabled' | 'Disabled' | 'Incomplete'
export interface ExitRecoveryStatus {
  recovery: RecoveryState
  backupExists: boolean | 'unknown'
  lastDevice: boolean | 'unknown'
}
export interface ExitTarget { id: string; userId: string; name: string; mode: SessionExitMode }
export interface SessionExitState {
  target: ExitTarget | null
  outcome: ExitOutcome | null
  status: ExitRecoveryStatus
  checking: boolean
  busy: boolean
  acknowledged: boolean
  error: '' | 'failed' | 'missing'
}
export function unknownExitRecovery(): ExitRecoveryStatus {
  return { recovery: 'Unknown', backupExists: 'unknown', lastDevice: 'unknown' }
}
export function canResetRecovery(recovery: string | undefined): boolean {
  return recovery === 'Enabled' || recovery === 'Incomplete'
}

interface ExitDependencies {
  locked?: () => boolean
  exists: (id: string) => boolean
  inspect: (id: string, signal: AbortSignal) => Promise<ExitRecoveryStatus>
  execute: (target: ExitTarget) => Promise<ExitOutcome>
  retry: (id: string) => Promise<ExitOutcome>
}
// One immutable session target per confirmation. Status reads are advisory:
// even Enabled does not prove that the user has saved a working recovery key.
export function createSessionExit(deps: ExitDependencies, timeoutMs = 5000) {
  const state = reactive<SessionExitState>({
    target: null, outcome: null, status: unknownExitRecovery(), checking: false,
    busy: false, acknowledged: false, error: '',
  })
  let generation = 0
  let controller: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  function stopCheck() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    controller?.abort()
    controller = undefined
  }
  function close() {
    ++generation
    stopCheck()
    state.target = null
    state.outcome = null
    state.checking = false
    state.acknowledged = false
    state.error = ''
  }
  function request(target: ExitTarget): boolean {
    if (deps.locked?.() || state.busy || !deps.exists(target.id)) return false
    close()
    state.target = Object.freeze({ ...target })
    state.status = unknownExitRecovery()
    state.checking = true
    const current = generation
    controller = new AbortController()
    const signal = controller.signal
    const finish = (status: ExitRecoveryStatus) => {
      if (current !== generation || !state.target) return
      state.status = status
      state.checking = false
      stopCheck()
    }
    // A broken/offline SDK request must never hold the dialog indefinitely.
    timer = setTimeout(() => finish(unknownExitRecovery()), timeoutMs)
    void Promise.resolve().then(() => deps.inspect(target.id, signal))
      .then(status => { if (!signal.aborted) finish(status) })
      .catch(() => { if (!signal.aborted) finish(unknownExitRecovery()) })
    return true
  }
  function cancel(): boolean {
    if (state.busy) return false
    close()
    return true
  }
  function review(): ExitTarget | null {
    const target = state.target
    if (deps.locked?.() || state.busy || state.outcome || !target) return null
    if (!deps.exists(target.id)) { state.error = 'missing'; return null }
    close()
    return target
  }
  async function confirm(): Promise<boolean> {
    const target = state.target
    if (deps.locked?.() || !target || state.busy || state.checking || !state.acknowledged || state.outcome) return false
    if (!deps.exists(target.id)) { state.error = 'missing'; state.acknowledged = false; return false }
    state.busy = true
    state.error = ''
    try {
      return applyOutcome(await deps.execute({ ...target }))
    } catch {
      state.outcome = { status: 'error', cleanupStarted: true }
      return false
    } finally { state.busy = false }
  }
  function applyOutcome(outcome: ExitOutcome): boolean {
    if (outcome.status === 'complete') { close(); return true }
    if (outcome.status === 'restart-required' || (outcome.status === 'error' && outcome.cleanupStarted)) state.outcome = outcome
    else state.error = 'failed'
    return false
  }
  async function retry(): Promise<boolean> {
    const target = state.target
    if (deps.locked?.() || !target || state.busy || state.outcome?.status !== 'error') return false
    state.busy = true
    try { return applyOutcome(await deps.retry(target.id)) }
    catch { state.outcome = { status: 'error', cleanupStarted: true }; return false }
    finally { state.busy = false }
  }
  return { state, request, cancel, review, confirm, retry, dispose: close }
}
