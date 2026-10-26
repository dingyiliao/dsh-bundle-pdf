import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

const { verifyReleaseArtifacts, publishRelease, npmErrorCode } = await import(new URL('../scripts/publish-npm.mjs', import.meta.url).href)
const targets = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64']
const name = '@fixture/dsh-pdf'
const version = '9.8.7'
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
interface Entry { path: string; data: string; mode?: number; type?: string }
interface ReleasePackage { name: string; version: string; archive: string; integrity: string }

// A portable tar fixture preserves POSIX executable bits even when tests run on Windows.
function tarball(entries: Entry[]): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const header = Buffer.alloc(512)
    const data = Buffer.from(entry.data)
    header.write(entry.path, 0, 100)
    for (const [offset, length, value] of [[100, 8, entry.mode ?? 0o644], [108, 8, 0], [116, 8, 0], [124, 12, data.length], [136, 12, 0]]) {
      header.write(`${value!.toString(8).padStart(length! - 1, '0')}\0`, offset!, length!)
    }
    header.fill(0x20, 148, 156)
    header.write(entry.type ?? '0', 156, 1)
    header.write('ustar\0', 257, 6)
    header.write('00', 263, 2)
    header.write(`${header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0')}\0 `, 148, 8)
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512))
  }
  chunks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(chunks))
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-npm-publish-test-'))
  const artifacts = join(root, 'artifacts')
  await mkdir(artifacts)
  await mkdir(join(root, 'native'))
  const manifest = {
    name, version, type: 'module', license: 'MIT',
    exports: { '.': './dist/index.js', './native': './dist/native-provider.js', './package.json': './package.json' },
    optionalDependencies: Object.fromEntries(targets.map(target => [`${name}-native-${target}`, version])),
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
  await writeFile(join(root, 'native/dependencies.json'), JSON.stringify({
    pdfium: { version: '1.2.3', assets: Object.fromEntries(targets.map(target => [target, digest(target)])) },
  }))
  const packages = new Map<string, Entry[]>()
  packages.set(name, [
    { path: 'package/package.json', data: JSON.stringify(manifest) },
    ...['dist/index.js', 'dist/client.js', 'dist/native-provider.js', 'dist/THIRD_PARTY_NOTICES.md', 'cordis.patch.yml', 'LICENSE']
      .map(path => ({ path: `package/${path}`, data: 'fixture content' })),
  ])
  for (const target of targets) {
    const [os, cpu] = target.split('-')
    const executable = `dsh-pdf-native${os === 'win32' ? '.exe' : ''}`
    const library = os === 'win32' ? 'pdfium.dll' : os === 'darwin' ? 'libpdfium.dylib' : 'libpdfium.so'
    const metadata = { name: `${name}-native-${target}`, version, os: [os], cpu: [cpu],
      ...(os === 'linux' ? { libc: ['glibc'] } : {}), exports: { './package.json': './package.json' } }
    packages.set(metadata.name, [
      { path: 'package/package.json', data: JSON.stringify(metadata) },
      { path: 'package/LICENSE', data: 'license' },
      { path: `package/bin/${executable}`, data: `worker-${target}`, mode: 0o755 },
      { path: `package/bin/${library}`, data: `library-${target}` },
      { path: 'package/bin/manifest.json', data: JSON.stringify({ protocolVersion: 1, platform: target,
        pdfiumVersion: '1.2.3', sdkArchiveSha256: digest(target), executableSha256: digest(`worker-${target}`),
        librarySha256: digest(`library-${target}`) }) },
      ...['PDFIUM_LICENSE', 'JSON_LICENSE.MIT', 'licenses/third-party.txt'].map(path => ({ path: `package/bin/${path}`, data: 'license' })),
    ])
  }
  const archive = (packageName: string) => join(artifacts, `${packageName.replaceAll('/', '-').replace('@', '')}.tgz`)
  const save = async (packageName: string) => writeFile(archive(packageName), tarball(packages.get(packageName)!))
  for (const packageName of packages.keys()) await save(packageName)
  const updateMetadata = (packageName: string, update: (value: Record<string, unknown>) => void) => {
    const entry = packages.get(packageName)![0]!
    const metadata = JSON.parse(entry.data) as Record<string, unknown>
    update(metadata)
    entry.data = JSON.stringify(metadata)
  }
  return { root, artifacts, packages, archive, save, updateMetadata, dispose: () => rm(root, { recursive: true, force: true }) }
}

function plan(): ReleasePackage[] {
  return [...targets.map(target => `${name}-native-${target}`), name].map((packageName, index) => ({
    name: packageName, version, archive: `/fixture/${index}.tgz`, integrity: `sha512-${Buffer.alloc(64, index).toString('base64')}`,
  }))
}

test('release preflight validates all platform packages and orders the main package last', async () => {
  const data = await fixture()
  try {
    const checked = await verifyReleaseArtifacts(data.root, data.artifacts) as ReleasePackage[]
    assert.deepEqual(checked.map(item => item.name), plan().map(item => item.name))
    assert.ok(checked.every(item => item.version === version && /^sha512-[A-Za-z0-9+/]+=*$/.test(item.integrity)))
  } finally { await data.dispose() }
})

