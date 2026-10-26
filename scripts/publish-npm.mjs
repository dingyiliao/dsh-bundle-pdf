import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { archiveCommand, archiveFile, nativePackageName, npmCli, readPackage, releasePackage, sha256, targets } from './package-utils.mjs'

const registry = 'https://registry.npmjs.org'
const execute = promisify(execFile)
const sameIntegrity = (actual, expected) => typeof actual === 'string' && actual.trim().split(/\s+/).includes(expected)

function checkDependencies(metadata, main) {
  for (const target of targets) {
    if (metadata.optionalDependencies?.[nativePackageName(main.name, target)] !== main.version) {
      throw new Error(`${metadata.name} must pin all five native packages to ${main.version}`)
    }
  }
}

function checkPublicMetadata(metadata) {
  if (metadata.private === true || metadata.scripts && Object.keys(metadata.scripts).length) {
    throw new Error(`${metadata.name} must be public and contain no lifecycle scripts`)
  }
  if (metadata.publishConfig?.registry && metadata.publishConfig.registry.replace(/\/$/, '') !== registry) {
    throw new Error(`${metadata.name} targets a different registry`)
  }
  if (metadata.publishConfig?.access && metadata.publishConfig.access !== 'public') {
    throw new Error(`${metadata.name} is not configured for public access`)
  }
}

function inspectMembers(archive) {
  const paths = archiveCommand(archive, '-tf').toString('utf8')
    .trim().split(/\r?\n/).filter(Boolean)
  for (const path of paths) {
    const parts = path.replace(/\/$/, '').split('/')
    if (parts[0] !== 'package' || parts.some(part => !part || part.startsWith('.') || part.includes('\\'))) {
      throw new Error(`Unsafe archive path in ${basename(archive)}`)
    }
  }
  const verbose = archiveCommand(archive, '-tvf').toString('utf8')
    .trim().split(/\r?\n/).filter(Boolean)
  if (verbose.some(line => !/^[-d]/.test(line))) throw new Error(`Archive contains links or special files: ${basename(archive)}`)
  const files = paths.filter(path => !path.endsWith('/'))
  if (new Set(files).size !== files.length || !files.includes('package/package.json')) {
    throw new Error(`Invalid archive entries: ${basename(archive)}`)
  }
  return { files, verbose }
}

async function verifyNative(archive, metadata, target, lock) {
  const { files, verbose } = inspectMembers(archive)
  const [os, cpu] = target.split('-')
  if (JSON.stringify(metadata.os) !== JSON.stringify([os]) || JSON.stringify(metadata.cpu) !== JSON.stringify([cpu])
      || JSON.stringify(metadata.libc) !== JSON.stringify(os === 'linux' ? ['glibc'] : undefined)
      || metadata.exports?.['./package.json'] !== './package.json') {
    throw new Error(`Wrong native package platform or exports: ${metadata.name}`)
  }
  if (metadata.bin || ['dependencies', 'optionalDependencies', 'devDependencies'].some(key => metadata[key] && Object.keys(metadata[key]).length)) {
    throw new Error(`Native package must contain no extra dependencies or commands: ${metadata.name}`)
  }
  const executable = `dsh-pdf-native${os === 'win32' ? '.exe' : ''}`
  const library = os === 'win32' ? 'pdfium.dll' : os === 'darwin' ? 'libpdfium.dylib' : 'libpdfium.so'
  const required = ['package/package.json', 'package/LICENSE', 'package/bin/manifest.json',
    `package/bin/${executable}`, `package/bin/${library}`, 'package/bin/PDFIUM_LICENSE', 'package/bin/JSON_LICENSE.MIT']
  if (required.some(path => !files.includes(path)) || !files.some(path => path.startsWith('package/bin/licenses/'))
      || files.some(path => !required.includes(path) && !path.startsWith('package/bin/licenses/'))) {
    throw new Error(`Incomplete or unexpected native files: ${metadata.name}`)
  }
  const manifest = JSON.parse(archiveFile(archive, 'package/bin/manifest.json').toString('utf8'))
  if (manifest.protocolVersion !== 1 || manifest.platform !== target || manifest.pdfiumVersion !== lock.pdfium.version
      || manifest.sdkArchiveSha256 !== lock.pdfium.assets[target]
      || sha256(archiveFile(archive, `package/bin/${executable}`)) !== manifest.executableSha256
      || sha256(archiveFile(archive, `package/bin/${library}`)) !== manifest.librarySha256) {
    throw new Error(`Native integrity or SDK pin mismatch: ${metadata.name}`)
  }
  if (os !== 'win32') {
    const mode = verbose.find(line => line.endsWith(` package/bin/${executable}`))?.slice(0, 10)
    if (!mode || ![3, 6, 9].some(index => 'xst'.includes(mode[index]))) throw new Error(`Native worker is not executable: ${metadata.name}`)
  }
}

