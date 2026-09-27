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
for (const key of ['cargoLockSha256', 'webManifestSha256', 'downgradePatchSha256']) {
  if (first[key] !== second[key]) throw new Error(`Source build input changed between runs: ${key}`)
}
const firstNames = Object.keys(first.files).sort()
const secondNames = Object.keys(second.files).sort()
if (JSON.stringify(firstNames) !== JSON.stringify(secondNames)) throw new Error('Two source rebuilds produced different SDK file sets')
const changed = firstNames.filter(path => first.files[path].bytes !== second.files[path].bytes || first.files[path].sha256 !== second.files[path].sha256)
if (changed.length) throw new Error(`Source rebuilds are not byte-for-byte reproducible:\n${changed.join('\n')}`)
console.log(`Two clean builds match byte-for-byte: ${firstNames.length} generated SDK files; Cargo.lock ${first.cargoLockSha256}; WASM ${first.wasmSha256}.`)
