import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyTree, filesIn, packVerified, readPackage, releasePackage } from './package-utils.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const pkg = releasePackage(await readPackage(root))
if (pkg.private === true) throw new Error('The main package is private; configure the public release manifest first')
if (!Array.isArray(pkg.files) || pkg.files.length === 0) throw new Error('The main package requires an explicit files allowlist')
const safePath = path => typeof path === 'string' && path !== '' && !path.includes('\\')
  && !path.split('/').some(segment => !segment || segment === '..' || segment.startsWith('.') || segment === 'node_modules')
const allowedRoots = new Set(['dist', 'locale', 'docs', 'scripts', 'README.md', 'README.zh.md', 'SPEC.md',
  'PERFORMANCE.md', 'NATIVE_V1.md', 'LICENSE', 'cordis.patch.yml', 'icon.svg'])
for (const path of pkg.files) {
  if (!safePath(path) || !allowedRoots.has(path.split('/')[0]) || /[*?\[\]{}]/.test(path)
      || path.startsWith('scripts/') && path !== 'scripts/local-embedding-server.py') {
    throw new Error(`Unsafe package files entry: ${path}`)
  }
}
const metadata = { ...pkg }
delete metadata.private
delete metadata.devDependencies
delete metadata.scripts
delete metadata.workspaces
delete metadata.packageManager
delete metadata.bundleDependencies
delete metadata.bundledDependencies

await packVerified(root, metadata, async stage => {
  const include = path => {
    if (path === 'dist/native' || path.startsWith('dist/native/')) return false
    if (!safePath(path) || path.endsWith('.map') || /\.(?:tsx?|cpp|cc|h|hpp)$/.test(path) && !path.endsWith('.d.ts')
        || /(?:^|\/)(?:credentials?|secrets?|tokens?)\.(?:json|txt)$/.test(path) || /\.(?:pem|key)$/.test(path)) {
      throw new Error(`Source, credentials or temporary files cannot be published: ${path}`)
    }
    return true
  }
  for (const path of new Set([...pkg.files, 'LICENSE', 'README.md'])) {
    await copyTree(join(root, path), join(stage, path), include, path)
  }
  const files = await filesIn(stage)
  const publicTargets = Object.values(pkg.exports ?? {}).flatMap(value => typeof value === 'string' ? [value]
    : value && typeof value === 'object' ? Object.values(value) : [])
  if (!publicTargets.length) throw new Error('The main package must expose its public entries')
  for (const target of [...publicTargets, './cordis.patch.yml']) {
    if (typeof target !== 'string' || !target.startsWith('./')) throw new Error('Public exports must be package-relative files')
    const path = target.slice(2)
    if (path === 'package.json') continue
    if (path.includes('*')) {
      const [start, end] = path.split('*')
      if (!files.some(file => file.startsWith(start) && file.endsWith(end))) throw new Error(`Missing exported files: ${target}`)
    } else if (!files.includes(path)) throw new Error(`Missing exported file: ${target}`)
  }
  for (const required of ['dist/index.js', 'dist/client.js', 'dist/THIRD_PARTY_NOTICES.md']) {
    if (!files.includes(required)) throw new Error(`The main package is missing ${required}`)
  }
  for (const path of files.filter(path => path.startsWith('locale/') && path.endsWith('.json'))) {
    JSON.parse(await readFile(join(stage, path), 'utf8'))
  }
}, 'main')