function verifyMain(archive, metadata, main) {
  const { files } = inspectMembers(archive)
  checkDependencies(metadata, main)
  for (const key of ['exports', 'dsh', 'dependencies', 'peerDependencies', 'peerDependenciesMeta', 'engines', 'os', 'cpu', 'libc', 'bin']) {
    if (JSON.stringify(metadata[key]) !== JSON.stringify(main[key])) throw new Error(`Main package ${key} differs from the release manifest`)
  }
  if (files.some(path => /^package\/(?:src|native|tests|node_modules)\//.test(path) || path.startsWith('package/dist/native/')
      || path.endsWith('.map') || /\.(?:tsx?|cpp|cc|h|hpp)$/.test(path) && !path.endsWith('.d.ts')
      || /(?:^|\/)(?:credentials?|secrets?|tokens?)\.(?:json|txt)$/.test(path) || /\.(?:pem|key)$/.test(path))) {
    throw new Error('Main package contains source, native binaries, credentials or temporary files')
  }
  const publicFiles = Object.values(metadata.exports ?? {}).flatMap(value => typeof value === 'string' ? [value]
    : value && typeof value === 'object' ? Object.values(value) : [])
  for (const path of [...publicFiles, './dist/index.js', './dist/client.js', './dist/THIRD_PARTY_NOTICES.md', './cordis.patch.yml']) {
    if (typeof path !== 'string' || !path.startsWith('./')) throw new Error('Invalid public package export')
    if (path.includes('*')) {
      const [start, end] = `package/${path.slice(2)}`.split('*')
      if (!files.some(file => file.startsWith(start) && file.endsWith(end))) throw new Error(`Main package is missing ${path}`)
    } else if (!files.includes(`package/${path.slice(2)}`)) throw new Error(`Main package is missing ${path}`)
  }
}

/** Validate the entire release before any registry write can take place. */
export async function verifyReleaseArtifacts(root, directory = join(root, 'artifacts')) {
  const main = releasePackage(await readPackage(root))
  if (main.private === true) throw new Error('The release manifest is private')
  checkDependencies(main, main)
  const lock = JSON.parse(await readFile(join(root, 'native/dependencies.json'), 'utf8'))
  const expected = [...targets.map(target => ({ name: nativePackageName(main.name, target), target })), { name: main.name }]
  const selected = new Map()
  for (const filename of (await readdir(directory)).filter(path => path.endsWith('.tgz'))) {
    const archive = join(directory, filename)
    inspectMembers(archive)
    const metadata = JSON.parse(archiveFile(archive, 'package/package.json').toString('utf8'))
    if (metadata.version !== main.version || !expected.some(item => item.name === metadata.name)) continue
    if (selected.has(metadata.name)) throw new Error(`Duplicate release archive for ${metadata.name}@${main.version}`)
    selected.set(metadata.name, { archive, metadata })
  }
  const plan = []
  for (const item of expected) {
    const artifact = selected.get(item.name)
    if (!artifact) throw new Error(`Missing release archive for ${item.name}@${main.version}`)
    checkPublicMetadata(artifact.metadata)
    if (item.target) await verifyNative(artifact.archive, artifact.metadata, item.target, lock)
    else verifyMain(artifact.archive, artifact.metadata, main)
    plan.push({ name: item.name, version: main.version, archive: artifact.archive,
      integrity: `sha512-${createHash('sha512').update(await readFile(artifact.archive)).digest('base64')}` })
  }
  return plan
}

