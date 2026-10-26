import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'

export const targets = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64']
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const packageStem = name => name.replace(/^@/, '').replaceAll('/', '-')
export const nativePackageName = (name, target) => `${name}-native-${target}`

/** Native dependencies belong to the published package, not the source-build bootstrap. */
export function releasePackage(pkg) {
  const dependencies = Object.fromEntries(targets.map(target => [nativePackageName(pkg.name, target), pkg.version]))
  for (const [name, version] of Object.entries(dependencies)) {
    if (pkg.optionalDependencies?.[name] !== undefined && pkg.optionalDependencies[name] !== version) {
      throw new Error(`The main package must pin ${name} to ${version}`)
    }
  }
  return { ...pkg, optionalDependencies: { ...pkg.optionalDependencies, ...dependencies } }
}

export async function readPackage(root) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (typeof pkg.name !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(pkg.name)
      || typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/.test(pkg.version)) {
    throw new Error('A valid package name and exact version are required')
  }
  return pkg
}

export async function filesIn(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true })
  const result = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error(`Published packages cannot contain symlinks: ${path}`)
    if (entry.isDirectory()) result.push(...await filesIn(join(directory, entry.name), path))
    else if (entry.isFile()) result.push(path)
    else throw new Error(`Published packages cannot contain special files: ${path}`)
  }
  return result
}

export async function copyTree(source, destination, include = () => true, prefix = '') {
  const info = await lstat(source)
  if (info.isSymbolicLink()) throw new Error(`Published packages cannot contain symlinks: ${prefix}`)
  if (!include(prefix)) return
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true })
    for (const name of await readdir(source)) {
      await copyTree(join(source, name), join(destination, name), include, prefix ? `${prefix}/${name}` : name)
    }
  } else if (info.isFile()) {
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
  } else throw new Error(`Published packages cannot contain special files: ${prefix}`)
}

export async function npmCli() {
  const candidates = [process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')]
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    try { candidates.push(await realpath(join(directory, process.platform === 'win32' ? 'npm.cmd' : 'npm'))) } catch {}
    candidates.push(join(directory, 'node_modules/npm/bin/npm-cli.js'))
  }
  for (const candidate of candidates) {
    if (!candidate || !candidate.endsWith('.js')) continue
    try { if ((await lstat(candidate)).isFile()) return candidate } catch {}
  }
  throw new Error('Cannot locate npm-cli.js; run packaging from an npm script or install npm alongside Node')
}

export function archiveContents(archive) {
  return execFileSync('tar', ['-tf', archive], { maxBuffer: 16 * 1024 * 1024 })
    .toString('utf8').trim().split(/\r?\n/).filter(path => !path.endsWith('/'))
}

export function archiveFile(archive, path) {
  return execFileSync('tar', ['-xOf', archive, path], { maxBuffer: 64 * 1024 * 1024 })
}

/** Pack an isolated allowlisted stage and verify every shipped byte against it. */
export async function packVerified(root, metadata, prepare, suffix) {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-pdf-package-'))
  const stage = join(temporary, 'package')
  const output = join(root, 'artifacts')
  try {
    await mkdir(stage)
    await prepare(stage)
    await writeFile(join(stage, 'package.json'), `${JSON.stringify(metadata, null, 2)}\n`)
    const expected = await filesIn(stage)
    await mkdir(output, { recursive: true })
    const packed = JSON.parse(execFileSync(process.execPath,
      [await npmCli(), 'pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', temporary], {
        cwd: stage, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, npm_config_cache: join(temporary, 'cache'), npm_config_update_notifier: 'false' },
      }).toString('utf8'))
    if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0].filename !== 'string'
        || packed[0].filename.includes('/') || packed[0].filename.includes('\\')) throw new Error('npm pack returned an invalid archive')
    const archive = join(temporary, packed[0].filename)
    const contents = archiveContents(archive)
    if (contents.length !== expected.length || new Set(contents).size !== contents.length
        || contents.some(path => !expected.includes(path.replace(/^package\//, '')) || !path.startsWith('package/'))) {
      throw new Error('npm archive contains missing or unexpected files')
    }
    const extracted = join(temporary, 'extracted')
    await mkdir(extracted)
    execFileSync('tar', ['-xf', archive, '-C', extracted], { maxBuffer: 1024 * 1024 })
    const unpacked = join(extracted, 'package')
    await filesIn(unpacked)
    for (const path of expected) {
      if (sha256(await readFile(join(unpacked, path))) !== sha256(await readFile(join(stage, path)))) {
        throw new Error(`npm archive changed ${path}`)
      }
      if (process.platform !== 'win32' && ((await lstat(join(stage, path))).mode & 0o111)
          && !((await lstat(join(unpacked, path))).mode & 0o111)) throw new Error(`npm archive lost executable permissions: ${path}`)
    }
    const destination = join(output, `${packageStem(metadata.name)}-${metadata.version}-${suffix}.tgz`)
    await rename(archive, destination)
    console.log(`Verified publishable npm package: ${relative(root, destination)}`)
    return destination
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
