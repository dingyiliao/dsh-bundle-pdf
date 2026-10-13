import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile, readdir, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const target = process.argv[2]
const supported = new Set(['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64'])
if (!supported.has(target) || target !== `${process.platform}-${process.arch}`) {
  throw new Error(`Expected a supported build target matching this runner; got ${target ?? '(none)'} on ${process.platform}-${process.arch}`)
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const lock = JSON.parse(await readFile(join(root, 'native/dependencies.json'), 'utf8'))
const native = join(root, 'dist/native')
const manifest = JSON.parse(await readFile(join(native, 'manifest.json'), 'utf8'))
const executable = `dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`
const library = process.platform === 'win32' ? 'pdfium.dll'
  : process.platform === 'darwin' ? 'libpdfium.dylib' : 'libpdfium.so'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const nativeEntry = pkg.exports?.['./native']
if (typeof nativeEntry !== 'string' || !nativeEntry.startsWith('./dist/')) {
  throw new Error('package.json must export the prebuilt native provider from dist')
}

if (manifest.protocolVersion !== 1 || manifest.platform !== target ||
    manifest.pdfiumVersion !== lock.pdfium.version ||
    manifest.sdkArchiveSha256 !== lock.pdfium.assets[target]) {
  throw new Error(`Native manifest does not match pinned dependencies for ${target}`)
}
const nativeFiles = [
  ['manifest.json', await readFile(join(native, 'manifest.json'))],
  [executable, await readFile(join(native, executable))],
  [library, await readFile(join(native, library))],
]
if (sha256(nativeFiles[1][1]) !== manifest.executableSha256 ||
    sha256(nativeFiles[2][1]) !== manifest.librarySha256) {
  throw new Error(`Native helper or PDFium library checksum mismatch for ${target}`)
}
if (process.platform !== 'win32' && !((await stat(join(native, executable))).mode & 0o111)) {
  throw new Error(`Native helper is not executable for ${target}`)
}
for (const license of ['PDFIUM_LICENSE', 'JSON_LICENSE.MIT']) {
  nativeFiles.push([license, await readFile(join(native, license))])
}

const archives = (await readdir(root)).filter(name => name.endsWith('.tgz'))
if (archives.length !== 1) throw new Error(`Expected exactly one npm pack archive, found ${archives.length}`)
const archive = join(root, archives[0])
function tar(args) {
  const result = spawnSync('tar', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`Could not inspect npm archive: ${result.stderr.toString()}`)
  return result.stdout
}
const contents = new Set(tar(['-tf', archive]).toString('utf8').trim().split(/\r?\n/))
for (const path of ['package/package.json', 'package/cordis.patch.yml', 'package/dist/index.js',
  'package/dist/client.js', `package/${nativeEntry.slice(2)}`]) {
  if (!contents.has(path)) throw new Error(`npm package is missing ${path}`)
}
for (const [name, bytes] of nativeFiles) {
  const path = `package/dist/native/${name}`
  if (!contents.has(path) || sha256(tar(['-xOf', archive, path])) !== sha256(bytes)) {
    throw new Error(`npm package is missing or changed ${path}`)
  }
}
const nativeEntries = [...contents].filter(path => path.startsWith('package/dist/native/') && !path.endsWith('/'))
const allowedNativeFiles = new Set(nativeFiles.map(([name]) => `package/dist/native/${name}`))
if (!nativeEntries.some(path => path.startsWith('package/dist/native/licenses/')) ||
    nativeEntries.some(path => !allowedNativeFiles.has(path) && !path.startsWith('package/dist/native/licenses/'))) {
  throw new Error(`npm package has missing licenses or extra native files for ${target}`)
}
if ([...contents].some(path => path.startsWith('package/native/') || path === 'package/scripts/build-native.mjs')) {
  throw new Error('npm package must not require a native build toolchain')
}
const packedMetadata = JSON.parse(tar(['-xOf', archive, 'package/package.json']).toString('utf8'))
if (packedMetadata.name !== pkg.name || packedMetadata.version !== pkg.version) {
  throw new Error('npm package metadata changed during packing')
}

const output = join(root, 'artifacts')
await mkdir(output, { recursive: true })
const name = `${pkg.name.replace(/^@/, '').replaceAll('/', '-')}-${pkg.version}-${target}-npm-package.tgz`
await rename(archive, join(output, name))
console.log(`Verified complete installable npm package: artifacts/${name}`)
