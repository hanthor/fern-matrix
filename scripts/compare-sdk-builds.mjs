import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const [firstArg, secondArg] = process.argv.slice(2)
if (!firstArg || !secondArg) throw new Error('Usage: node scripts/compare-sdk-builds.mjs <build-1-dir> <build-2-dir>')
const firstPath = join(resolve(firstArg), 'build-info.json')
const secondPath = join(resolve(secondArg), 'build-info.json')
const first = JSON.parse(await readFile(firstPath, 'utf8'))
const second = JSON.parse(await readFile(secondPath, 'utf8'))
for (const key of ['auroraCommit', 'rustSdkCommit', 'generatorCommit', 'nodeVersion', 'yarnVersion', 'rustcVersion', 'cargoVersion', 'wasmBindgenVersion', 'binaryenVersion']) {
  if (first[key] !== second[key]) throw new Error(`Build inputs differ: ${key}`)
}
for (const key of ['cargoLockSha256', 'webManifestSha256', 'downgradePatchSha256', 'rustSdkBuildPatch']) {
  if (first[key] !== second[key]) {
    throw new Error(`Source build input changed between runs: ${key} (${first[key]} != ${second[key]})`)
  }
}
const firstNames = Object.keys(first.files).sort()
const secondNames = Object.keys(second.files).sort()
if (JSON.stringify(firstNames) !== JSON.stringify(secondNames)) throw new Error('Two source rebuilds produced different SDK file sets')

const closureExportFiles = new Set([
  'wasm-bindgen/index.d.ts',
  'wasm-bindgen/index.js',
  'wasm-bindgen/index_bg.wasm.d.ts',
])
const wasmFile = 'wasm-bindgen/index_bg.wasm'
const allowedVariableFiles = new Set([...closureExportFiles, wasmFile])
const unexpected = firstNames.filter(path => {
  const left = first.files[path]
  const right = second.files[path]
  if (left.bytes !== right.bytes) return true
  if (left.sha256 === right.sha256) return false
  return !allowedVariableFiles.has(path)
})
if (unexpected.length) throw new Error(`Pinned source builds changed stable generated files:\n${unexpected.join('\n')}`)

for (const path of closureExportFiles) {
  const left = await readFile(join(resolve(firstArg), 'src/sdk/generated', path), 'utf8')
  const right = await readFile(join(resolve(secondArg), 'src/sdk/generated', path), 'utf8')
  const stable = source => path.endsWith('.js')
    ? source.slice(0, source.indexOf('function wasm_bindgen__convert__closures_____invoke__'))
    : source.split('\n').filter(line => !line.includes('wasm_bindgen__convert__closures_____invoke__') && !line.includes('wasm_bindgen__closure__destroy__')).join('\n')
  if (!left.includes('wasm_bindgen__convert__closures_____invoke__') || !right.includes('wasm_bindgen__convert__closures_____invoke__')) {
    throw new Error(`Could not identify generated closure export section in ${path}`)
  }
  if (stable(left) !== stable(right)) throw new Error(`Pinned source builds changed the stable WASM glue surface: ${path}`)
}

if (!firstNames.includes(wasmFile)) throw new Error(`Generated WASM is missing from the staged output: ${wasmFile}`)
if (first.wasmSha256 === second.wasmSha256) {
  console.log(`Two clean builds match byte-for-byte: ${firstNames.length} generated SDK files; Cargo.lock ${first.cargoLockSha256}; WASM ${first.wasmSha256}.`)
} else {
  console.log(`Two clean builds match all stable bindings and WASM glue outside compiler-generated closure exports. The WASM hashes differ (${first.wasmSha256} vs ${second.wasmSha256}); candidate checksums are retained in build-info.json and must be validated by the app build and live integration suite.`)
}
