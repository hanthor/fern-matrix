// Helpers for disposable integration fixtures, never application/runtime code.
export interface DisposableUser { username: string; password: string; userId: string; token: string }
interface FixtureUsers {
  users: DisposableUser[]
  scenarioUsers?: { backupMigration?: DisposableUser }
}

export function backupMigrationUser(fixture: FixtureUsers): DisposableUser {
  const user = fixture.scenarioUsers?.backupMigration
  if (!user || ![user.username, user.password, user.userId, user.token]
    .every(value => typeof value === 'string' && value.length > 0)) {
    throw new Error('The disposable fixture has no backup-migration account.')
  }
  if (fixture.users.some(shared => shared.userId === user.userId)) {
    throw new Error('Backup migration must not reuse a shared fixture account.')
  }
  return user
}

const errorCodes = new Set([
  'M_LIMIT_EXCEEDED', 'M_FORBIDDEN', 'M_UNKNOWN_TOKEN', 'M_MISSING_TOKEN',
  'M_NOT_FOUND', 'M_BAD_JSON', 'M_NOT_JSON', 'M_UNRECOGNIZED', 'M_UNAUTHORIZED',
  'M_UNKNOWN', 'M_INVALID_PARAM', 'M_BAD_STATE',
])
const operationNames = new Set(['client-api', 'admin-api', 'backup-precondition'])
function record(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown> : {}
}
export function missingBackupResponse(status: number, body: unknown): boolean {
  return status === 404 && record(body).errcode === 'M_NOT_FOUND'
}
export function matrixFailureSummary(operation: string, status: number, body: unknown): string {
  const safeOperation = operationNames.has(operation) ? operation : 'matrix-api'
  const safeStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 'unknown'
  const code = record(body).errcode
  const safeCode = typeof code === 'string' && errorCodes.has(code) ? code : 'unknown'
  return safeOperation + ': HTTP ' + safeStatus + ' (' + safeCode + ')'
}

/** Keep successful JSON strict; error bodies are best-effort diagnostics only. */
export async function matrixResponseBody(status: number, readJson: () => Promise<unknown>): Promise<unknown> {
  if (status >= 300) return readJson().catch(() => null)
  try {
    return await readJson()
  } catch {
    // A parser error can contain response text. Do not retain its message/cause.
    throw new Error('Invalid JSON response from Matrix fixture API.')
  }
}