test('release preflight rejects incomplete, damaged, foreign-platform, non-executable and scripted archives', async t => {
  for (const scenario of ['missing', 'checksum', 'platform', 'permissions', 'scripts', 'dependency', 'link'] as const) {
    await t.test(scenario, async () => {
      const data = await fixture()
      const native = `${name}-native-linux-x64`
      try {
        if (scenario === 'missing') await unlink(data.archive(native))
        if (scenario === 'checksum') data.packages.get(native)!.find(entry => entry.path.endsWith('/dsh-pdf-native'))!.data = 'changed bytes'
        if (scenario === 'platform') data.updateMetadata(native, metadata => { metadata.cpu = ['arm64'] })
        if (scenario === 'permissions') data.packages.get(native)!.find(entry => entry.path.endsWith('/dsh-pdf-native'))!.mode = 0o644
        if (scenario === 'scripts') data.updateMetadata(name, metadata => { metadata.scripts = { postinstall: 'download native files' } })
        if (scenario === 'dependency') data.updateMetadata(name, metadata => {
          (metadata.optionalDependencies as Record<string, string>)[`${name}-native-linux-x64`] = '9.8.6'
        })
        if (scenario === 'link') data.packages.get(name)!.push({ path: 'package/dist/link', type: '2', data: '' })
        if (scenario !== 'missing') {
          await data.save(native)
          await data.save(name)
        }
        await assert.rejects(verifyReleaseArtifacts(data.root, data.artifacts),
          /Missing release archive|integrity|platform|executable|lifecycle scripts|must pin|links or special files/)
      } finally { await data.dispose() }
    })
  }
})

test('publisher finishes all registry checks before writing and publishes native packages before main', async () => {
  const release = plan()
  const writes: string[] = []
  let reads = 0
  await publishRelease(release, {
    lookup: async () => { reads++; return null },
    publish: async (item: ReleasePackage, dryRun: boolean) => { assert.equal(reads, release.length); assert.equal(dryRun, false); writes.push(item.name) },
    log: () => {},
  })
  assert.deepEqual(writes, release.map(item => item.name))
})

test('publisher skips byte-identical versions and rejects any existing content conflict before writing', async () => {
  const release = plan()
  const writes: string[] = []
  await publishRelease(release, {
    lookup: async (item: ReleasePackage) => item === release[0] ? item.integrity : null,
    publish: async (item: ReleasePackage) => { writes.push(item.name) }, log: () => {},
  })
  assert.deepEqual(writes, release.slice(1).map(item => item.name))
  writes.length = 0
  await assert.rejects(publishRelease(release, {
    lookup: async (item: ReleasePackage) => item === release.at(-1) ? 'sha512-different' : null,
    publish: async (item: ReleasePackage) => { writes.push(item.name) }, log: () => {},
  }), /Published content differs/)
  assert.deepEqual(writes, [])
})

test('registry network/authentication errors never become an absent version', async () => {
  let writes = 0
  await assert.rejects(publishRelease(plan(), {
    lookup: async () => { throw new Error('ECONNRESET: registry request failed; E404 was not returned') },
    publish: async () => { writes++ }, log: () => {},
  }), /ECONNRESET/)
  assert.equal(writes, 0)
  assert.equal(npmErrorCode({ stdout: JSON.stringify({ error: { code: 'E404' } }), code: 1 }), 'E404')
  assert.equal(npmErrorCode({ stderr: 'A message mentioning E404', code: 'ECONNRESET' }), 'ECONNRESET')
  assert.equal(npmErrorCode({ stderr: JSON.stringify({ error: { code: 'E401' } }), code: 1 }), 'E401')
  assert.equal(npmErrorCode({ stdout: 'example-token-should-not-be-displayed', code: 1 }), 'UNKNOWN')
})

test('publisher recovers a lost success response only after verifying the exact remote integrity', async () => {
  const release = plan()
  const remote = new Map<string, string>()
  const writes: string[] = []
  const logs: string[] = []
  await publishRelease(release, {
    lookup: async (item: ReleasePackage) => remote.get(item.name) ?? null,
    publish: async (item: ReleasePackage) => {
      writes.push(item.name)
      remote.set(item.name, item.integrity)
      if (item === release[0]) throw new Error('response lost')
    }, log: (message: string) => { logs.push(message) },
  })
  assert.deepEqual(writes, release.map(item => item.name))
  assert.match(logs[0]!, /Verified after publish response failure/)
  await assert.rejects(publishRelease(release, {
    lookup: async () => null, publish: async () => { throw new Error('publish denied') }, log: () => {},
  }), /publish denied/)
})

test('dry run forwards the dry-run flag and stops on validation failure without retrying a write', async () => {
  const flags: boolean[] = []
  await publishRelease(plan(), { dryRun: true, lookup: async () => null,
    publish: async (_item: ReleasePackage, dryRun: boolean) => { flags.push(dryRun) }, log: () => {} })
  assert.deepEqual(flags, Array(6).fill(true))
  let reads = 0
  await assert.rejects(publishRelease(plan(), { dryRun: true, lookup: async () => { reads++; return null },
    publish: async () => { throw new Error('dry-run rejected') }, log: () => {} }), /dry-run rejected/)
  assert.equal(reads, 6)
})

test('publisher CLI rejects incomplete arguments before touching artifacts or the registry', () => {
  const script = fileURLToPath(new URL('../scripts/publish-npm.mjs', import.meta.url))
  assert.throws(() => execFileSync(process.execPath, [script, '--artifacts', '--dry-run'], { stdio: 'pipe' }),
    /Unknown or incomplete argument/)
  assert.throws(() => execFileSync(process.execPath, [script, '--dryrun'], { stdio: 'pipe' }),
    /Unknown or incomplete argument/)
})
