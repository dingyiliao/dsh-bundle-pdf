import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repository = new URL('../', import.meta.url)
const target = `${process.platform}-${process.arch}`
const targets = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64']
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const executable = `dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`
const library = process.platform === 'win32' ? 'pdfium.dll' : process.platform === 'darwin' ? 'libpdfium.dylib' : 'libpdfium.so'

async function fixture(parent = tmpdir()) {
  const root = await mkdtemp(join(parent, 'dsh-npm-package-test-'))
  const manifest = {
    name: '@fixture/dsh-pdf', version: '9.8.7', type: 'module', license: 'MIT',
    exports: { '.': './dist/index.js', './native': './dist/native-provider.js',
      './embedding': { types: './dist/types/embedding/index.d.ts', import: './dist/embedding.js' },
      './package.json': './package.json', './locale/*.json': './locale/*.json' },
    files: ['dist', 'locale', 'docs/ENGINE_EXTENSIONS.md', 'README.md', 'README.zh.md', 'LICENSE',
      'cordis.patch.yml', 'icon.svg', 'scripts/local-embedding-server.py'],
    optionalDependencies: Object.fromEntries(targets.map(platform => [`@fixture/dsh-pdf-native-${platform}`, '9.8.7'])),
    devDependencies: { typescript: '^5.9.0' },
    scripts: { prepack: 'node -e "throw new Error(\'must not run\')"' },
  }
  const write = async (path: string, value: string) => {
    const filename = join(root, path)
    await mkdir(dirname(filename), { recursive: true })
    await writeFile(filename, value)
  }
  for (const script of ['package-native.mjs', 'package-main.mjs', 'package-utils.mjs']) {
    await mkdir(join(root, 'scripts'), { recursive: true })
    await copyFile(new URL(`scripts/${script}`, repository), join(root, 'scripts', script))
  }
  await write('package.json', JSON.stringify(manifest))
  for (const path of ['dist/index.js', 'dist/native-provider.js', 'dist/client.js', 'dist/embedding.js']) {
    await write(path, 'export const ready = true\n')
  }
  await write('dist/types/embedding/index.d.ts', 'export interface Engine { id: string }\n')
  await write('dist/THIRD_PARTY_NOTICES.md', 'Third-party notices\n')
  await write('locale/en.json', '{}')
  await write('docs/ENGINE_EXTENSIONS.md', '# Engine extensions\n')
  for (const path of ['README.md', 'README.zh.md', 'LICENSE', 'cordis.patch.yml', 'icon.svg', 'scripts/local-embedding-server.py']) {
    await write(path, `fixture ${path}\n`)
  }
  await write(`dist/native/${executable}`, 'worker bytes')
  await chmod(join(root, `dist/native/${executable}`), 0o755)
  await write(`dist/native/${library}`, 'PDFium bytes')
  await write('dist/native/PDFIUM_LICENSE', 'PDFium license')
  await write('dist/native/JSON_LICENSE.MIT', 'JSON license')
  await write('dist/native/licenses/third-party.txt', 'Additional license')
  await write('native/dependencies.json', JSON.stringify({ pdfium: { version: '1.2.3', assets: { [target]: 'sdk-pin' } } }))
  await write('dist/native/manifest.json', JSON.stringify({ protocolVersion: 1, platform: target,
    pdfiumVersion: '1.2.3', sdkArchiveSha256: 'sdk-pin', executableSha256: digest('worker bytes'),
    librarySha256: digest('PDFium bytes') }))
  return {
    root, manifest, write,
    saveManifest: () => write('package.json', JSON.stringify(manifest)),
    pack: (kind: 'main' | 'native', platform = target) => execFileSync(process.execPath,
      [join(root, `scripts/package-${kind}.mjs`), ...(kind === 'native' ? [platform] : [])],
      { cwd: root, stdio: 'pipe', timeout: 60_000 }).toString('utf8'),
    archive: async () => {
      const names = (await readdir(join(root, 'artifacts'))).filter(name => name.endsWith('.tgz'))
      assert.equal(names.length, 1)
      return join(root, 'artifacts', names[0]!)
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  }
}

function entries(archive: string): string[] {
  return execFileSync('tar', ['-tf', archive]).toString('utf8').trim().split(/\r?\n/).filter(path => !path.endsWith('/'))
}

function member(archive: string, path: string): Buffer {
  return execFileSync('tar', ['-xOf', archive, `package/${path}`])
}

test('main npm package retains its SDK and exact platform dependencies without shipping native files or development tools', async () => {
  const data = await fixture()
  try {
    await data.write('src/private.ts', 'source code')
    await data.write('.npmrc', '//registry.npmjs.org/:_authToken=example-not-a-real-token')
    await data.write('.env', 'SECRET=example')
    await data.write('notes.txt', 'untracked file')
    assert.match(data.pack('main'), /Verified publishable npm package/)
    const archive = await data.archive()
    assert.match(archive, /-main\.tgz$/)
    const paths = entries(archive)
    assert.ok(paths.includes('package/dist/types/embedding/index.d.ts'))
    assert.ok(paths.includes('package/dist/client.js'))
    assert.ok(paths.includes('package/docs/ENGINE_EXTENSIONS.md'))
    assert.equal(paths.some(path => /(?:\/native\/|\/src\/|node_modules|\.npmrc|\.env|notes\.txt)/.test(path)), false)
    const metadata = JSON.parse(member(archive, 'package.json').toString('utf8')) as Record<string, unknown>
    assert.deepEqual(metadata.exports, data.manifest.exports)
    assert.deepEqual(metadata.optionalDependencies, data.manifest.optionalDependencies)
    assert.equal(metadata.scripts, undefined)
    assert.equal(metadata.devDependencies, undefined)
    assert.equal(metadata.private, undefined)
    assert.equal(await readFile(join(data.root, 'dist/native', executable), 'utf8'), 'worker bytes', 'staging must preserve the development native build')
  } finally { await data.dispose() }
})

test('a source checkout can bootstrap without unpublished packages while its packed main pins every native dependency', async () => {
  const data = await fixture()
  try {
    const { optionalDependencies, ...source } = data.manifest
    await data.write('package.json', JSON.stringify(source))
    data.pack('main')
    const packed = JSON.parse(member(await data.archive(), 'package.json').toString('utf8'))
    assert.deepEqual(packed.optionalDependencies, optionalDependencies)
    assert.equal(JSON.parse(await readFile(join(data.root, 'package.json'), 'utf8')).optionalDependencies, undefined,
      'packing must not make source installs depend on their own unpublished native output')
  } finally { await data.dispose() }
})

test('packaging can write archives into the checkout volume when system TEMP is elsewhere', async () => {
  const parent = join(fileURLToPath(repository), '.test-output')
  await mkdir(parent, { recursive: true })
  const data = await fixture(parent)
  try {
    data.pack('native')
    const archive = await data.archive()
    assert.equal(member(archive, `bin/${executable}`).toString('utf8'), 'worker bytes')
    assert.equal(member(archive, `bin/${library}`).toString('utf8'), 'PDFium bytes')
  } finally { await data.dispose() }
})

test('native npm package carries the matching worker, library, integrity manifest and all licenses only', async () => {
  const data = await fixture()
  try {
    data.pack('native')
    const archive = await data.archive()
    assert.ok(archive.endsWith(`-${target}-native.tgz`))
    const metadata = JSON.parse(member(archive, 'package.json').toString('utf8')) as {
      name: string; version: string; os: string[]; cpu: string[]; libc?: string[]; scripts?: unknown
    }
    assert.equal(metadata.name, `@fixture/dsh-pdf-native-${target}`)
    assert.equal(metadata.version, data.manifest.version)
    assert.deepEqual(metadata.os, [process.platform])
    assert.deepEqual(metadata.cpu, [process.arch])
    assert.deepEqual(metadata.libc, process.platform === 'linux' ? ['glibc'] : undefined)
    assert.equal(metadata.scripts, undefined)
    assert.deepEqual(entries(archive).sort(), ['package/package.json', 'package/LICENSE',
      `package/bin/${executable}`, `package/bin/${library}`, 'package/bin/manifest.json',
      'package/bin/PDFIUM_LICENSE', 'package/bin/JSON_LICENSE.MIT', 'package/bin/licenses/third-party.txt'].sort())
    assert.equal(member(archive, `bin/${executable}`).toString('utf8'), 'worker bytes')
    assert.equal(member(archive, `bin/${library}`).toString('utf8'), 'PDFium bytes')
  } finally { await data.dispose() }
})

test('packaging rejects invalid dependencies, absent exports, unsafe allowlists and leaked credentials', async t => {
  for (const scenario of ['dependency', 'export', 'allowlist', 'credentials'] as const) {
    await t.test(scenario, async () => {
      const data = await fixture()
      try {
        if (scenario === 'dependency') data.manifest.optionalDependencies[`@fixture/dsh-pdf-native-${target}`] = '9.8.6'
        if (scenario === 'export') data.manifest.exports['.'] = './dist/missing.js'
        if (scenario === 'allowlist') data.manifest.files.push('src')
        if (scenario === 'credentials') await data.write('dist/.npmrc', 'example credential')
        await data.saveManifest()
        assert.throws(() => data.pack('main'), /must pin|Missing exported file|Unsafe package files entry|cannot be published/)
      } finally { await data.dispose() }
    })
  }
})

test('native packaging rejects a foreign runner target, changed binary and unexpected files', async t => {
  for (const scenario of ['target', 'checksum', 'extra'] as const) {
    await t.test(scenario, async () => {
      const data = await fixture()
      try {
        if (scenario === 'checksum') await data.write(`dist/native/${executable}`, 'tampered worker')
        if (scenario === 'extra') await data.write('dist/native/source.cpp', 'source code')
        const platform = scenario === 'target' ? targets.find(value => value !== target)! : target
        assert.throws(() => data.pack('native', platform), /matching this runner|checksum mismatch|unexpected files/)
      } finally { await data.dispose() }
    })
  }
})

test('main packaging rejects a symlink instead of following it outside the release allowlist', async () => {
  const data = await fixture()
  try {
    await data.write('outside/private.txt', 'private file')
    await symlink(join(data.root, 'outside'), join(data.root, 'dist/leak'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => data.pack('main'), /cannot contain symlinks/)
  } finally { await data.dispose() }
})
