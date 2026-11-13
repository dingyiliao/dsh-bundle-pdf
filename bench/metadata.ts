import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { cpus, totalmem, release } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

async function snapshotFiles(directory = ''): Promise<string[]> {
  const ignored = new Set(['node_modules', 'dist', 'artifacts', 'bench-results', 'playwright-report', 'test-results'])
  const entries = await readdir(join(ROOT, directory), { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = directory ? `${directory}/${entry.name}` : entry.name
    if (entry.name.startsWith('.') || ignored.has(entry.name) || path === 'native/build' || entry.name.endsWith('.tgz')) continue
    if (entry.isDirectory()) files.push(...await snapshotFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

export async function sourceMetadata() {
  const git = existsSync(join(ROOT, '.git'))
  const files = git ? execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: ROOT }).toString().split('\0').filter(Boolean) : await snapshotFiles()
  const hash = createHash('sha256')
  const protocol = createHash('sha256')
  for (const path of files.sort()) {
    let bytes: Buffer
    try { bytes = await readFile(join(ROOT, path)) } catch (error) {
      // `git ls-files --cached` also lists tracked files deleted by the working tree.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    hash.update(path); hash.update('\0'); hash.update(bytes); hash.update('\0')
    if (path.startsWith('bench/') && /\.tsx?$/.test(path) || path === 'tests/fixtures/plain-pdf.ts') {
      protocol.update(path); protocol.update('\0'); protocol.update(bytes); protocol.update('\0')
    }
  }
  return {
    commit: git ? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim() : 'unversioned',
    dirty: !git || execFileSync('git', ['status', '--porcelain'], { cwd: ROOT }).length > 0,
    treeSha256: hash.digest('hex'), protocolSha256: protocol.digest('hex'), benchmarkVersion: 'm0-v1' as const,
  }
}
export function environmentMetadata() {
  return { platform: process.platform, arch: process.arch, osRelease: release(), node: process.version,
    cpuModel: cpus()[0]?.model ?? 'unknown', logicalCpuCount: cpus().length, totalMemoryBytes: totalmem(),
    osFileCache: 'unspecified', measurementClock: 'monotonic', dsh: 'not-mounted-component-only' }
}
