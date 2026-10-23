import { describe, expect, it } from 'vitest'
import { backupMigrationUser, matrixFailureSummary, matrixResponseBody, missingBackupResponse, type DisposableUser } from './integration/fixture-contract'

const shared: DisposableUser = { username: 'shared', password: 'test-password', userId: '@shared:test', token: 'test-token' }
const isolated: DisposableUser = { username: 'backup-migration', password: 'isolated-password', userId: '@backup-migration:test', token: 'isolated-token' }

describe('backup-migration fixture isolation', () => {
  it('selects the dedicated user, not positional shared accounts', () => {
    expect(backupMigrationUser({ users: [shared], scenarioUsers: { backupMigration: isolated } })).toBe(isolated)
  })
  it('fails rather than falling back to Alice when the scenario user is missing', () => {
    expect(() => backupMigrationUser({ users: [shared] })).toThrow('no backup-migration account')
  })
  it('rejects an alias of a shared Matrix identity', () => {
    expect(() => backupMigrationUser({ users: [shared], scenarioUsers: { backupMigration: { ...isolated, userId: shared.userId } } }))
      .toThrow('must not reuse')
  })
  it('rejects incomplete credentials without printing their contents', () => {
    expect(() => backupMigrationUser({ users: [], scenarioUsers: { backupMigration: { ...isolated, token: '' } } }))
      .toThrow('no backup-migration account')
  })
  it('requires the real missing-backup response, not an auth or proxy error', () => {
    expect(missingBackupResponse(404, { errcode: 'M_NOT_FOUND' })).toBe(true)
    for (const [status, body] of [
      [200, { version: 'existing' }], [401, { errcode: 'M_UNKNOWN_TOKEN' }],
      [404, null], [404, { errcode: 'M_FORBIDDEN' }], [429, { errcode: 'M_LIMIT_EXCEEDED' }],
    ] as const) expect(missingBackupResponse(status, body)).toBe(false)
  })
})

describe('credential-free integration failure diagnostics', () => {
  it('keeps only the fixed operation, HTTP status and recognized error code', () => {
    const summary = matrixFailureSummary('client-api', 429, {
      errcode: 'M_LIMIT_EXCEEDED', error: 'private-message', access_token: 'secret-token',
      recovery_key: 'secret-key', retry_after_ms: 123,
    })
    expect(summary).toBe('client-api: HTTP 429 (M_LIMIT_EXCEEDED)')
  })
  it('never echoes attacker-controlled operation labels or error codes', () => {
    expect(matrixFailureSummary('secret-url', 403, { errcode: 'secret-token', error: 'private-message' }))
      .toBe('matrix-api: HTTP 403 (unknown)')
  })
  it.each([null, undefined, 'secret-token', ['secret-token'], 42])('handles a non-object body', body => {
    expect(matrixFailureSummary('admin-api', 500, body)).toBe('admin-api: HTTP 500 (unknown)')
  })
  it('does not stringify an invalid status', () => {
    expect(matrixFailureSummary('backup-precondition', Number.NaN, {}))
      .toBe('backup-precondition: HTTP unknown (unknown)')
  })
})

describe('integration HTTP JSON contract', () => {
  it('returns successfully parsed success bodies unchanged', async () => {
    const body = { room_id: '!fixture:test' }
    await expect(matrixResponseBody(200, async () => body)).resolves.toBe(body)
  })
  it('fails malformed successful JSON without exposing response text', async () => {
    await expect(matrixResponseBody(200, async () => { throw new SyntaxError('secret-response-text') }))
      .rejects.toThrow(/^Invalid JSON response from Matrix fixture API\.$/)
  })
  it('retains parsed error bodies for allowlisted diagnostics', async () => {
    const body = { errcode: 'M_LIMIT_EXCEEDED', error: 'private-message' }
    await expect(matrixResponseBody(429, async () => body)).resolves.toBe(body)
  })
  it('tolerates malformed error JSON without exposing parser text', async () => {
    await expect(matrixResponseBody(500, async () => { throw new SyntaxError('secret-response-text') }))
      .resolves.toBeNull()
  })
})
