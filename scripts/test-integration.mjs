import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const directory = await mkdtemp(join(tmpdir(), 'fern-integration-'))
const ready = join(directory, 'fixture.json')
const python = process.env.FERN_SYNAPSE_PYTHON || '.cache/fern-synapse/bin/python'
const fixture = spawn(python, ['tests/integration/homeserver.py', ready], { stdio: ['ignore', 'inherit', 'inherit'] })
let fixtureError
fixture.on('error', error => { fixtureError = error })
let tests
let interrupted = false
const stop = () => { interrupted = true; tests?.kill('SIGTERM'); fixture.kill('SIGTERM') }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
try {
  const deadline = Date.now() + 100_000
  while (true) {
    if (fixtureError) throw new Error('Install the pinned Synapse test environment first; see docs/INTEGRATION.md.', { cause: fixtureError })
    if (interrupted || fixture.exitCode !== null) throw new Error('Synapse fixture stopped before tests')
    try { JSON.parse(await readFile(ready, 'utf8')); break } catch { /* atomic readiness is checked below */ }
    if (Date.now() > deadline) throw new Error('Synapse fixture timed out')
    await delay(200)
  }
  tests = spawn('npx', ['playwright', 'test', '--config', 'playwright.integration.config.ts', ...process.argv.slice(2)], {
    stdio: 'inherit', env: { ...process.env, FERN_MATRIX_FIXTURE: ready },
  })
  process.exitCode = await new Promise((resolve, reject) => {
    tests.on('error', reject)
    tests.on('exit', code => resolve(code ?? 1))
  })
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  fixture.kill('SIGTERM')
  if (fixture.exitCode === null && !fixtureError) {
    await Promise.race([new Promise(resolve => fixture.once('exit', resolve)), delay(20_000)])
    if (fixture.exitCode === null) fixture.kill('SIGKILL')
  }
  await rm(directory, { recursive: true, force: true })
}
