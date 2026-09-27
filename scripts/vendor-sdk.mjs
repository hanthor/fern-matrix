import { cp, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
const source = process.argv[2]
if (!source) throw new Error('Usage: node scripts/vendor-sdk.mjs /path/to/aurora-checkout')
const destination = new URL('../src/sdk/generated/', import.meta.url)
await cp(resolve(source, 'src/generated'), destination, { recursive: true })
for (const file of await readdir(destination)) {
  if (!file.endsWith('.ts')) continue
  const target = new URL(file, destination)
  const code = await readFile(target, 'utf8')
  await writeFile(target, code.replaceAll('async public ', 'public async '))
}
const wasm = await readFile(new URL('wasm-bindgen/index_bg.wasm', destination))
console.log('Copied SDK artifacts. WASM SHA256:', createHash('sha256').update(wasm).digest('hex'))
console.log('Update docs/SDK-PROVENANCE.md with the checkout commit, then run build and browser tests.')
