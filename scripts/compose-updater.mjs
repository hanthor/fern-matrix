// Compose the Tauri updater manifest (latest.json) for a tag release.
// Usage: node scripts/compose-updater.mjs v0.2.0
// Fails when the tag version mismatches package.json, or when the signed
// updater bundles from a signed `cargo tauri build` are missing.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [tag] = process.argv.slice(2)
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) throw new Error(`Tag must look like v1.2.3, got ${tag}`)
const version = tag.slice(1)
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
if (pkg.version !== version) throw new Error(`Tag ${tag} mismatches package.json version ${pkg.version}`)
const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'))
if (conf.version !== version) throw new Error(`Tag ${tag} mismatches tauri.conf.json version ${conf.version}`)
// The v2 updater consumes the AppImage directly: the CLI signs it in place
// (bundle/appimage/*.AppImage plus *.AppImage.sig) once
// bundle.createUpdaterArtifacts is true and the signing key is present.
const dir = 'src-tauri/target/release/bundle/appimage'
let entries
try {
  entries = readdirSync(dir)
} catch {
  throw new Error('No AppImage bundles found. Run the signed release build first (TAURI_SIGNING_PRIVATE_KEY).')
}
const asset = entries.find(name => name.endsWith('.AppImage'))
if (!asset) throw new Error('No AppImage bundle found. The release build must run with the signing key.')
const signature = readFileSync(join(dir, `${asset}.sig`), 'utf8').trim()
if (!signature) throw new Error(`Empty signature for ${asset}. The bundle was not signed.`)
const manifest = {
  version,
  notes: `Fern ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'linux-x86_64': {
      signature,
      url: `https://github.com/hanthor/fern-matrix/releases/download/${tag}/${asset}`,
    },
  },
}
writeFileSync(join(dir, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`latest.json for ${tag}: ${asset}`)
