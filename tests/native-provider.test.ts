import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import * as nativeProvider from '../src/entrypoints/native-host.ts'
import { resolveNativeDistribution, verifyNativeDistribution } from '../src/entrypoints/native-host.ts'

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const executableName = `dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`

async function fixture(platform = `${process.platform}-${process.arch}`, directory?: string) {
  directory ??= await mkdtemp(join(tmpdir(), 'dsh-pdf-native-provider-'))
  await mkdir(directory, { recursive: true })
  const operatingSystem = platform.split('-')[0]
  const executable = join(directory, `dsh-pdf-native${operatingSystem === 'win32' ? '.exe' : ''}`)
  const library = join(directory, operatingSystem === 'win32' ? 'pdfium.dll'
    : operatingSystem === 'darwin' ? 'libpdfium.dylib' : 'libpdfium.so')
  const workerBytes = Buffer.from('worker fixture')
  const libraryBytes = Buffer.from('library fixture')
  await writeFile(executable, workerBytes)
  await writeFile(library, libraryBytes)
  if (operatingSystem !== 'win32') await chmod(executable, 0o755)
  const manifest = {
    protocolVersion: 1,
    platform,
    executableSha256: hash(workerBytes),
    librarySha256: hash(libraryBytes),
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
  return { directory, executable, library, manifest }
}

async function npmFixture(platform = `${process.platform}-${process.arch}`) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-pdf-native-install-')))
  const metadata = { name: '@example/custom-pdf', version: '1.2.3' }
  const packageJson = join(root, 'package.json')
  await writeFile(packageJson, JSON.stringify(metadata))
  const nativeName = `${metadata.name}-native-${platform}`
  const nativeRoot = join(root, 'node_modules', nativeName)
  const distribution = await fixture(platform, join(nativeRoot, 'bin'))
  const nativeMetadata = { name: nativeName, version: metadata.version, exports: { './package.json': './package.json' } }
  const nativePackageJson = join(nativeRoot, 'package.json')
  await writeFile(nativePackageJson, JSON.stringify(nativeMetadata))
  return { ...distribution, root, metadata, nativeRoot, nativePackageJson, nativeMetadata,
    packageRoot: new URL('./', pathToFileURL(packageJson)) }
}

test('native provider accepts a complete package for the current platform', async () => {
  const value = await fixture()
  try {
    assert.deepEqual(await verifyNativeDistribution(value.directory), { executable: value.executable })
  } finally {
    await rm(value.directory, { recursive: true, force: true })
  }
})

test('native provider rejects a package built for another platform', async () => {
  const value = await fixture()
  try {
    await writeFile(join(value.directory, 'manifest.json'), JSON.stringify({ ...value.manifest, platform: 'other-x64' }))
    await assert.rejects(verifyNativeDistribution(value.directory), /optional dependencies enabled/)
  } finally {
    await rm(value.directory, { recursive: true, force: true })
  }
})

test('native provider rejects modified helper or PDFium library', async () => {
  const value = await fixture()
  try {
    await writeFile(value.executable, Buffer.from('modified worker'))
    await assert.rejects(verifyNativeDistribution(value.directory), /optional dependencies enabled/)
    await writeFile(value.executable, Buffer.from('worker fixture'))
    const bytes = await readFile(value.library)
    await writeFile(value.library, Buffer.concat([bytes, Buffer.from('modified')]))
    await assert.rejects(verifyNativeDistribution(value.directory), /optional dependencies enabled/)
  } finally {
    await rm(value.directory, { recursive: true, force: true })
  }
})

test('installed native provider resolves every supported platform through its own node_modules', async t => {
  for (const platform of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64']) {
    await t.test(platform, async () => {
      const value = await npmFixture(platform)
      try {
        assert.deepEqual(await resolveNativeDistribution(value.packageRoot, platform), { executable: value.executable })
      } finally {
        await rm(value.root, { recursive: true, force: true })
      }
    })
  }
})

