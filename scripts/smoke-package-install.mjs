import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { archiveFile, nativePackageName, npmCli, targets } from './package-utils.mjs'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const usage = 'Usage: node scripts/smoke-package-install.mjs (--main <main.tgz> --native <current-platform-native.tgz> [--offline] | --package <name@exact-version>)'
const args = process.argv.slice(2)
if (args.includes('--help')) { console.log(usage); process.exit(0) }
const options = { offline: false }
for (let index = 0; index < args.length; index++) {
  const argument = args[index]
  if (argument === '--offline') options.offline = true
  else if (['--main', '--native', '--package'].includes(argument) && args[index + 1] && !args[index + 1].startsWith('--')) {
    const key = argument.slice(2)
    if (options[key]) throw new Error(`Duplicate ${argument}. ${usage}`)
    const value = args[++index]
    options[key] = key === 'package' ? value : resolve(value)
  } else throw new Error(`Unknown or incomplete argument ${argument}. ${usage}`)
}
if (options.package ? options.main || options.native || options.offline : !options.main || !options.native) throw new Error(usage)

const exact = options.package?.match(/^((?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*)@(\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?)$/)
if (options.package && !exact) throw new Error('Registry smoke requires a package name and exact version, not a tag or range')
const main = exact ? { name: exact[1], version: exact[2] }
  : JSON.parse(archiveFile(options.main, 'package/package.json').toString('utf8'))
const target = `${process.platform}-${process.arch}`
assert.ok(targets.includes(target), `Unsupported smoke-test platform: ${target}`)
const expectedNativeName = nativePackageName(main.name, target)
if (options.native) {
  const native = JSON.parse(archiveFile(options.native, 'package/package.json').toString('utf8'))
  assert.equal(native.name, expectedNativeName, 'The native archive must match this platform and main package name')
  assert.equal(native.version, main.version, 'Main and native archives must have exactly the same version')
  assert.deepEqual(native.os, [process.platform])
  assert.deepEqual(native.cpu, [process.arch])
}

// A fresh directory, npm extraction and no checkout links ensure the probe cannot
// accidentally validate the development checkout instead of published archives.
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'dsh-pdf-install-smoke-')))
const environment = { ...process.env, npm_config_update_notifier: 'false' }
for (const key of ['NODE_PATH', 'NODE_OPTIONS', 'NODE_V8_COVERAGE', 'DSH_PDF_NATIVE_HELPER']) delete environment[key]
const checked = async (command, argv, cwd, timeout = 60_000) => {
  try { return await execute(command, argv, { cwd, env: environment, windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }) }
  catch (error) { throw new Error(`${command} failed:\n${(error.stdout ?? '').slice(-6000)}${(error.stderr ?? '').slice(-6000)}\n${error.message}`, { cause: error }) }
}

