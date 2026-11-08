import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { copyFile, cp, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const lock = JSON.parse(await readFile(join(root, 'native/dependencies.json'), 'utf8'))
const platform = `${process.platform}-${process.arch}`
const cache = join(root, 'native/.deps')
const sdk = process.env.DSH_PDFIUM_ROOT ? resolve(process.env.DSH_PDFIUM_ROOT) : join(cache, 'pdfium')
const jsonDir = process.env.DSH_PDF_JSON_DIR ? resolve(process.env.DSH_PDF_JSON_DIR) : join(cache, 'json')
const out = join(root, 'dist/native')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function exists(file) { return stat(file).then(() => true, () => false) }
async function fetchDependency(url, headers) {
  const host = new URL(url).hostname
  const attempts = 3
  for (let attempt = 1; ; attempt++) {
    let response
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(120000) })
      if (response.ok) return Buffer.from(await response.arrayBuffer())
    } catch (cause) {
      if (attempt === attempts) throw new Error(`Dependency download failed: ${host}`, { cause })
    }
    if (response && !response.ok) {
      await response.body?.cancel().catch(() => {})
      if (attempt === attempts || ![408, 429, 500, 502, 503, 504].includes(response.status)) {
        throw new Error(`Dependency download HTTP ${response.status}: ${host}`)
      }
    }
    console.warn(`Dependency download from ${host} failed${response && !response.ok ? ` (HTTP ${response.status})` : ''}. Retrying (${attempt + 1}/${attempts}).`)
    await delay(2000 * attempt)
  }
}
async function download(file, expected, fetchBytes) {
  if (await exists(file)) {
    const bytes = await readFile(file)
    if (digest(bytes) === expected) return
  }
  if (process.env.DSH_PDF_NATIVE_OFFLINE === '1') throw new Error(`Missing or invalid offline native dependency: ${file}`)
  const bytes = await fetchBytes()
  if (digest(bytes) !== expected) throw new Error(`Dependency checksum mismatch for ${file}`)
  await mkdir(dirname(file), { recursive: true }); await writeFile(file, bytes)
}
let pdfiumRelease
async function fetchPdfiumAsset(name) {
  const releases = 'https://api.github.com/repos/bblanchon/pdfium-binaries/releases'
  const tag = lock.pdfium.tag
  pdfiumRelease ??= fetchDependency(`${releases}/tags/${encodeURIComponent(tag)}`).then(bytes => JSON.parse(bytes))
  const release = await pdfiumRelease
  const asset = release.assets.find(candidate => candidate.name === name)
  if (release.tag_name !== tag || !Number.isSafeInteger(asset?.id)) throw new Error(`Missing PDFium asset ${name} for ${tag}`)
  return fetchDependency(`${releases}/assets/${asset.id}`, { Accept: 'application/octet-stream' })
}
async function preparePdfium(target) {
  const [os, arch] = target.split('-')
  const assetPlatform = { linux: 'linux', darwin: 'mac', win32: 'win' }[os]
  const name = `pdfium-${assetPlatform}-${arch}.tgz`
  const archive = join(cache, `pdfium-${target}.tgz`)
  await download(archive, lock.pdfium.assets[target], async () => {
    try { return await fetchPdfiumAsset(name) }
    catch (error) {
      console.warn(`PDFium Release API could not fetch ${name} (${error.message}); trying the release download.`)
      return fetchDependency(`https://github.com/bblanchon/pdfium-binaries/releases/download/${lock.pdfium.tag}/${name}`)
    }
  })
  return archive
}
async function prepareJson(directory) {
  const prefix = `https://raw.githubusercontent.com/nlohmann/json/v${lock.json.version}`
  await download(join(directory, 'json.hpp'), lock.json.headerSha256, () => fetchDependency(`${prefix}/single_include/nlohmann/json.hpp`))
  await download(join(directory, 'json-LICENSE.MIT'), lock.json.licenseSha256, () => fetchDependency(`${prefix}/LICENSE.MIT`))
}
async function run(executable, args) {
  await new Promise((done, reject) => {
    const child = spawn(executable, args, { cwd: root, stdio: 'inherit', windowsHide: true, shell: false })
    child.once('error', reject)
    child.once('close', code => code === 0 ? done() : reject(new Error(`${executable} exited ${code}`)))
  })
}
if (process.argv.includes('--download-only')) {
  await Promise.all([...Object.keys(lock.pdfium.assets).map(preparePdfium), prepareJson(join(cache, 'json'))])
  console.log(`Verified pinned native dependencies in ${cache}`)
  process.exit(0)
}
const checksum = lock.pdfium.assets[platform]
if (!checksum) throw new Error(`No pinned PDFium SDK for ${platform}; native PDF reading is unavailable on this platform`)
await mkdir(out, { recursive: true })
if (!process.env.DSH_PDFIUM_ROOT) {
  const archive = await preparePdfium(platform)
  await mkdir(sdk, { recursive: true })
  await run('tar', ['-xzf', archive, '-C', sdk])
}
const versionText = await readFile(join(sdk, 'VERSION'), 'utf8')
const sdkVersion = Object.fromEntries([...versionText.matchAll(/^(MAJOR|MINOR|BUILD|PATCH)=(\d+)\s*$/gm)].map(m => [m[1], m[2]]))
const foundVersion = ['MAJOR', 'MINOR', 'BUILD', 'PATCH'].map(k => sdkVersion[k]).join('.')
if (foundVersion !== lock.pdfium.version) throw new Error(`SDK version ${foundVersion} differs from pinned ${lock.pdfium.version}`)
if (!process.env.DSH_PDF_JSON_DIR) await prepareJson(jsonDir)
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
if (process.platform === 'darwin') {
  const executable = join(out, executableName)
  const linked = spawnSync('otool', ['-L', executable], { encoding: 'utf8' })
  if (linked.status !== 0) throw new Error(`Could not inspect native PDFium linkage: ${linked.stderr}`)
  const library = linked.stdout.match(/^\s+(\S*libpdfium\.dylib)\s+\(/m)?.[1]
  if (!library) throw new Error('Native PDFium library is not linked')
  if (library !== '@loader_path/libpdfium.dylib') {
    await run('install_name_tool', ['-change', library, '@loader_path/libpdfium.dylib', executable])
    await run('codesign', ['--force', '--sign', '-', executable])
  }
}
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
