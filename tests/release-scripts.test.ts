import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cutRelease = join(root, 'scripts/cut-release.mjs')
const composeUpdater = join(root, 'scripts/compose-updater.mjs')
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
}

const exec = (cwd: string, command: string, args: string[]) =>
  spawnSync(command, args, { cwd, encoding: 'utf8', env: gitEnv })
const script = (cwd: string, path: string, ...args: string[]) => exec(cwd, process.execPath, [path, ...args])
const git = (cwd: string, ...args: string[]) => {
  const result = exec(cwd, 'git', args)
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.trim()
}

// A project directory whose three version manifests agree.
function writeManifests(dir: string, versions: { pkg?: string; tauri?: string; cargo?: string } = {}) {
  const { pkg = '1.2.3', tauri = '1.2.3', cargo = '1.2.3' } = versions
  mkdirSync(join(dir, 'src-tauri'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: pkg }))
  writeFileSync(join(dir, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: tauri }))
  writeFileSync(join(dir, 'src-tauri/Cargo.toml'), `[package]\nname = "fixture"\nversion = "${cargo}"\n`)
}

let scratch: string
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'fern-release-')) })
afterEach(() => { rmSync(scratch, { recursive: true, force: true }) })

describe('scripts/cut-release.mjs', () => {
  // A work tree on `main` with a bare `origin` to push the tag to.
  function repo(versions?: Parameters<typeof writeManifests>[1]) {
    const origin = join(scratch, 'origin.git')
    const work = join(scratch, 'work')
    mkdirSync(work)
    git(scratch, 'init', '-q', '--bare', origin)
    git(work, 'init', '-q', '-b', 'main')
    writeManifests(work, versions)
    git(work, 'add', '.')
    git(work, 'commit', '-q', '-m', 'init')
    git(work, 'remote', 'add', 'origin', origin)
    return { origin, work }
  }

  it.each([[[]], [['1.2']], [['v1.2.3']], [['1.2.3-rc1']]])('rejects a missing or malformed version %j', (args) => {
    const { work } = repo()
    const result = script(work, cutRelease, ...args)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('usage: node scripts/cut-release.mjs <x.y.z>')
    expect(git(work, 'tag')).toBe('')
  })

  it.each([
    ['package.json', { pkg: '1.2.2' }],
    ['tauri.conf.json', { tauri: '1.2.2' }],
    ['Cargo.toml', { cargo: '1.2.2' }],
  ])('refuses to tag when %s is out of sync', (name, versions) => {
    const { work, origin } = repo(versions)
    const result = script(work, cutRelease, '1.2.3')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`version mismatch: ${name} says 1.2.2, want 1.2.3`)
    expect(git(work, 'tag')).toBe('')
    expect(git(origin, 'tag')).toBe('')
  })

  it('refuses to tag a version that already has a tag', () => {
    const { work } = repo()
    git(work, 'tag', 'v1.2.3')
    const result = script(work, cutRelease, '1.2.3')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('tag v1.2.3 already exists')
  })

  it('only cuts releases from main', () => {
    const { work, origin } = repo()
    git(work, 'checkout', '-q', '-b', 'feature')
    const result = script(work, cutRelease, '1.2.3')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('releases cut from main, currently on feature')
    expect(git(origin, 'tag')).toBe('')
  })

  it('reports a detached HEAD instead of an empty branch name', () => {
    const { work } = repo()
    git(work, 'checkout', '-q', '--detach')
    const result = script(work, cutRelease, '1.2.3')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('currently on (detached)')
  })

  it('creates an annotated tag and pushes it to origin', () => {
    const { work, origin } = repo()
    const result = script(work, cutRelease, '1.2.3')
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('tagged v1.2.3')
    expect(git(work, 'cat-file', '-t', 'v1.2.3')).toBe('tag')
    expect(git(work, 'tag', '-l', '--format=%(contents:subject)', 'v1.2.3')).toBe('Fern v1.2.3')
    expect(git(origin, 'tag')).toBe('v1.2.3')
    expect(git(origin, 'rev-parse', 'v1.2.3^{commit}')).toBe(git(work, 'rev-parse', 'HEAD'))
  })
})

describe('scripts/compose-updater.mjs', () => {
  const bundleDir = 'src-tauri/target/release/bundle/appimage'
  function project(versions?: Parameters<typeof writeManifests>[1]) {
    writeManifests(scratch, versions)
    mkdirSync(join(scratch, bundleDir), { recursive: true })
  }
  const writeBundle = (name = 'Fern_1.2.3_amd64.AppImage', signature: string | null = 'c2lnbmF0dXJl\n') => {
    writeFileSync(join(scratch, bundleDir, name), 'binary')
    if (signature !== null) writeFileSync(join(scratch, bundleDir, `${name}.sig`), signature)
  }
  const compose = (...args: string[]) => script(scratch, composeUpdater, ...args)

  it.each([[[]], [['1.2.3']], [['v1.2']], [['v1.2.3-rc1']]])('rejects a missing or malformed tag %j', (args) => {
    project()
    const result = compose(...args)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Tag must look like v1.2.3')
  })

  it('refuses a tag that mismatches package.json', () => {
    project({ pkg: '1.2.2' })
    writeBundle()
    const result = compose('v1.2.3')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Tag v1.2.3 mismatches package.json version 1.2.2')
  })

  it('refuses a tag that mismatches tauri.conf.json', () => {
    project({ tauri: '1.2.2' })
    writeBundle()
    const result = compose('v1.2.3')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Tag v1.2.3 mismatches tauri.conf.json version 1.2.2')
  })

  it('fails when the signed release build has not run', () => {
    writeManifests(scratch)
    const result = compose('v1.2.3')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('No AppImage bundles found. Run the signed release build first')
  })

  it('fails when the bundle directory holds no AppImage', () => {
    project()
    writeFileSync(join(scratch, bundleDir, 'Fern.txt'), 'x')
    const result = compose('v1.2.3')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('No AppImage bundle found. The release build must run with the signing key.')
  })

  it('fails when the AppImage has no signature file', () => {
    project()
    writeBundle('Fern.AppImage', null)
    const result = compose('v1.2.3')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Fern.AppImage.sig')
  })

  it('fails on an empty signature and writes no manifest', () => {
    project()
    writeBundle('Fern.AppImage', '  \n')
    const result = compose('v1.2.3')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Empty signature for Fern.AppImage. The bundle was not signed.')
    expect(() => readFileSync(join(scratch, bundleDir, 'latest.json'))).toThrow()
  })

  it('writes the updater manifest for the signed AppImage', () => {
    project()
    writeBundle()
    const before = Date.now()
    const result = compose('v1.2.3')
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('latest.json for v1.2.3: Fern_1.2.3_amd64.AppImage')
    const raw = readFileSync(join(scratch, bundleDir, 'latest.json'), 'utf8')
    expect(raw.endsWith('}\n')).toBe(true)
    const manifest = JSON.parse(raw)
    expect(manifest).toMatchObject({
      version: '1.2.3',
      notes: 'Fern 1.2.3',
      platforms: {
        'linux-x86_64': {
          signature: 'c2lnbmF0dXJl',
          url: 'https://github.com/hanthor/fern-matrix/releases/download/v1.2.3/Fern_1.2.3_amd64.AppImage',
        },
      },
    })
    expect(Date.parse(manifest.pub_date)).toBeGreaterThanOrEqual(before - 1000)
  })
})
