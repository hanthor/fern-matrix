import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

const [sourceArg, destinationArg, repetitionArg] = process.argv.slice(2)
if (!sourceArg || !destinationArg || !['1', '2'].includes(repetitionArg)) {
  throw new Error('Usage: node scripts/stage-sdk-artifacts.mjs <aurora-checkout> <candidate-output> <repetition-1-or-2>')
}
const source = resolve(sourceArg)
const destination = resolve(destinationArg)
const outputGenerated = join(source, 'src/generated')
const inputWasm = join(outputGenerated, 'wasm-bindgen/index_bg.wasm')
const generatedStat = await readdir(outputGenerated, { withFileTypes: true })
if (!generatedStat.some(entry => entry.isDirectory() && entry.name === 'wasm-bindgen')) {
  throw new Error('The pinned Aurora generator did not create the WASM bindings directory')
}
const wasm = await readFile(inputWasm)
const index = await readFile(join(source, 'src/index.web.ts'), 'utf8')
if (!index.includes('wasmPath') || !index.includes('index_bg.wasm')) {
  throw new Error('The generated web initialization wrapper has no WASM import')
}

await mkdir(join(destination, 'src/sdk'), { recursive: true })
await cp(outputGenerated, join(destination, 'src/sdk/generated'), { recursive: true })
for (const entry of await readdir(join(destination, 'src/sdk/generated'), { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
  const path = join(destination, 'src/sdk/generated', entry.name)
  const code = await readFile(path, 'utf8')
  await writeFile(path, code.replaceAll('async public ', 'public async '))
}
const wrapper = index.replace(
  /(["'])\.\/generated\/wasm-bindgen\/index_bg\.wasm\1/g,
  '"./generated/wasm-bindgen/index_bg.wasm?url"',
)
if (!wrapper.includes('./generated/wasm-bindgen/index_bg.wasm?url')) {
  throw new Error('Could not apply Fern\'s required Vite WASM URL import to the generated wrapper')
}
await writeFile(join(destination, 'src/sdk/index.ts'), wrapper)
await cp(new URL('../LICENSE.txt', import.meta.url), join(destination, 'LICENSE.txt'))

const sourceLock = join(source, 'rust_modules/matrix-rust-sdk/Cargo.lock')
await cp(sourceLock, join(destination, 'Cargo.lock'))
const workspaceManifest = join(source, 'rust_modules/matrix-rust-sdk/bindings/wasm/Cargo.toml')
await cp(workspaceManifest, join(destination, 'web-Cargo.toml'))

async function collect(path, root = path) {
  const records = {}
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Unexpected generated SDK symlink: ${full}`)
    if (entry.isDirectory()) Object.assign(records, await collect(full, root))
    else if (entry.isFile()) {
      const content = await readFile(full)
      records[full.slice(root.length + 1).replaceAll('\\', '/')] = {
        bytes: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
      }
    }
  }
  return records
}
const files = await collect(join(destination, 'src/sdk/generated'))
for (const name of ['src/sdk/index.ts', 'LICENSE.txt']) {
  const content = await readFile(join(destination, name))
  files[name] = { bytes: content.byteLength, sha256: createHash('sha256').update(content).digest('hex') }
}
const checksum = createHash('sha256').update(wasm).digest('hex')
const buildInfo = {
  schemaVersion: 1,
  repetition: Number(repetitionArg),
  auroraCommit: '95e69fc560e31ea263f3e4d45fb9125557f49ace',
  rustSdkCommit: 'ee7ece4019d367f9eaba2408b34766321562f8bf',
  generatorCommit: '5c01f3f7025d069aac1dd1fd51ca72bb76fdb243',
  nodeVersion: process.version,
  yarnVersion: process.env.FERN_YARN_VERSION,
  rustcVersion: process.env.FERN_RUSTC_VERSION,
  cargoVersion: process.env.FERN_CARGO_VERSION,
  wasmBindgenVersion: '0.2.105',
  binaryenVersion: '123',
  cargoLockSha256: createHash('sha256').update(await readFile(sourceLock)).digest('hex'),
  webManifestSha256: createHash('sha256').update(await readFile(workspaceManifest)).digest('hex'),
  downgradePatchSha256: createHash('sha256').update(await readFile(join(source, 'patches/0001-Downgrade-uniffi-to-0.29.4.patch'))).digest('hex'),
  rustSdkBuildPatch: 'absorbed-upstream',
  wasmSha256: checksum,
  generatedFileCount: Object.keys(files).length,
  files,
}
await writeFile(join(destination, 'build-info.json'), JSON.stringify(buildInfo, null, 2) + '\n')
console.log(`Staged repetition ${repetitionArg}: ${buildInfo.generatedFileCount} SDK files, WASM SHA256 ${checksum}`)
