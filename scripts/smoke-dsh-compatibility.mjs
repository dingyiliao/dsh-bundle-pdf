import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { nativePackageName } from './package-utils.mjs'

const execute = promisify(execFile)
const usage = 'Usage: node scripts/smoke-dsh-compatibility.mjs --package <name@exact-version> [--app <installed Desktop.app>]'
const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--help') {
  console.log(usage)
  process.exit(0)
}
const options = new Map()
for (let index = 0; index < args.length; index += 2) {
  const [key, value] = args.slice(index, index + 2)
  if (!['--package', '--app'].includes(key) || !value || value.startsWith('--') || options.has(key)) throw new Error(usage)
  options.set(key, value)
}
const spec = options.get('--package')
const match = spec?.match(/^((?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/)
if (!match) throw new Error(usage)
if (process.platform !== 'darwin') throw new Error('This check requires the installed macOS DeepSeek Harness Desktop application')
const [, name, version] = match
const app = await realpath(resolve(options.get('--app') ?? '/Applications/DeepSeek Harness.app'))
const resources = join(app, 'Contents', 'Resources')
const cli = join(resources, 'runtime', 'cli', 'bin', 'dsh')
const electron = join(app, 'Contents', 'MacOS', 'DeepSeek Harness')

// Initialize and load the same profile format through the installed Desktop runtime.
const profileProbe = `
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const [resources, profile, plugin] = process.argv.slice(1)
const packages = join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai')
const runtime = name => import(pathToFileURL(join(packages, name, 'lib', 'index.js')).href)
const boot = await runtime('dsh-app-boot')
if (!plugin) {
  const { PROFILE_TEMPLATES } = await runtime('dsh-official-bundles')
  boot.initProfile(profile, PROFILE_TEMPLATES.web.bundles)
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch }))
} else {
  const loaded = boot.loadProfileDirectory('dsh', profile, join(packages, 'dsh', 'package.json'))
  assert.ok(loaded.layers.some(layer => layer.packageName === plugin), JSON.stringify(loaded.skippedBundles))
  const entries = boot.composeEntries([...loaded.layers.map(layer => layer.patches), loaded.patches])
  for (const id of ['pdf-native', 'pdf-ocr', 'pdf-image-understanding', 'pdf-reader']) {
    assert.ok(entries.some(entry => entry.id === id && !entry.disabled), 'Desktop profile is missing ' + id)
  }
}`

const temporary = await realpath(await mkdtemp(join(tmpdir(), 'dsh-pdf-desktop-compatibility-')))
const home = join(temporary, 'dsh-home')
const profile = join(home, 'profiles', 'desktop')
const modules = join(profile, 'node_modules')
const npmrc = join(temporary, '.npmrc')
const env = { ...process.env, DSH_HOME: home, npm_config_userconfig: npmrc }
for (const key of ['NODE_PATH', 'NODE_OPTIONS', 'NODE_V8_COVERAGE', 'DSH_PDF_NATIVE_HELPER']) delete env[key]
async function run(label, executable, argv, timeout = 60_000, extraEnv = {}) {
  try { return await execute(executable, argv, { cwd: temporary, env: { ...env, ...extraEnv }, timeout, maxBuffer: 8 * 1024 * 1024 }) }
  catch (error) {
    const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`.trim().slice(-12_000)
    throw new Error(`${label} failed (${error.code ?? error.signal ?? 'unknown'}):\n${output || error.message}`)
  }
}
const inspectProfile = (...argv) => run('Installed Desktop profile', electron,
  ['--expose-internals', '--input-type=module', '-e', profileProbe, resources, profile, ...argv], 60_000,
  { ELECTRON_RUN_AS_NODE: '1' })

async function verifyInstalledPackage(file, expectedName) {
  const path = relative(await realpath(modules), await realpath(file))
  assert.ok(path && !path.startsWith('..') && !isAbsolute(path), `${expectedName} resolved outside the isolated profile`)
  const manifest = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(manifest.name, expectedName)
  assert.equal(manifest.version, version)
}

try {
  await writeFile(npmrc, '')
  const runtimeVersion = (await run('Installed Desktop version', cli, ['--version'])).stdout.trim()
  console.log(`[dsh-compatibility] Installed Desktop ${runtimeVersion} at ${app}`)
  const { platform, arch } = JSON.parse((await inspectProfile()).stdout)
  console.log(`[dsh-compatibility] Installing ${spec} from npm through the Desktop CLI`)
  await run('Desktop plugin admission', cli, ['plugin', '--profile', 'desktop', 'add', spec, '--save-exact',
    '--ignore-scripts', '--registry=https://registry.npmjs.org/'], 240_000)
  const main = join(modules, name, 'package.json')
  await verifyInstalledPackage(main, name)
  const nativeName = nativePackageName(name, `${platform}-${arch}`)
  await verifyInstalledPackage(createRequire(main).resolve(`${nativeName}/package.json`), nativeName)
  await inspectProfile(name)
  console.log(`[dsh-compatibility] PASS: Desktop ${runtimeVersion} admitted ${spec} and composed its PDF profile`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
