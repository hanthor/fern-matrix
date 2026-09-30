#!/usr/bin/env node
// Cut a Fern release: verify the version is synced across the manifests,
// then create and push the tag that drives the signed release pipelines
// (desktop deb/AppImage plus updater latest.json, Android APK/AAB).
// Usage: node scripts/cut-release.mjs 0.1.0
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: node scripts/cut-release.mjs <x.y.z>')
  process.exit(1)
}

const run = (command) => execSync(command, { encoding: 'utf8' }).trim()
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const tauri = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'))
const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8').match(/^version = "([^"]+)"/m)?.[1]
for (const [name, found] of [['package.json', pkg.version], ['tauri.conf.json', tauri.version], ['Cargo.toml', cargo]]) {
  if (found !== version) {
    console.error(`version mismatch: ${name} says ${found ?? 'unknown'}, want ${version}`)
    process.exit(1)
  }
}

const tag = `v${version}`
try {
  run(`git rev-parse -q --verify refs/tags/${tag}`)
  console.error(`tag ${tag} already exists`)
  process.exit(1)
} catch { /* tag is free */ }

const branch = run('git branch --show-current')
if (branch !== 'main') {
  console.error(`releases cut from main, currently on ${branch || '(detached)'}`)
  process.exit(1)
}

run(`git tag -a ${tag} -m "Fern ${tag}"`)
run(`git push origin ${tag}`)
console.log(`tagged ${tag}: desktop and Android release jobs are running`)
