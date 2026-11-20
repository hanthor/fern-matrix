import { describe, expect, it, vi } from 'vitest'
import { MatrixEngine } from '../src/sdk/engine'

// Exercise the adapter without loading WASM or creating real server accounts.
vi.mock('../src/sdk/index', () => ({
  uniffiInitAsync: vi.fn(async () => {}),
  initPlatform: vi.fn(),
  LogLevel: { Warn: 0 },
  RecoveryState: ['Unknown', 'Enabled', 'Disabled', 'Incomplete'],
}))
function harness(recovery = 1) {
  const encryption = {
    recoveryState: () => recovery,
    backupExistsOnServer: vi.fn(async (_options: { signal: AbortSignal }) => true),
    isLastDevice: vi.fn(async (_options: { signal: AbortSignal }) => false),
    enableRecovery: vi.fn(), resetRecoveryKey: vi.fn(), resetIdentity: vi.fn(),
  }
  const engine = new MatrixEngine({ account() {}, rooms() {}, error() {} })
  ;(engine as unknown as { clients: Map<string, unknown> }).clients.set('a', { encryption: () => encryption })
  return { engine, encryption }
}
describe('read-only session exit status', () => {
  it('reports SDK states and forwards cancellation to both server reads', async () => {
    for (const [number, name] of ['Unknown', 'Enabled', 'Disabled', 'Incomplete'].entries()) {
      const { engine, encryption } = harness(number)
      const signal = new AbortController().signal
      expect(await engine.sessionExitStatus('a', signal)).toEqual({ recovery: name, backupExists: true, lastDevice: false })
      expect(encryption.backupExistsOnServer).toHaveBeenCalledWith({ signal })
      expect(encryption.isLastDevice).toHaveBeenCalledWith({ signal })
      expect(encryption.enableRecovery).not.toHaveBeenCalled()
      expect(encryption.resetRecoveryKey).not.toHaveBeenCalled()
      expect(encryption.resetIdentity).not.toHaveBeenCalled()
    }
  })
  it('preserves unknown for a failing device query instead of returning false', async () => {
    const { engine, encryption } = harness()
    encryption.isLastDevice.mockRejectedValue(new Error('offline'))
    expect(await engine.sessionExitStatus('a', new AbortController().signal))
      .toEqual({ recovery: 'Enabled', backupExists: true, lastDevice: 'unknown' })
  })
  it('preserves a known last-device warning when the backup query fails', async () => {
    const { engine, encryption } = harness(3)
    encryption.backupExistsOnServer.mockRejectedValue(new Error('offline'))
    encryption.isLastDevice.mockResolvedValue(true)
    expect(await engine.sessionExitStatus('a', new AbortController().signal))
      .toEqual({ recovery: 'Incomplete', backupExists: 'unknown', lastDevice: true })
  })
  it('does not start server checks after cancellation', async () => {
    const { engine, encryption } = harness()
    const abort = new AbortController(); abort.abort()
    expect(await engine.sessionExitStatus('a', abort.signal))
      .toEqual({ recovery: 'Unknown', backupExists: 'unknown', lastDevice: 'unknown' })
    expect(encryption.backupExistsOnServer).not.toHaveBeenCalled()
    expect(encryption.isLastDevice).not.toHaveBeenCalled()
  })
})
