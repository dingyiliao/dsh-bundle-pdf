import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { cpus, totalmem, release } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
export async function sourceMetadata() {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT }).toString().split('\0').filter(Boolean).sort()
  const hash = createHash('sha256')
  const protocol = createHash('sha256')
  for (const path of files) {
    const bytes = await readFile(join(ROOT, path))
    hash.update(path); hash.update('\0'); hash.update(bytes); hash.update('\0')
    if (path.startsWith('bench/') && /\.tsx?$/.test(path)) { protocol.update(path); protocol.update('\0'); protocol.update(bytes); protocol.update('\0') }
  }
  return {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { cwd: ROOT }).length > 0,
    treeSha256: hash.digest('hex'), protocolSha256: protocol.digest('hex'), benchmarkVersion: 'm0-v1' as const,
  }
}
export function environmentMetadata() {
  return { platform: process.platform, arch: process.arch, osRelease: release(), node: process.version,
    cpuModel: cpus()[0]?.model ?? 'unknown', logicalCpuCount: cpus().length, totalMemoryBytes: totalmem(),
    osFileCache: 'unspecified', measurementClock: 'monotonic', dsh: 'not-mounted-component-only' }
}
