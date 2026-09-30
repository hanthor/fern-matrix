import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// Disposable OIDC IdP plus an OIDC-only Synapse for the legacy-SSO round
// trip. Usage: npm run test:sso [-- playwright args]
const directory = await mkdtemp(join(tmpdir(), 'fern-sso-'))
const ready = join(directory, 'sso-fixture.json')
const python = process.env.FERN_SYNAPSE_PYTHON || '.cache/fern-synapse/bin/python'
const children = []
let interrupted = false
const stop = () => { interrupted = true; for (const child of children) child.kill('SIGTERM') }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

async function waitFor(child, prefix) {
  let output = ''
  const deadline = Date.now() + 60_000
  child.stdout.on('data', chunk => { output += chunk.toString() })
  while (true) {
    if (interrupted || child.exitCode !== null) throw new Error(`${prefix} process stopped before ready`)
    const line = output.split('\n').find(candidate => candidate.startsWith(prefix))
    if (line) return line.slice(prefix.length)
    if (Date.now() > deadline) throw new Error(`${prefix} timed out`)
    await delay(200)
  }
}

try {
  const idp = spawn(python, ['tests/integration/oidc-idp.py'], { stdio: ['ignore', 'pipe', 'inherit'] })
  children.push(idp)
  const idpBase = await waitFor(idp, 'OIDC_IDP=')
  console.log(`Test IdP ready (${idpBase})`)
  const homeserver = spawn(python, ['tests/integration/homeserver-sso.py'], {
    stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, FERN_SYNAPSE_PYTHON: python, OIDC_IDP: idpBase },
  })
  children.push(homeserver)
  const announced = await waitFor(homeserver, 'FERN_SSO_FIXTURE=')
  await writeFile(ready, announced, 'utf8')
  console.log('SSO homeserver ready')
  const tests = spawn('npx', ['playwright', 'test', '--config', 'playwright.integration.config.ts', 'sso.spec.ts', ...process.argv.slice(2)], {
    stdio: 'inherit', env: { ...process.env, FERN_SSO_FIXTURE: ready, FERN_SYNAPSE_PYTHON: python },
  })
  process.exitCode = await new Promise((resolve, reject) => {
    tests.on('error', reject)
    tests.on('exit', code => resolve(code ?? 1))
  })
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  for (const child of children) child.kill('SIGTERM')
  await rm(directory, { recursive: true, force: true })
}