try {
  await writeFile(join(temporary, 'package.json'), JSON.stringify({ name: 'pdf-package-install-smoke', private: true, type: 'module' }))
  await checked(process.execPath, [await npmCli(), 'install', '--ignore-scripts', '--no-audit', '--no-fund',
    '--package-lock=false', '--include=optional', '--registry=https://registry.npmjs.org/', ...(options.offline ? ['--offline'] : []),
    ...(options.package ? [options.package] : [options.main, options.native]), '@deepseek-ai/cordis@4.0.5'], temporary, 180_000)
  const installed = createRequire(join(temporary, 'package.json'))
  const mainFile = installed.resolve(`${main.name}/package.json`)
  const mainRoot = dirname(mainFile)
  const fromMain = createRequire(mainFile)
  const nativeFile = fromMain.resolve(`${expectedNativeName}/package.json`)
  const nativeRoot = dirname(nativeFile)
  const installedMain = JSON.parse(await readFile(mainFile, 'utf8'))
  const installedNative = JSON.parse(await readFile(nativeFile, 'utf8'))
  assert.equal(installedMain.name, main.name)
  assert.equal(installedMain.version, main.version)
  assert.equal(installedNative.name, expectedNativeName)
  assert.equal(installedNative.version, main.version)
  assert.deepEqual(installedNative.os, [process.platform])
  assert.deepEqual(installedNative.cpu, [process.arch])
  for (const platform of targets) assert.equal(installedMain.optionalDependencies?.[nativePackageName(main.name, platform)], main.version,
    `Missing exact optional dependency for ${platform}`)
  const scopeDirectory = main.name.startsWith('@')
    ? join(temporary, 'node_modules', main.name.split('/')[0]) : join(temporary, 'node_modules')
  const prefix = expectedNativeName.split('/').at(-1).replace(new RegExp(`${target}$`), '')
  const installedNativePackages = (await readdir(scopeDirectory)).filter(name => name.startsWith(prefix)).sort()
  assert.deepEqual(installedNativePackages, [expectedNativeName.split('/').at(-1)], 'Only this platform native package should be installed')
  await assert.rejects(readFile(join(mainRoot, 'native/dependencies.json')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(mainRoot, 'dist/native/manifest.json')), { code: 'ENOENT' })
  console.log(`[package-smoke] clean npm install: ${main.name}@${main.version}; native=${expectedNativeName}@${main.version}`)

  const probeFile = join(temporary, 'probe-native.mjs')
  await writeFile(probeFile, [
    "import assert from 'node:assert/strict'",
    `import { apply } from ${JSON.stringify(`${main.name}/native`)}`,
    'let executable',
    "await apply({ provide(name, value) { assert.equal(name, 'pdfNative'); executable = value.executable } })",
    "assert.equal(typeof executable, 'string')",
    'console.log(JSON.stringify({ executable }))',
  ].join('\n'))
  const { executable } = JSON.parse((await checked(process.execPath, [probeFile], temporary)).stdout)
  const expectedExecutable = join(nativeRoot, 'bin', `dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
  assert.equal(await realpath(executable), await realpath(expectedExecutable), 'The public provider must use the installed native dependency')
  const requestId = 'package-smoke-hello'
  const json = Buffer.from(JSON.stringify({ requestId, command: 'hello' }))
  const prefixBytes = Buffer.alloc(8)
  prefixBytes.writeUInt32LE(json.length, 0)
  const hello = spawnSync(executable, [], { cwd: dirname(executable), env: environment, windowsHide: true,
    input: Buffer.concat([prefixBytes, json]), timeout: 15_000, maxBuffer: 128 * 1024 })
  if (hello.error) throw hello.error
  assert.equal(hello.status, 0, `Installed native helper failed to start: ${hello.stderr?.toString('utf8')}`)
  const output = hello.stdout
  assert.ok(output.length >= 8, 'Native hello response must contain a framed header')
  const jsonLength = output.readUInt32LE(0)
  assert.equal(output.readUInt32LE(4), 0, 'Hello must not return a binary payload')
  assert.equal(output.length, 8 + jsonLength, 'Native hello must return exactly one complete frame')
  const reply = JSON.parse(output.subarray(8).toString('utf8'))
  const manifest = JSON.parse(await readFile(join(nativeRoot, 'bin/manifest.json'), 'utf8'))
  assert.equal(reply.requestId, requestId)
  assert.equal(reply.ok, true)
  assert.deepEqual(reply.value, { protocolVersion: 1, engine: 'pdfium', build: manifest.pdfiumVersion })
  console.log(`[package-smoke] public /native provider and real PDFium hello: ${target}, protocol=1, build=${reply.value.build}`)

  const compiler = join(root, 'node_modules/typescript/bin/tsc')
  for (const [entry, contract, service] of [
    ['ocr-host', 'HostOcrBackend', 'ocr'],
    ['image-host', 'ImageUnderstandingBackend', 'imageUnderstanding'],
    ['translation', 'TranslationEngine', 'pdfTranslation'],
    ['embedding', 'EmbeddingEngine', 'pdfEmbedding'],
  ]) {
    const consumer = join(temporary, `consumer-${entry}`)
    await mkdir(consumer)
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: `example-${entry}-plugin`, type: 'module' }))
    await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
      noEmit: true, skipLibCheck: true, types: [],
    }, include: ['index.ts'] }))
    await writeFile(join(consumer, 'index.ts'), [
      "import type { Context } from '@deepseek-ai/cordis'",
      `import type { ${contract} } from ${JSON.stringify(`${main.name}/${entry}`)}`,
      `declare const engine: ${contract}`,
      `export const inject = ['${service}']`,
      `export function apply(ctx: Context) { ctx.effect(() => ctx.${service}.register(engine)) }`,
    ].join('\n'))
    await checked(process.execPath, [compiler, '--project', join(consumer, 'tsconfig.json')], consumer)
    console.log(`[package-smoke] independent SDK consumer: ${main.name}/${entry} passed`)
  }
  console.log('[package-smoke] PASS: clean install, exact platform package, real native startup and four public SDKs')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
