import { describe, expect, it } from 'vitest'
import { MatrixEngine } from '../src/sdk/engine'
import type {
  SessionVerificationControllerDelegate,
  SessionVerificationControllerInterface,
  SessionVerificationRequestDetails,
} from '../src/sdk/generated/matrix_sdk_ffi'

interface Update { status: string; deviceName?: string }

// The Rust SDK reports a timed-out verification request as
// VerificationRequestState::Cancelled (cancel code m.timeout), which the FFI
// controller forwards as didCancel(). Waiting out the real 10-minute
// VERIFICATION_TIMEOUT is infeasible in CI, so these tests drive the exact
// delegate signal the SDK emits on timeout through a stub controller.
function stubController() {
  let delegate: SessionVerificationControllerDelegate | undefined
  const calls: string[] = []
  const controller = {
    setDelegate(value: SessionVerificationControllerDelegate | undefined) { delegate = value },
    acknowledgeVerificationRequest: async () => { calls.push('acknowledge') },
    acceptVerificationRequest: async () => { calls.push('accept') },
    cancelVerification: async () => { calls.push('cancel') },
  } as unknown as SessionVerificationControllerInterface
  return { calls, controller, delegate: () => delegate as SessionVerificationControllerDelegate }
}

function testEngine() {
  return new MatrixEngine({ account() {}, rooms() {}, error() {} })
}

async function flush() {
  await new Promise(resolve => setTimeout(resolve, 0))
}

const details = {
  senderProfile: { userId: '@alice:example', displayName: 'Alice' },
  flowId: 'timeout-flow',
  deviceId: 'OTHERDEVICE',
  deviceDisplayName: 'Other device',
} as unknown as SessionVerificationRequestDetails

describe('verification timeout signal handling', () => {
  it('maps the SDK timeout cancel to a terminal canceled status and clears state', async () => {
    const engine = testEngine()
    const updates: Update[] = []
    const stub = stubController()
    // verificationDelegate is private; the stub replaces the SDK controller.
    ;(engine as unknown as { verificationDelegate(
      accountId: string, controller: SessionVerificationControllerInterface,
      update: (value: Update) => void): void }).verificationDelegate('a', stub.controller, value => updates.push(value))
    stub.delegate().didReceiveVerificationRequest(details)
    expect(updates).toEqual([{ status: 'incoming', deviceName: 'Other device' }])
    stub.delegate().didCancel()
    await flush()
    expect(updates.at(-1)).toEqual({ status: 'canceled' })
    // A timed-out request must not linger: accepting afterwards reports no
    // pending request instead of acting on stale state.
    await expect(engine.acceptVerificationRequest('a')).rejects.toThrow('no pending verification request')
    // A fresh request can start on the same account after the timeout.
    const retry = stubController()
    const retryUpdates: Update[] = []
    ;(engine as unknown as { verificationDelegate(
      accountId: string, controller: SessionVerificationControllerInterface,
      update: (value: Update) => void): void }).verificationDelegate('a', retry.controller, value => retryUpdates.push(value))
    retry.delegate().didReceiveVerificationRequest(details)
    expect(retryUpdates).toEqual([{ status: 'incoming', deviceName: 'Other device' }])
  })

  it('maps SDK verification failure to a terminal failed status and clears state', async () => {
    const engine = testEngine()
    const updates: Update[] = []
    const stub = stubController()
    ;(engine as unknown as { verificationDelegate(
      accountId: string, controller: SessionVerificationControllerInterface,
      update: (value: Update) => void): void }).verificationDelegate('a', stub.controller, value => updates.push(value))
    stub.delegate().didFail()
    await flush()
    expect(updates).toEqual([{ status: 'failed' }])
    await expect(engine.acceptVerificationRequest('a')).rejects.toThrow('no pending verification request')
  })

  it('cancelling a pending request acknowledges it, cancels and clears state', async () => {
    const engine = testEngine()
    const stub = stubController()
    ;(engine as unknown as { verificationDelegate(
      accountId: string, controller: SessionVerificationControllerInterface,
      update: (value: Update) => void): void }).verificationDelegate('a', stub.controller, () => {})
    stub.delegate().didReceiveVerificationRequest(details)
    await engine.cancelVerification('a')
    expect(stub.calls).toEqual(['acknowledge', 'cancel'])
    // A second cancel is a no-op once the controller is cleared.
    await engine.cancelVerification('a')
    expect(stub.calls).toEqual(['acknowledge', 'cancel'])
  })
})
