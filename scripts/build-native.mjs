import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { copyFile, cp, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const lock = JSON.parse(await readFile(join(root, 'native/dependencies.json'), 'utf8'))
const platform = `${process.platform}-${process.arch}`
const checksum = lock.pdfium.assets[platform]
if (!checksum) throw new Error(`No pinned PDFium SDK for ${platform}; use PDF.js on this platform`)
const cache = join(root, 'native/.deps')
const sdk = process.env.DSH_PDFIUM_ROOT ? resolve(process.env.DSH_PDFIUM_ROOT) : join(cache, 'pdfium')
const jsonDir = process.env.DSH_PDF_JSON_DIR ? resolve(process.env.DSH_PDF_JSON_DIR) : join(cache, 'json')
const out = join(root, 'dist/native')
await mkdir(cache, { recursive: true }); await mkdir(jsonDir, { recursive: true }); await mkdir(out, { recursive: true })
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function exists(file) { return stat(file).then(() => true, () => false) }
async function download(url, file, expected) {
  if (await exists(file)) {
    const bytes = await readFile(file)
    if (digest(bytes) === expected) return
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) })
  if (!response.ok) throw new Error(`Dependency download HTTP ${response.status}: ${new URL(url).hostname}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (digest(bytes) !== expected) throw new Error(`Dependency checksum mismatch for ${file}`)
  await mkdir(dirname(file), { recursive: true }); await writeFile(file, bytes)
}
async function run(executable, args) {
  await new Promise((done, reject) => {
    const child = spawn(executable, args, { cwd: root, stdio: 'inherit', windowsHide: true, shell: false })
    child.once('error', reject)
    child.once('close', code => code === 0 ? done() : reject(new Error(`${executable} exited ${code}`)))
  })
}
if (!process.env.DSH_PDFIUM_ROOT) {
  const assetPlatform = { linux: 'linux', darwin: 'mac', win32: 'win' }[process.platform]
  const archive = join(cache, `pdfium-${platform}.tgz`)
  await download(`https://github.com/bblanchon/pdfium-binaries/releases/download/${lock.pdfium.tag}/pdfium-${assetPlatform}-${process.arch}.tgz`, archive, checksum)
  await mkdir(sdk, { recursive: true })
  await run('tar', ['-xzf', archive, '-C', sdk])
}
const versionText = await readFile(join(sdk, 'VERSION'), 'utf8')
const sdkVersion = Object.fromEntries([...versionText.matchAll(/^(MAJOR|MINOR|BUILD|PATCH)=(\d+)\s*$/gm)].map(m => [m[1], m[2]]))
const foundVersion = ['MAJOR', 'MINOR', 'BUILD', 'PATCH'].map(k => sdkVersion[k]).join('.')
if (foundVersion !== lock.pdfium.version) throw new Error(`SDK version ${foundVersion} differs from pinned ${lock.pdfium.version}`)
if (!process.env.DSH_PDF_JSON_DIR) {
  const prefix = `https://raw.githubusercontent.com/nlohmann/json/v${lock.json.version}`
  await download(`${prefix}/single_include/nlohmann/json.hpp`, join(jsonDir, 'json.hpp'), lock.json.headerSha256)
  await download(`${prefix}/LICENSE.MIT`, join(jsonDir, 'json-LICENSE.MIT'), lock.json.licenseSha256)
}
for (const [file, expected] of [['json.hpp', lock.json.headerSha256], ['json-LICENSE.MIT', lock.json.licenseSha256]]) {
  if (digest(await readFile(join(jsonDir, file))) !== expected) throw new Error(`Unexpected JSON dependency ${file}`)
}
const executableName = `dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`
if (spawnSync('cmake', ['--version'], { stdio: 'ignore', windowsHide: true }).status === 0) {
  const build = join(root, 'native/build')
  await run('cmake', ['-S', join(root, 'native'), '-B', build, `-DPDFium_DIR=${sdk}`,
    `-DJSON_INCLUDE_DIR=${jsonDir}`, '-DCMAKE_BUILD_TYPE=Release'])
  await run('cmake', ['--build', build, '--config', 'Release'])
  const built = await exists(join(build, 'Release', executableName)) ? join(build, 'Release', executableName) : join(build, executableName)
  await copyFile(built, join(out, executableName))
} else if (process.platform !== 'win32') {
  const compiler = process.env.CXX || (process.platform === 'darwin' ? 'clang++' : 'g++')
  await run(compiler, ['-std=c++17', '-O2', '-Wall', '-Wextra', '-Wpedantic', `-I${join(sdk, 'include')}`,
    `-I${jsonDir}`, join(root, 'native/pdfium-worker.cpp'), `-L${join(sdk, 'lib')}`, '-lpdfium',
    `-Wl,-rpath,${process.platform === 'darwin' ? '@loader_path' : '$ORIGIN'}`, '-o', join(out, executableName)])
} else throw new Error('Install CMake and the Visual Studio C++ build tools, then rerun npm run native:build')
const library = process.platform === 'win32' ? join(sdk, 'bin/pdfium.dll')
  : join(sdk, 'lib', process.platform === 'darwin' ? 'libpdfium.dylib' : 'libpdfium.so')
await copyFile(library, join(out, library.split(/[\\/]/).at(-1)))
await cp(join(sdk, 'licenses'), join(out, 'licenses'), { recursive: true })
await copyFile(join(sdk, 'LICENSE'), join(out, 'PDFIUM_LICENSE'))
await copyFile(join(jsonDir, 'json-LICENSE.MIT'), join(out, 'JSON_LICENSE.MIT'))
await writeFile(join(out, 'manifest.json'), `${JSON.stringify({ protocolVersion: 1, platform,
  pdfiumVersion: lock.pdfium.version, sdkArchiveSha256: checksum,
  executableSha256: digest(await readFile(join(out, executableName))),
  librarySha256: digest(await readFile(library)) }, null, 2)}\n`)
console.log(`Built isolated PDFium worker (${platform}, ${lock.pdfium.version}) at dist/native/${executableName}`)
