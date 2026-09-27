import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, relative, resolve } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const lock = JSON.parse(await readFile(new URL('./sdk-lock.json', import.meta.url), 'utf8'))
if (lock.schemaVersion !== 1) throw new Error('Unsupported SDK lock schema')
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const packageLock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
const runtime = lock.runtime
if (packageJson.dependencies[runtime.package] !== runtime.version ||
    packageLock.packages[`node_modules/${runtime.package}`]?.version !== runtime.version) {
  throw new Error('SDK runtime differs from the audited artifact lock. Review and test an SDK upgrade together.')
}

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const paths = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) paths.push(...await filesIn(path))
    else if (entry.isFile()) paths.push(relative(root, path).replaceAll('\\', '/'))
    else throw new Error(`Unexpected SDK entry: ${relative(root, path)}`)
  }
  return paths
}
const actual = [...await filesIn(join(root, 'src/sdk/generated')), 'src/sdk/index.ts', 'LICENSE.txt'].sort()
const expected = Object.keys(lock.files).sort()
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error('SDK artifact file set differs from the audited lock. Regenerate and review the complete artifact set.')
}
for (const path of expected) {
  const absolute = resolve(root, path)
  const metadata = await stat(absolute)
  if (metadata.size !== lock.files[path].bytes) throw new Error(`SDK artifact size mismatch: ${path}`)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(absolute)) hash.update(chunk)
  if (hash.digest('hex') !== lock.files[path].sha256) throw new Error(`SDK artifact checksum mismatch: ${path}`)
}
console.log(`Verified ${expected.length} locked SDK artifacts/notices and runtime ${runtime.version}.`)
console.log('This verifies checkout consistency; a reproducible source rebuild is still required by issue #5.')
