import { spawn, spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Measure our C++ worker, not the prebuilt third-party PDFium library. Build
// outside dist/native so a coverage run never replaces the packaged helper.
const root = fileURLToPath(new URL('../', import.meta.url))
const source = join(root, 'native/pdfium-worker.cpp')
const sdk = process.env.DSH_PDFIUM_ROOT ? resolve(process.env.DSH_PDFIUM_ROOT) : join(root, 'native/.deps/pdfium')
const jsonDir = process.env.DSH_PDF_JSON_DIR ? resolve(process.env.DSH_PDF_JSON_DIR) : join(root, 'native/.deps/json')
const sdkLibrary = join(sdk, 'lib', process.platform === 'darwin' ? 'libpdfium.dylib' : 'libpdfium.so')

if (!['darwin', 'linux'].includes(process.platform)) {
  throw new Error('Native LLVM coverage currently requires macOS or Linux with Clang and llvm-cov')
}
for (const file of [join(sdk, 'VERSION'), join(jsonDir, 'json.hpp'), sdkLibrary]) {
  if (!(await stat(file).catch(() => undefined))?.isFile()) {
    throw new Error(`Missing native dependency ${file}; run npm run native:build first`)
  }
}
const lock = JSON.parse(await readFile(join(root, 'native/dependencies.json'), 'utf8'))
const version = Object.fromEntries([...((await readFile(join(sdk, 'VERSION'), 'utf8')).matchAll(/^(MAJOR|MINOR|BUILD|PATCH)=(\d+)\s*$/gm))]
  .map(match => [match[1], match[2]]))
if (['MAJOR', 'MINOR', 'BUILD', 'PATCH'].map(key => version[key]).join('.') !== lock.pdfium.version) {
  throw new Error(`Native coverage requires pinned PDFium ${lock.pdfium.version}`)
}

function resolveTool(name) {
  if (process.platform !== 'darwin') return name
  const result = spawnSync('xcrun', ['--find', name], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`Install Apple Command Line Tools; xcrun cannot find ${name}`)
  return result.stdout.trim()
}
const compiler = process.env.CXX ?? resolveTool('clang++')
const profdata = resolveTool('llvm-profdata')
const cov = resolveTool('llvm-cov')
const macSdk = process.platform === 'darwin'
  ? spawnSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' }) : undefined
if (macSdk && macSdk.status !== 0) throw new Error('xcrun cannot find the macOS SDK')
const outputRoot = join(root, '.test-output')
await mkdir(outputRoot, { recursive: true })
const requestedOutput = process.env.DSH_PDF_NATIVE_COVERAGE_OUTPUT
if (requestedOutput && !isAbsolute(requestedOutput)) {
  throw new Error('DSH_PDF_NATIVE_COVERAGE_OUTPUT must be an absolute directory')
}
const output = requestedOutput ? resolve(requestedOutput) : await mkdtemp(join(outputRoot, 'native-coverage-'))
await mkdir(output, { recursive: true })
const binary = join(output, 'dsh-pdf-native')
// A fresh profile directory prevents stale process profiles from a previous
// run from inflating coverage when callers request a stable output location.
const rawDir = await mkdtemp(join(output, 'raw-'))

async function run(command, args, options = {}) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: options.stdio ?? 'inherit', env: options.env ?? process.env, windowsHide: true })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolveRun() : reject(new Error(`${command} exited ${code}`)))
  })
}
async function outputToFile(path, command, args) {
  const file = await open(path, 'w')
  try { await run(command, args, { stdio: ['ignore', file.fd, 'inherit'] }) }
  finally { await file.close() }
}

await run(compiler, ['-std=c++17', '-O0', '-g', '-fprofile-instr-generate', '-fcoverage-mapping',
  ...(macSdk ? ['-isysroot', macSdk.stdout.trim()] : []),
  '-Wall', '-Wextra', '-Wpedantic', `-I${join(sdk, 'include')}`, `-I${jsonDir}`,
  source, `-L${join(sdk, 'lib')}`, '-lpdfium',
  `-Wl,-rpath,${process.platform === 'darwin' ? '@loader_path' : '$ORIGIN'}`, '-o', binary])
await copyFile(sdkLibrary, join(output, sdkLibrary.split('/').at(-1)))

await run(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', 'tests/native-integration.test.ts'], {
  env: { ...process.env, DSH_PDF_REQUIRE_NATIVE_TESTS: '1', DSH_PDF_NATIVE_HELPER: binary,
    DSH_PDF_NATIVE_COVERAGE: '1', LLVM_PROFILE_FILE: join(rawDir, '%p.profraw') },
})
const profiles = (await readdir(rawDir)).filter(name => name.endsWith('.profraw')).map(name => join(rawDir, name))
if (!profiles.length) throw new Error('Native tests passed but emitted no profile; the helper may not have exited cleanly')
const merged = join(output, 'native.profdata')
await run(profdata, ['merge', '-sparse', ...profiles, '-o', merged])
const common = ['--instr-profile', merged, binary, '--sources', source]
await outputToFile(join(output, 'summary.json'), cov, ['export', '--summary-only', ...common])
await outputToFile(join(output, 'coverage.lcov'), cov, ['export', '--format=lcov', ...common])
await run(cov, ['report', '--show-branch-summary', ...common])
await run(cov, ['show', '--format=html', '--output-dir', join(output, 'html'), ...common])
await writeFile(join(output, 'README.txt'), `Scope: project-owned native/pdfium-worker.cpp only.\nThird-party prebuilt PDFium is not instrumented.\n`)
console.log(`Native coverage report: ${output}`)
