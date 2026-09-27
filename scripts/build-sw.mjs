import { readFile, writeFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const base = process.env.FERN_BASE_PATH || '/'
const files = (await readdir(new URL('../dist/assets', import.meta.url))).filter(file => /\.(js|css|woff2)$/.test(file)).map(file => `${base}assets/${file}`)
const assets = ['index.html', 'fern.svg', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'].map(file => `${base}${file}`).concat(files)
const version = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 12)
const template = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8')
await writeFile(new URL('../dist/sw.js', import.meta.url), template.replace('__FERN_BUILD__', version).replace('__FERN_BASE_PATH__', base).replace('__FERN_ASSETS__', JSON.stringify(assets)))
console.log(`Offline shell: ${assets.length} public assets, version ${version}. WASM is cached on first use.`)

const manifest = JSON.parse(await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'))
manifest.start_url = base
manifest.scope = base
manifest.icons = manifest.icons.map(icon => ({ ...icon, src: `${base}${icon.src.replace(/^\//, '')}` }))
await writeFile(new URL('../dist/manifest.webmanifest', import.meta.url), JSON.stringify(manifest))
await writeFile(new URL('../dist/.nojekyll', import.meta.url), '')
