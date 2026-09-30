import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// Disposable Spindle with its built-in OIDC provider for the native-OIDC
// round trip. Usage: npm run test:oidc [-- playwright args]
// Requires a Spindle binary (single static process, no Postgres or MAS):
// cargo build --release -p spindle-server --bin spindle, then point
// FERN_SPINDLE_BIN at it. Port defaults to 18008 to avoid clashing with a
// developer's own Spindle on 8008.
const spindleBin = process.env.FERN_SPINDLE_BIN
if (!spindleBin) {
  console.error('Set FERN_SPINDLE_BIN to a Spindle binary with the built-in OIDC provider.')
  process.exitCode = 1
} else {
  const directory = await mkdtemp(join(tmpdir(), 'fern-oidc-'))
  const ready = join(directory, 'oidc-fixture.json')
  const port = Number(process.env.FERN_SPINDLE_PORT ?? 18008)
  const name = `127.0.0.1:${port}`
  const base = `http://${name}`
  await writeFile(join(directory, 'spindle.toml'), `[server]\nname = "${name}"\nbind = "${name}"\npublic_base_url = "${base}"\n\n[storage]\npath = ${JSON.stringify(join(directory, 'data'))}\n\n[auth]\nbuiltin_oidc = true\n`, 'utf8')
  const spindle = spawn(spindleBin, [join(directory, 'spindle.toml')], { stdio: ['ignore', 'inherit', 'inherit'] })
  let interrupted = false
  const stop = () => { interrupted = true; spindle.kill('SIGTERM') }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    const deadline = Date.now() + 60_000
    for (;;) {
      if (interrupted || spindle.exitCode !== null) throw new Error('Spindle stopped before ready (port in use?)')
      try {
        const versions = await fetch(base + '/_matrix/client/versions')
        if (versions.ok) break
      } catch { /* not listening yet */ }
      if (Date.now() > deadline) throw new Error('Spindle timed out')
      await delay(200)
    }
    const users = []
    for (const username of ['alice-oidc', 'bob-oidc']) {
      const password = 'hunter2-hunter2'
      const response = await fetch(base + '/_matrix/client/v3/register', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password, auth: { type: 'm.login.dummy', session: 's' } }),
      })
      if (!response.ok) throw new Error(`Spindle registration failed for ${username}`)
      const body = await response.json()
      users.push({ username, password, userId: body.user_id, token: body.access_token })
    }
    await writeFile(ready, JSON.stringify({ base, version: 'spindle-builtin-oidc', users }), 'utf8')
    console.log(`OIDC fixture ready (${base})`)
    const tests = spawn('npx', ['playwright', 'test', '--config', 'playwright.integration.config.ts', 'oidc.spec.ts', ...process.argv.slice(2)], {
      stdio: 'inherit', env: { ...process.env, FERN_OIDC_FIXTURE: ready },
    })
    process.exitCode = await new Promise((resolve, reject) => {
      tests.on('error', reject)
      tests.on('exit', code => resolve(code ?? 1))
    })
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  } finally {
    spindle.kill('SIGTERM')
    if (spindle.exitCode === null) {
      await Promise.race([new Promise(resolve => spindle.once('exit', resolve)), delay(20_000)])
      if (spindle.exitCode === null) spindle.kill('SIGKILL')
    }
    await rm(directory, { recursive: true, force: true })
  }
}
