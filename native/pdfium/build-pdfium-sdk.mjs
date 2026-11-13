import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { patchsetDigest, readPatchset } from './patchset.mjs'
import { parseArgs } from 'node:util'

const root = fileURLToPath(new URL('../../', import.meta.url))
const { values: options } = parseArgs({ options: {
  checkout: { type: 'string' },
  sdk: { type: 'string' },
  target: { type: 'string' },
  'build-dir': { type: 'string', default: 'out/dsh-sdk' },
  'stock-archive': { type: 'string' },
  gn: { type: 'string' },
  ninja: { type: 'string' },
  'mac-clt': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} })
const usage = 'node native/pdfium/build-pdfium-sdk.mjs --checkout /path/to/pdfium --sdk /new/path/to/sdk [--target linux-arm64] [--mac-clt]'
if (options.help) {
  console.log(usage)
  process.exit(0)
}
if (!options.checkout || !options.sdk) throw new Error(usage)

const lock = JSON.parse(await readFile(join(root, 'native/dependencies.json'), 'utf8')).pdfium
const patchset = await readPatchset()
if (patchset.sourceRevision !== lock.sourceRevision) throw new Error('PDFium patchset source revision differs from the lock')
const host = `${process.platform}-${process.arch}`
const platform = options.target ?? host
if (platform !== host && (host !== 'linux-x64' || platform !== 'linux-arm64')) {
  throw new Error(`Cannot build PDFium for ${platform} on ${host}`)
}
const targetArch = platform.split('-')[1]
const os = { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform]
if (!lock.assets[platform] || !os) throw new Error(`No locked PDFium SDK for ${platform}`)
if (options['mac-clt'] && os !== 'mac') throw new Error('--mac-clt requires macOS')
const checkout = await realpath(resolve(options.checkout))
const sdk = resolve(options.sdk)
const archive = resolve(options['stock-archive'] ?? join(root, 'native/.deps', `pdfium-${platform}.tgz`))
const build = resolve(checkout, options['build-dir'])
const buildRelative = relative(checkout, build).split(sep).join('/')
if (!buildRelative.startsWith('out/')) throw new Error('--build-dir must be below out/ in the PDFium checkout')
const library = { mac: 'libpdfium.dylib', linux: 'libpdfium.so', win: 'pdfium.dll' }[os]

async function exists(path) {
  try { await lstat(path); return true }
  catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}
function run(executable, args, cwd = checkout) {
  execFileSync(executable, args, { cwd, stdio: 'inherit', windowsHide: true })
}
function output(executable, args, cwd = checkout) {
  return execFileSync(executable, args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}
async function buildTool(option, name, localPath) {
  if (option) return option.includes('/') || option.includes('\\') ? resolve(option) : option
  return await exists(localPath) ? localPath : name
}

if (await exists(sdk)) throw new Error(`SDK destination already exists: ${sdk}`)
const sourceRevision = output('git', ['rev-parse', 'HEAD'])
if (sourceRevision !== lock.sourceRevision) throw new Error(`Check out locked PDFium revision ${lock.sourceRevision}`)
if (!await exists(archive)) throw new Error(`Missing locked stock PDFium archive: ${archive}`)
if (createHash('sha256').update(await readFile(archive)).digest('hex') !== lock.assets[platform]) {
  throw new Error(`Stock PDFium archive checksum does not match ${platform}`)
}
const extension = os === 'win' ? '.exe' : ''
const gn = await buildTool(options.gn, 'gn', join(checkout, 'buildtools', { mac: 'mac', linux: 'linux64', win: 'win' }[os], `gn${extension}`))
const ninja = await buildTool(options.ninja, 'ninja', join(checkout, 'third_party/ninja', `ninja${extension}`))
await mkdir(build, { recursive: true })

/** Chromium normally probes a full Xcode installation. A local CLT build
 * supplies the same variables from xcrun while GN and Ninja run. */
async function useLocalMacSdk(task) {
  if (!options['mac-clt']) return task()
  const args = ['--sdk', 'macosx']
  const sdkPath = output('xcrun', [...args, '--show-sdk-path'])
  const version = output('xcrun', [...args, '--show-sdk-version'])
  const buildVersion = output('xcrun', [...args, '--show-sdk-build-version'])
  const binPath = dirname(output('xcrun', [...args, '--find', 'clang'])) + '/'
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(version) || !/^[A-Za-z0-9]+$/.test(buildVersion)) {
    throw new Error('xcrun did not identify a usable macOS SDK')
  }
  const [major, minor, patch = '0'] = version.split('.')
  const xcodeVersion = Number(`${major}${minor}${patch}`)
  const sdkLink = join(build, 'LocalMacOSX.sdk')
  if (!await exists(sdkLink)) await symlink(sdkPath, sdkLink, 'dir')
  else if (!(await lstat(sdkLink)).isSymbolicLink() || await realpath(sdkLink) !== await realpath(sdkPath)) {
    throw new Error(`Existing GN SDK link points to a different SDK: ${sdkLink}`)
  }
  const buildSource = join(checkout, 'build')
  const config = 'config/mac/mac_sdk.gni'
  const configPath = join(buildSource, config)
  const lockPath = join(checkout, 'out/.dsh-local-mac-sdk.lock')
  const macLock = await open(lockPath, 'wx')
  let original
  try {
    original = await readFile(configPath)
    const source = output('git', ['show', `HEAD:${config}`], buildSource)
    const start = source.indexOf('_mac_sdk_result = exec_script(')
    const end = source.indexOf('_sdk_root = rebase_path(')
    if (start < 0 || end <= start) throw new Error('Unexpected layout of pinned Chromium mac_sdk.gni')
    const replacement = [
      `xcode_version_int = ${xcodeVersion}`,
      `xcode_build = ${JSON.stringify(buildVersion)}`,
      `mac_sdk_version = ${JSON.stringify(version)}`,
      'mac_sdk_build_version = xcode_build',
      `mac_sdk_path = ${JSON.stringify(`//${buildRelative}/${basename(sdkLink)}`)}`,
      `mac_bin_path = ${JSON.stringify(binPath)}`,
    ].join('\n')
    await writeFile(configPath, `${source.slice(0, start)}${replacement}\n${source.slice(end)}\n`)
    return task()
  } finally {
    try { if (original) await writeFile(configPath, original) }
    finally {
      await macLock.close()
      await rm(lockPath)
    }
  }
}

