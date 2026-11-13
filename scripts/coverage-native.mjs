import { spawn, spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classicPdf } from '../tests/fixtures/plain-pdf.ts'
import { nativeWorkerSources } from './native-coverage-sources.mjs'

// Measure our C++ worker, not the prebuilt third-party PDFium library. Build
// outside dist/native so a coverage run never replaces the packaged helper.
const root = fileURLToPath(new URL('../', import.meta.url))
const source = join(root, 'native/backend/pdfium/pdfium-worker.cpp')
const runtimeSource = join(root, 'native/worker/worker-runtime.cpp')
const sdk = process.env.DSH_PDFIUM_ROOT ? resolve(process.env.DSH_PDFIUM_ROOT) : join(root, 'native/.deps/pdfium-patched')
const jsonDir = process.env.DSH_PDF_JSON_DIR ? resolve(process.env.DSH_PDF_JSON_DIR) : join(root, 'native/.deps/json')
const sdkLibrary = join(sdk, 'lib', process.platform === 'darwin' ? 'libpdfium.dylib' : 'libpdfium.so')

if (!['darwin', 'linux'].includes(process.platform)) {
  throw new Error('Native LLVM coverage currently requires macOS or Linux with Clang and llvm-cov')
}
for (const file of [join(sdk, 'VERSION'), join(sdk, 'DSH_SOURCE_REVISION'),
  join(sdk, 'include/dsh_metadata.h'), join(jsonDir, 'json.hpp'), sdkLibrary]) {
  if (!(await stat(file).catch(() => undefined))?.isFile()) {
    throw new Error(`Missing native dependency ${file}; build the patched SDK and helper as described in native/pdfium/README.md`)
  }
}
const lock = JSON.parse(await readFile(join(root, 'native/dependencies.json'), 'utf8'))
if ((await readFile(join(sdk, 'DSH_SOURCE_REVISION'), 'utf8')).trim() !== lock.pdfium.sourceRevision) {
  throw new Error('Native coverage requires the pinned patched PDFium source revision')
}
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
const callbackBinary = join(output, 'form-callback-test')
const writeReplyBinary = join(output, 'write-reply-test')
// A fresh profile directory prevents stale process profiles from a previous
// run from inflating coverage when callers request a stable output location.
const rawDir = await mkdtemp(join(output, 'raw-'))

async function run(command, args, options = {}) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? root, stdio: options.stdio ?? 'inherit',
      env: options.env ?? process.env, windowsHide: true })
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
  source, runtimeSource, `-I${join(root, 'native')}`, `-L${join(sdk, 'lib')}`, '-lpdfium',
  `-Wl,-rpath,${process.platform === 'darwin' ? '@loader_path' : '$ORIGIN'}`, '-o', binary])
await copyFile(sdkLibrary, join(output, sdkLibrary.split('/').at(-1)))

// Form callbacks are required by PDFium but a read-only render does not call
// them. Cover their valid and fail-closed paths in a separate executable so
// production never exposes a test-only native command or executes PDF actions.
const callbackFixture = classicPdf([
  '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] /DA (/Helv 12 Tf 0 g) /DR << /Font << /Helv 5 0 R >> >> >> >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Annots [4 0 R] >>',
  '<< /Type /Annot /Subtype /Widget /FT /Tx /T (coverage-field) /V (Visible value) /P 3 0 R /Rect [30 100 180 130] /F 4 >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
])
const callbackFixturePath = join(output, 'form-callback.pdf')
await writeFile(callbackFixturePath, callbackFixture)
await run(compiler, ['-std=c++17', '-O0', '-g', '-fprofile-instr-generate', '-fcoverage-mapping',
  ...(macSdk ? ['-isysroot', macSdk.stdout.trim()] : []),
  '-Wall', '-Wextra', '-Wpedantic', `-I${join(sdk, 'include')}`, `-I${jsonDir}`, `-I${join(root, 'native')}`,
  join(root, 'native/form-callback-test.cpp'), runtimeSource, `-L${join(sdk, 'lib')}`, '-lpdfium',
  `-Wl,-rpath,${process.platform === 'darwin' ? '@loader_path' : '$ORIGIN'}`, '-o', callbackBinary])

await run(compiler, ['-std=c++17', '-O0', '-g', '-fprofile-instr-generate', '-fcoverage-mapping',
  ...(macSdk ? ['-isysroot', macSdk.stdout.trim()] : []),
  '-Wall', '-Wextra', '-Wpedantic', `-I${join(sdk, 'include')}`, `-I${jsonDir}`, `-I${join(root, 'native')}`,
  join(root, 'native/worker/write-reply-test.cpp'),
  '-o', writeReplyBinary])
await run(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1',
  'tests/native-integration.test.ts', 'tests/native-encrypted.test.ts', 'tests/native-selection-geometry.test.ts',
  'tests/native-document-metadata.test.ts', 'tests/native-document-port.test.ts', 'tests/native-form-fields.test.ts',
  'tests/native-object-generations.test.ts', 'tests/native-outline-extensions.test.ts',
  'tests/native-page-content.test.ts', 'tests/native-protocol.test.ts', 'tests/native-provider.test.ts',
  'tests/native-coverage-edge.test.ts',
  'tests/native-text-positioning.test.ts', 'tests/native-text-surrogates.test.ts',
  'tests/adapters/pdfium/pdf-service.test.ts', 'tests/adapters/pdfium/document-residency.test.ts',
  'tests/adapters/pdfium/outlines.test.ts', 'tests/adapters/pdfium/unicode-form-appearance.test.ts'], {
  env: { ...process.env, DSH_PDF_REQUIRE_NATIVE_TESTS: '1', DSH_PDF_NATIVE_HELPER: binary,
    DSH_PDF_REQUIRE_NATIVE_EXTENSIONS: '1',
    DSH_PDF_NATIVE_COVERAGE: '1', LLVM_PROFILE_FILE: join(rawDir, '%p.profraw') },
})
await run(callbackBinary, [callbackFixturePath], {
  cwd: output,
  env: { ...process.env, LLVM_PROFILE_FILE: join(rawDir, '%p.profraw') },
})
await run(writeReplyBinary, [], {
  cwd: output,
  env: { ...process.env, LLVM_PROFILE_FILE: join(rawDir, '%p.profraw') },
})
const profiles = (await readdir(rawDir)).filter(name => name.endsWith('.profraw')).map(name => join(rawDir, name))
if (!profiles.length) throw new Error('Native tests passed but emitted no profile; the helper may not have exited cleanly')
const merged = join(output, 'native.profdata')
await run(profdata, ['merge', '-sparse', ...profiles, '-o', merged])
const sources = nativeWorkerSources.map(path => join(root, path))
const common = ['--instr-profile', merged, binary, '--object', callbackBinary, '--object', writeReplyBinary, '--sources', ...sources]
await outputToFile(join(output, 'summary.json'), cov, ['export', '--summary-only', ...common])
await outputToFile(join(output, 'coverage.lcov'), cov, ['export', '--format=lcov', ...common])
await run(cov, ['report', '--show-branch-summary', ...common])
await run(cov, ['show', '--format=html', '--output-dir', join(output, 'html'), ...common])
await writeFile(join(output, 'README.txt'), 'Scope: the project-owned PDFium worker with the patched SDK.\nThe linked PDFium library, including extensions compiled into it, is not instrumented.\n')
console.log(`Native coverage report: ${output}`)
