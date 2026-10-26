import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyTree, filesIn, nativePackageName, packVerified, readPackage, sha256, targets } from './package-utils.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const target = process.argv[2]
if (!targets.includes(target) || target !== `${process.platform}-${process.arch}`) {
  throw new Error(`Expected a supported build target matching this runner; got ${target ?? '(none)'} on ${process.platform}-${process.arch}`)
}
const pkg = await readPackage(root)
const lock = JSON.parse(await readFile(join(root, 'native/dependencies.json'), 'utf8'))
const native = join(root, 'dist/native')
const manifest = JSON.parse(await readFile(join(native, 'manifest.json'), 'utf8'))
const executable = `dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`
const library = process.platform === 'win32' ? 'pdfium.dll'
  : process.platform === 'darwin' ? 'libpdfium.dylib' : 'libpdfium.so'
if (manifest.protocolVersion !== 1 || manifest.platform !== target
    || manifest.pdfiumVersion !== lock.pdfium.version || manifest.sdkArchiveSha256 !== lock.pdfium.assets[target]) {
  throw new Error(`Native manifest does not match pinned dependencies for ${target}`)
}
const expected = ['manifest.json', executable, library, 'PDFIUM_LICENSE', 'JSON_LICENSE.MIT']
const paths = await filesIn(native)
if (!paths.some(path => path.startsWith('licenses/'))
    || expected.some(path => !paths.includes(path))
    || paths.some(path => !expected.includes(path) && !path.startsWith('licenses/'))
    || paths.some(path => path.split('/').some(segment => segment.startsWith('.')))) {
  throw new Error(`Native distribution has missing licenses or unexpected files for ${target}`)
}
if (sha256(await readFile(join(native, executable))) !== manifest.executableSha256
    || sha256(await readFile(join(native, library))) !== manifest.librarySha256) {
  throw new Error(`Native helper or PDFium library checksum mismatch for ${target}`)
}
if (process.platform !== 'win32' && !((await stat(join(native, executable))).mode & 0o111)) {
  throw new Error(`Native helper is not executable for ${target}`)
}
const [os, cpu] = target.split('-')
const metadata = {
  name: nativePackageName(pkg.name, target), version: pkg.version,
  description: `Prebuilt PDFium worker for ${pkg.name} (${target})`,
  license: pkg.license, repository: pkg.repository, homepage: pkg.homepage, bugs: pkg.bugs,
  type: 'module', os: [os], cpu: [cpu], ...(os === 'linux' ? { libc: ['glibc'] } : {}),
  exports: { './package.json': './package.json' }, files: ['bin', 'LICENSE'],
  publishConfig: { access: 'public' },
}
await packVerified(root, metadata, async stage => {
  await copyTree(native, join(stage, 'bin'))
  await copyTree(join(root, 'LICENSE'), join(stage, 'LICENSE'), undefined, 'LICENSE')
}, `${target}-native`)