/** Only a structured npm E404 means that a version does not exist. */
export function npmErrorCode(error) {
  for (const text of [error?.stdout, error?.stderr]) {
    try {
      const result = JSON.parse(String(text))
      if (typeof result.error?.code === 'string' && /^E[A-Z0-9_]{1,30}$/.test(result.error.code)) return result.error.code
    } catch {}
  }
  return typeof error?.code === 'string' && /^E[A-Z0-9_]{1,30}$/.test(error.code) ? error.code : 'UNKNOWN'
}

export async function npmRegistryClient() {
  const cli = await npmCli()
  const run = args => execute(process.execPath, [cli, ...args], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 300_000,
    env: { ...process.env, npm_config_update_notifier: 'false' },
  })
  return {
    async lookup(item) {
      let result
      try { result = await run(['view', `${item.name}@${item.version}`, 'dist.integrity', '--json', '--registry', registry]) }
      catch (error) {
        const code = npmErrorCode(error)
        if (code === 'E404') return null
        throw new Error(`Registry lookup failed for ${item.name}@${item.version} (${code})`)
      }
      let integrity
      try { integrity = JSON.parse(result.stdout) } catch {}
      if (typeof integrity !== 'string' || !integrity.split(/\s+/).some(value => value.startsWith('sha512-'))) {
        throw new Error(`Published version has no usable SHA512 integrity: ${item.name}@${item.version}`)
      }
      return integrity
    },
    async publish(item, dryRun) {
      try {
        await run(['publish', item.archive, '--ignore-scripts', '--access', 'public', '--json', '--registry', registry,
          `--dry-run=${dryRun ? 'true' : 'false'}`])
      } catch (error) {
        throw new Error(`npm publish failed for ${item.name}@${item.version} (${npmErrorCode(error)}); check npm authentication and publish permissions`)
      }
    },
  }
}

/** Registry and publish ports keep retry/error policy testable without network writes. */
export async function publishRelease(plan, { lookup, publish, dryRun = false, log = console.log }) {
  const existing = await Promise.all(plan.map(item => lookup(item)))
  for (const [index, item] of plan.entries()) {
    if (existing[index] !== null && !sameIntegrity(existing[index], item.integrity)) {
      throw new Error(`Published content differs from the local archive: ${item.name}@${item.version}; use a new version`)
    }
  }
  for (const [index, item] of plan.entries()) {
    if (existing[index] !== null) { log(`Unchanged: ${item.name}@${item.version}`); continue }
    try { await publish(item, dryRun) }
    catch (error) {
      if (dryRun) throw error
      const observed = await lookup(item)
      if (observed !== null && sameIntegrity(observed, item.integrity)) {
        log(`Verified after publish response failure: ${item.name}@${item.version}`)
        continue
      }
      throw error
    }
    log(`${dryRun ? 'Dry run passed' : 'Published'}: ${item.name}@${item.version}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL('../', import.meta.url))
    let directory = join(root, 'artifacts')
    let dryRun = ['true', '1'].includes(process.env.npm_config_dry_run ?? process.env.NPM_CONFIG_DRY_RUN ?? '')
    for (let index = 2; index < process.argv.length; index++) {
      const argument = process.argv[index]
      if (argument === '--dry-run') dryRun = true
      else if (argument === '--artifacts' && process.argv[index + 1] && !process.argv[index + 1].startsWith('-')) directory = resolve(process.argv[++index])
      else throw new Error(`Unknown or incomplete argument: ${argument}`)
    }
    const plan = await verifyReleaseArtifacts(root, directory)
    console.log(`Release preflight passed: ${plan.length} packages for ${plan.at(-1).name}@${plan.at(-1).version}`)
    await publishRelease(plan, { ...await npmRegistryClient(), dryRun })
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'npm release failed')
    process.exitCode = 1
  }
}
