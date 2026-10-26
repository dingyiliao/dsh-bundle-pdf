import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
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
  const operatingSystem = platform.split('-')[0]
  const executable = join(directory, `dsh-pdf-native${operatingSystem === 'win32' ? '.exe' : ''}`)
  const library = join(directory, operatingSystem === 'win32' ? 'pdfium.dll'
    : operatingSystem === 'darwin' ? 'libpdfium.dylib' : 'libpdfium.so')
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
    if (!workerStat.isFile() || (process.platform !== 'win32' && operatingSystem !== 'win32' && (workerStat.mode & 0o111) === 0)
      || digest(workerBytes) !== manifest.executableSha256 || digest(libraryBytes) !== manifest.librarySha256) {
      throw new Error('native package checksum or permissions mismatch')
    }
  } catch (error) {
    throw new Error(`PDF native files for ${platform} are missing or invalid; reinstall the PDF plugin with optional dependencies enabled`, { cause: error })
  }
  return { executable }
}

/** Resolve the exact platform dependency from this installation, never the process cwd. */
export async function resolveNativeDistribution(packageRoot: URL,
  platform = `${process.platform}-${process.arch}`): Promise<PdfNativeService> {
  const packageJson = new URL('package.json', packageRoot)
  const metadata = JSON.parse(await readFile(packageJson, 'utf8')) as { name?: unknown; version?: unknown }
  if (typeof metadata.name !== 'string' || !metadata.name || typeof metadata.version !== 'string' || !metadata.version) {
    throw new Error('PDF package metadata must contain a name and version')
  }
  const nativeName = `${metadata.name}-native-${platform}`
  const reinstall = `reinstall ${metadata.name} with optional dependencies enabled`
  let nativePackageJson: string
  try {
    nativePackageJson = createRequire(packageJson).resolve(`${nativeName}/package.json`)
  } catch (error) {
    // The repository's native source manifest is deliberately absent from the
    // published main package, so only a source checkout can use staged binaries.
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND'
      && await stat(new URL('native/dependencies.json', packageRoot)).then(value => value.isFile(), () => false)) {
      return verifyNativeDistribution(fileURLToPath(new URL('dist/native/', packageRoot)), platform)
    }
    throw new Error(`PDF native dependency ${nativeName}@${metadata.version} is unavailable; ${reinstall}`, { cause: error })
  }
  const nativeMetadata = JSON.parse(await readFile(nativePackageJson, 'utf8')) as { name?: unknown; version?: unknown }
  if (nativeMetadata.name !== nativeName || nativeMetadata.version !== metadata.version) {
    throw new Error(`PDF native dependency ${nativeName} must match version ${metadata.version}; ${reinstall}`)
  }
  return verifyNativeDistribution(join(dirname(nativePackageJson), 'bin'), platform)
}

export async function apply(ctx: Pick<Context, 'provide'>): Promise<void> {
  const override = process.env.DSH_PDF_NATIVE_HELPER
  if (override) {
    const info = await stat(override)
    if (!info.isFile()) throw new Error('DSH_PDF_NATIVE_HELPER must point to a file')
    ctx.provide('pdfNative', { executable: override })
    return
  }
  const packageRoot = new URL(import.meta.url.endsWith('.ts') ? '../../' : '../', import.meta.url)
  ctx.provide('pdfNative', await resolveNativeDistribution(packageRoot))
}
