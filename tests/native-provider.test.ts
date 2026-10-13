import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as nativeProvider from '../src/host/native-provider.ts'
import { verifyNativeDistribution } from '../src/host/native-provider.ts'

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const executableName = `dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`
const libraryName = process.platform === 'win32' ? 'pdfium.dll'
  : process.platform === 'darwin' ? 'libpdfium.dylib' : 'libpdfium.so'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pdf-native-provider-'))
  const executable = join(directory, executableName)
  const library = join(directory, libraryName)
  const workerBytes = Buffer.from('worker fixture')
  const libraryBytes = Buffer.from('library fixture')
  await writeFile(executable, workerBytes)
  await writeFile(library, libraryBytes)
  if (process.platform !== 'win32') await chmod(executable, 0o755)
  const manifest = {
    protocolVersion: 1,
    platform: `${process.platform}-${process.arch}`,
    executableSha256: hash(workerBytes),
    librarySha256: hash(libraryBytes),
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
  return { directory, executable, library, manifest }
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
    await assert.rejects(verifyNativeDistribution(value.directory), /matching platform archive/)
  } finally {
    await rm(value.directory, { recursive: true, force: true })
  }
})

test('native provider rejects modified helper or PDFium library', async () => {
  const value = await fixture()
  try {
    await writeFile(value.executable, Buffer.from('modified worker'))
    await assert.rejects(verifyNativeDistribution(value.directory), /matching platform archive/)
    await writeFile(value.executable, Buffer.from('worker fixture'))
    const bytes = await readFile(value.library)
    await writeFile(value.library, Buffer.concat([bytes, Buffer.from('modified')]))
    await assert.rejects(verifyNativeDistribution(value.directory), /matching platform archive/)
  } finally {
    await rm(value.directory, { recursive: true, force: true })
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
