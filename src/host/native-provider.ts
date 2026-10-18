import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

export interface PdfNativeService { executable: string }

interface NativeManifest {
  protocolVersion: number
  platform: string
  executableSha256: string
  librarySha256: string
}

export const name = 'pdf-native'
export const provide = 'pdfNative'

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

/** Reject a missing, wrong-platform or damaged native package before the reader starts. */
export async function verifyNativeDistribution(directory: string, platform = `${process.platform}-${process.arch}`): Promise<PdfNativeService> {
  const executable = join(directory, `dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
  const library = join(directory, process.platform === 'win32' ? 'pdfium.dll'
    : process.platform === 'darwin' ? 'libpdfium.dylib' : 'libpdfium.so')
  let manifest: NativeManifest
  try {
    manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as NativeManifest
    if (manifest.protocolVersion !== 1 || manifest.platform !== platform
      || !isHash(manifest.executableSha256) || !isHash(manifest.librarySha256)) {
      throw new Error('invalid native manifest')
    }
    const [workerBytes, libraryBytes, workerStat] = await Promise.all([
      readFile(executable), readFile(library), stat(executable),
    ])
    if (!workerStat.isFile() || (process.platform !== 'win32' && (workerStat.mode & 0o111) === 0)
      || digest(workerBytes) !== manifest.executableSha256 || digest(libraryBytes) !== manifest.librarySha256) {
      throw new Error('native package checksum or permissions mismatch')
    }
  } catch (error) {
    throw new Error(`PDF native package for ${platform} is missing or invalid; install the matching platform archive`, { cause: error })
  }
  return { executable }
}

export async function apply(ctx: Pick<Context, 'provide'>): Promise<void> {
  const override = process.env.DSH_PDF_NATIVE_HELPER
  if (override) {
    const info = await stat(override)
    if (!info.isFile()) throw new Error('DSH_PDF_NATIVE_HELPER must point to a file')
    ctx.provide('pdfNative', { executable: override })
    return
  }
  // The installed entry lives in dist/, while direct source execution during
  // development uses the same staged native archive from dist/native/.
  const directory = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../dist/native/' : './native/', import.meta.url))
  ctx.provide('pdfNative', await verifyNativeDistribution(directory))
}
