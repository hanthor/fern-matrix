/** Only structured SDK credential refusal qualifies; never parse server prose. */
export function isPasswordLoginRejected(error: unknown): boolean {
  const value = error as { tag?: string; inner?: { code?: string; kind?: { tag?: string } } } | null
  return value?.tag === 'MatrixApi'
    && (value.inner?.code === 'M_FORBIDDEN' || value.inner?.kind?.tag === 'Forbidden')
}

export type LoginDestination = { server: string; logicalServer: boolean; error?: never } | { error: 'invalidMxid' | 'invalidServer' | 'registrationLocalpart'; server?: never; logicalServer?: never }

/** Matrix server names are authorities, never URLs, paths, or userinfo. */
export function validMatrixServerName(server: string): boolean {
  if (!server || server.length > 255 || /[\s\\/?#@%]/.test(server)) return false
  const match = server.startsWith('[')
    ? /^(\[[0-9a-fA-F:.]+\])(?::([0-9]+))?$/.exec(server)
    : /^([a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)(?::([0-9]+))?$/.exec(server)
  if (!match || (match[2] !== undefined && (Number(match[2]) < 1 || Number(match[2]) > 65535))) return false
  if (!server.startsWith('[') && match[1].split('.').some(label => !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label) || label.length > 63)) return false
  try { const url = new URL(`https://${server}`); return Boolean(url.hostname) } catch { return false }
}

export function loginDestination(username: string, selectedServer: string, registering = false): LoginDestination {
  if (registering && (!username || /[@:\s\x00-\x1f\x7f]/.test(username))) return { error: 'registrationLocalpart' }
  if (!registering && username.startsWith('@')) {
    const separator = username.indexOf(':')
    const localpart = username.slice(1, separator)
    const server = username.slice(separator + 1)
    if (separator < 2 || /[\s\x00-\x1f\x7f]/.test(localpart) || new TextEncoder().encode(username).length > 255 || !validMatrixServerName(server)) return { error: 'invalidMxid' }
    return { server, logicalServer: true }
  }
  if (!registering && /[:\s\x00-\x1f\x7f]/.test(username)) return { error: 'invalidMxid' }
  if (validMatrixServerName(selectedServer)) return { server: selectedServer, logicalServer: false }
  try {
    const url = new URL(selectedServer)
    if (!/\s|\\/.test(selectedServer) && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && validMatrixServerName(url.host)) return { server: selectedServer, logicalServer: false }
  } catch { /* Invalid custom endpoint: never contact it. */ }
  return { error: 'invalidServer' }
}

/** Let the SDK discover delegation or a direct endpoint on this SAME authority.
 * Never retry the previously selected/default server for a full Matrix ID.
 * serverName alone is intentionally not used: it requires .well-known even for
 * legitimate direct homeservers. No custom discovery or endpoint-host comparison.
 */
export function configureLoginServer<T>(builder: { serverNameOrHomeserverUrl(server: string): T }, server: string, logicalServer: boolean): T {
  if (logicalServer && !validMatrixServerName(server)) throw new Error('Invalid Matrix homeserver authority.')
  return builder.serverNameOrHomeserverUrl(server)
}