test('installed native provider reports missing optional dependency without loading adjacent binary leftovers', async () => {
  const value = await npmFixture()
  try {
    await rm(value.nativeRoot, { recursive: true, force: true })
    await fixture(undefined, join(value.root, 'dist/native'))
    await assert.rejects(resolveNativeDistribution(value.packageRoot),
      /@example\/custom-pdf-native-.+@1\.2\.3 is unavailable; reinstall @example\/custom-pdf with optional dependencies enabled/)
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test('source checkouts can use their locally built native files only when the dependency is absent', async () => {
  const value = await npmFixture()
  try {
    await mkdir(join(value.root, 'native'))
    await writeFile(join(value.root, 'native/dependencies.json'), '{}')
    const staged = await fixture(undefined, join(value.root, 'dist/native'))
    assert.deepEqual(await resolveNativeDistribution(value.packageRoot), { executable: value.executable })
    await rm(value.nativeRoot, { recursive: true, force: true })
    assert.deepEqual(await resolveNativeDistribution(value.packageRoot), { executable: staged.executable })
    await writeFile(staged.executable, 'changed staged helper')
    await assert.rejects(resolveNativeDistribution(value.packageRoot), /native files.+missing or invalid/)
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test('native dependency version and name must match the installing main package', async () => {
  const value = await npmFixture()
  try {
    await writeFile(value.nativePackageJson, JSON.stringify({ ...value.nativeMetadata, version: '1.2.2' }))
    await assert.rejects(resolveNativeDistribution(value.packageRoot), /must match version 1\.2\.3/)
    await writeFile(value.nativePackageJson, JSON.stringify({ ...value.nativeMetadata, name: '@example/some-other-native' }))
    await assert.rejects(resolveNativeDistribution(value.packageRoot), /must match version 1\.2\.3/)
    await writeFile(value.nativePackageJson, JSON.stringify(value.nativeMetadata))
    await writeFile(value.library, 'damaged native library')
    await assert.rejects(resolveNativeDistribution(value.packageRoot), /native files.+missing or invalid/)
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test('invalid package exports do not trigger a development fallback', async () => {
  const value = await npmFixture()
  try {
    await mkdir(join(value.root, 'native'))
    await writeFile(join(value.root, 'native/dependencies.json'), '{}')
    await fixture(undefined, join(value.root, 'dist/native'))
    await writeFile(value.nativePackageJson, JSON.stringify({ ...value.nativeMetadata, exports: {} }))
    await assert.rejects(resolveNativeDistribution(value.packageRoot), /native dependency.+is unavailable/)
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test('native resolution rejects incomplete main package metadata', async () => {
  const value = await npmFixture()
  try {
    for (const metadata of [{}, { name: value.metadata.name }, { name: value.metadata.name, version: 1 }]) {
      await writeFile(new URL('package.json', value.packageRoot), JSON.stringify(metadata))
      await assert.rejects(resolveNativeDistribution(value.packageRoot), /metadata must contain a name and version/)
    }
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test('source-mode provider loads the same verified native archive staged for its package',
  { skip: !existsSync(resolve('dist/native', executableName)) }, async () => {
    const previous = process.env.DSH_PDF_NATIVE_HELPER
    delete process.env.DSH_PDF_NATIVE_HELPER
    let provided: { name: string; executable: string } | undefined
    try {
      await nativeProvider.apply({ provide(name: string, value: { executable: string }) {
        provided = { name, executable: value.executable }
      } } as never)
      assert.deepEqual(provided, { name: 'pdfNative', executable: resolve('dist/native', executableName) })
    } finally {
      if (previous === undefined) delete process.env.DSH_PDF_NATIVE_HELPER
      else process.env.DSH_PDF_NATIVE_HELPER = previous
    }
  })

test('a reader plugin waits for the native service and unloads with it', async () => {
  const value = await fixture()
  const previous = process.env.DSH_PDF_NATIVE_HELPER
  process.env.DSH_PDF_NATIVE_HELPER = value.executable
  const root = new Context()
  let starts = 0
  let stops = 0
  try {
    const reader = root.plugin({
      inject: ['pdfNative'],
      apply(ctx: Context) {
        starts++
        assert.equal((ctx as Context & { pdfNative: { executable: string } }).pdfNative.executable, value.executable)
        return () => { stops++ }
      },
    })
    assert.equal(starts, 0)
    const native = root.plugin(nativeProvider)
    await native
    await reader
    assert.equal(starts, 1)
    await native.dispose()
    assert.equal(stops, 1)
  } finally {
    await root.fiber.dispose()
    if (previous === undefined) delete process.env.DSH_PDF_NATIVE_HELPER
    else process.env.DSH_PDF_NATIVE_HELPER = previous
    await rm(value.directory, { recursive: true, force: true })
  }
})
