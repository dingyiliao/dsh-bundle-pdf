import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../', import.meta.url))
const major = Number(process.versions.node.split('.')[0])
const minor = Number(process.versions.node.split('.')[1])
if (major < 26 || major === 26 && minor < 7) {
  throw new Error('Project coverage needs Node 26.7+ for --test-coverage-include-all.')
}

const browserExecutable = process.env.DSH_PDF_BROWSER_EXECUTABLE
  ?? process.env.PDF_BENCH_CHROMIUM ?? chromium.executablePath()
if (!existsSync(browserExecutable)) {
  throw new Error(`Browser coverage needs Chromium at ${browserExecutable}. Install Playwright Chromium or set DSH_PDF_BROWSER_EXECUTABLE.`)
}

const outputRoot = join(root, '.test-output')
await mkdir(outputRoot, { recursive: true })
const output = await mkdtemp(join(outputRoot, 'project-coverage-'))
const browserDirectory = join(output, 'browser-artifacts')
const nodeLcov = join(output, 'node.lcov')
const browserLcov = join(output, 'browser.lcov')
const nativeDirectory = join(output, 'native')
await mkdir(browserDirectory)

async function filesBelow(directory) {
  const files = []
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const relative = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await filesBelow(relative))
    else if (entry.isFile()) files.push(relative)
  }
  return files
}

/** Keep all runtime lanes and tests pinned to the same checked-out revision. */
async function projectFingerprint() {
  const paths = [...await filesBelow('src'), ...await filesBelow('tests'), ...await filesBelow('scripts'),
    'native/pdfium-worker.cpp', 'package.json', 'package-lock.json', 'tsconfig.json',
    'tsconfig.test.json', 'vitest.web.config.ts', 'cordis.patch.yml'].sort()
  const hash = createHash('sha256')
  for (const path of paths) {
    hash.update(path)
    hash.update('\0')
    hash.update(await readFile(join(root, path)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

const fingerprint = await projectFingerprint()
async function verifyFingerprint() {
  if (await projectFingerprint() !== fingerprint) {
    throw new Error('Project sources, tests, or build configuration changed during coverage collection; rerun from one stable revision.')
  }
}

/** Node can emit JS line numbers under a TS source path unless source maps are enabled. */
async function verifyNodeSourceMapAlignment() {
  const source = await readFile(join(root, 'src/host/local-files.ts'), 'utf8')
  const declaration = source.split(/\r?\n/).findIndex(line => /^\s*async function assertExpected\(/.test(line)) + 1
  const lcov = await readFile(nodeLcov, 'utf8')
  const section = lcov.split(/(?=^SF:)/m).find(record => /^SF:(?:.*\/)?src\/host\/local-files\.ts$/m.test(record))
  const reported = Number(section?.match(/^FN:(\d+),assertExpected$/m)?.[1])
  if (!declaration || !section || reported !== declaration) {
    throw new Error(`Node LCOV is not mapped to TypeScript source lines (assertExpected: source ${declaration}, LCOV ${reported || 'missing'}).`)
  }
}

async function run(label, argv, env = {}) {
  console.log(`\n[coverage] ${label}`)
  await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, argv, {
      cwd: root, env: { ...process.env, ...env }, stdio: 'inherit', windowsHide: true,
    })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolveRun() : reject(new Error(`${label} failed with exit code ${code}`)))
  })
}

console.log(`Project coverage artifacts: ${output}`)
let coverageError
try {
await run('source-mapped coverage build', ['scripts/build.mjs'], { DSH_PDF_BROWSER_COVERAGE: '1' })
await verifyFingerprint()
const nodeTests = (await readdir(join(root, 'tests'))).filter(name => name.endsWith('.test.ts')).sort()
await run('Node/Host tests with all source files in the denominator', [
  '--enable-source-maps', '--experimental-test-coverage', '--test-coverage-include-all',
  '--test-coverage-include=src/**/*.ts', '--test-coverage-include=src/**/*.tsx',
  '--test-reporter=dot', '--test-reporter-destination=stdout',
  '--test-reporter=lcov', `--test-reporter-destination=${nodeLcov}`,
  '--import', 'tsx', '--test', '--test-concurrency=1',
  ...nodeTests.map(name => `tests/${name}`),
])
await verifyFingerprint()
await verifyNodeSourceMapAlignment()
await run('browser Worker smoke', [
  '--import', 'tsx', '--test', 'tests/browser/ocr-local-worker.test.ts',
], { DSH_PDF_BROWSER_EXECUTABLE: browserExecutable, DSH_PDF_REQUIRE_BROWSER_TESTS: '1' })
await verifyFingerprint()
await run('Web PDF interaction tests with Chromium V8 coverage', [
  'node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.web.config.ts',
], { DSH_PDF_BROWSER_COVERAGE_DIR: browserDirectory, PDF_BENCH_CHROMIUM: browserExecutable })
await verifyFingerprint()
await run('map browser V8 coverage to project source', ['scripts/report-browser-coverage.mjs'], {
  DSH_PDF_BROWSER_COVERAGE_DIR: browserDirectory, DSH_PDF_BROWSER_COVERAGE_OUTPUT: browserLcov,
})
await run('instrumented native PDFium worker tests', ['scripts/coverage-native.mjs'], {
  DSH_PDF_NATIVE_COVERAGE_OUTPUT: nativeDirectory,
})
await verifyFingerprint()
await run('merge project-owned production source coverage', [
  'scripts/report-project-coverage.mjs', nodeLcov, browserLcov,
  join(nativeDirectory, 'coverage.lcov'), join(output, 'report.json'),
])
} catch (error) {
  coverageError = error
} finally {
  // Coverage instrumentation must never be left in the bundle the Desktop uses.
  try { await run('restore standard application build', ['scripts/build.mjs'], { DSH_PDF_BROWSER_COVERAGE: '0' }) }
  catch (error) {
    if (coverageError) console.error('Additionally failed to restore the standard application build:', error)
    else coverageError = error
  }
  console.log(`Project coverage artifacts: ${output}`)
}
if (coverageError) {
  console.error(`[coverage] ${coverageError instanceof Error ? coverageError.message : String(coverageError)}`)
  process.exitCode = 1
}