const gnArgs = [
  'clang_use_chrome_plugins=false',
  'is_component_build=false',
  'is_debug=false',
  'pdf_enable_v8=false',
  'pdf_enable_xfa=false',
  'pdf_is_standalone=true',
  'pdf_use_partition_alloc=false',
  `target_cpu="${targetArch}"`,
  `target_os="${os}"`,
  'treat_warnings_as_errors=false',
  ...(os === 'mac' ? ['use_lld=false', 'use_system_xcode=true'] : []),
]
run(process.execPath, [fileURLToPath(new URL('./apply-pdfium-extensions.mjs', import.meta.url)), checkout])
const patchDigest = await patchsetDigest()
await useLocalMacSdk(() => {
  run(gn, ['gen', buildRelative, `--args=${gnArgs.join(' ')}`])
  run(ninja, ['-C', buildRelative, 'pdfium'])
})

await mkdir(dirname(sdk), { recursive: true })
const staged = await mkdtemp(join(dirname(sdk), '.dsh-pdfium-sdk-'))
try {
  const archiveDirectory = dirname(archive)
  const stagedRelative = relative(archiveDirectory, staged).split(sep).join('/')
  run('tar', ['-xzf', basename(archive), '-C', stagedRelative, 'VERSION', 'licenses'], archiveDirectory)
  await copyFile(join(checkout, 'LICENSE'), join(staged, 'LICENSE'))
  await copyFile(join(checkout, 'third_party/harfbuzz/src/COPYING'), join(staged, 'licenses/harfbuzz.txt'))
  await writeFile(join(staged, 'DSH_SOURCE_REVISION'), `${sourceRevision}\n`)
  await writeFile(join(staged, 'DSH_PATCHSET'), `${patchDigest}\n`)
  const headers = await readdir(join(checkout, 'public'))
  await mkdir(join(staged, 'include'))
  await Promise.all(headers.filter(name => name.endsWith('.h')).map(name =>
    copyFile(join(checkout, 'public', name), join(staged, 'include', name))))
  await cp(join(checkout, 'public/cpp'), join(staged, 'include/cpp'), { recursive: true })
  const libraryDirectory = os === 'win' ? 'bin' : 'lib'
  await mkdir(join(staged, libraryDirectory))
  await copyFile(join(build, library), join(staged, libraryDirectory, library))
  if (os === 'win') {
    const implib = await exists(join(build, 'pdfium.dll.lib')) ? 'pdfium.dll.lib' : 'pdfium.lib'
    await mkdir(join(staged, 'lib'))
    await copyFile(join(build, implib), join(staged, 'lib/pdfium.dll.lib'))
  }
  // Resolve relative to this SDK instead of reusing a prior find_library result
  // in the worker's CMake cache when switching from the stock SDK.
  await writeFile(join(staged, 'PDFiumConfig.cmake'), [
    'add_library(pdfium SHARED IMPORTED)',
    'set_target_properties(pdfium PROPERTIES',
    '  INTERFACE_INCLUDE_DIRECTORIES "${CMAKE_CURRENT_LIST_DIR}/include"',
    `  IMPORTED_LOCATION "\${CMAKE_CURRENT_LIST_DIR}/${libraryDirectory}/${library}"`,
    ...(os === 'win' ? ['  IMPORTED_IMPLIB "${CMAKE_CURRENT_LIST_DIR}/lib/pdfium.dll.lib"'] : []),
    ')',
    `set(PDFium_VERSION "${lock.version}")`,
    '',
  ].join('\n'))
  await rename(staged, sdk)
} finally {
  await rm(staged, { recursive: true, force: true })
}
console.log(`Staged development PDFium SDK (${platform}) at ${sdk}`)
