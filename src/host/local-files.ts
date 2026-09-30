import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, link, open, realpath, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import type { PdfAgent } from './transport.ts'

interface FsTarget { targetKey: unknown; displayPath: string }
interface FsInfo { version: string; type: 'file' | 'directory' | 'other'; size?: number }
interface FsProvider {
  resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
  processPath(target: FsTarget): string
  processPathFromHostPath(path: string): string | undefined
  contains(parent: FsTarget, child: FsTarget): boolean
  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
  readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
}
export interface PdfFilePolicy {
  mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  workspaceRoot: string
}
interface FileContext {
  fs: FsProvider
  sandboxPolicy: { resolve(request: { session: PdfAgent['session'] }): PdfFilePolicy }
}
export interface PdfFileVersion {
  path: string
  /** Content digest, never a stat-derived approximation. */
  version: string
  fsVersion: string
  size: number
}
export interface PdfFileRead extends PdfFileVersion { bytes: Uint8Array }
export class PdfFileError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'PdfFileError' }
}
interface FileOptions {
  maxBytes?: number
  /** Current Host configuration; one adapter and its path queues survive changes. */
  getMaxBytes?: () => number
  /** Trusted composition/test dependencies; never supplied by a wire request. */
  isLocalProvider?: (provider: FsProvider) => boolean | Promise<boolean>
  writableRoots?: (policy: PdfFilePolicy) => readonly string[] | Promise<readonly string[]>
}

/** Create the local binary adapter; source bytes always pass through ctx.fs. */
export function createLocalFiles(ctx: FileContext, options: FileOptions = {}) {
  const maxBytes = () => {
    const value = options.getMaxBytes?.() ?? options.maxBytes ?? 64 * 1024 * 1024
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid PDF byte limit')
    return value
  }
  maxBytes()
  const queues = new Map<string, Promise<unknown>>()
  const local = options.isLocalProvider
  const roots = options.writableRoots ?? defaultWritableRoots

  async function locate(agent: PdfAgent, path: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (local && !await local(ctx.fs)) fail('PDF_PROVIDER_UNSUPPORTED', 'This PDF operation requires the local filesystem provider')
    const policy = ctx.sandboxPolicy.resolve({ session: agent.session })
    if (!isAbsolute(policy.workspaceRoot)) fail('PDF_POLICY_UNAVAILABLE', 'The session has no absolute workspace root')
    if (typeof path !== 'string' || !path.trim() || path.includes('\0')) fail('PDF_INVALID_PATH', 'Invalid PDF path')
    const requestedPath = resolve(policy.workspaceRoot, path)
    // The FS contract exposes this mapping only when its execution world shares
    // the Host's path. Class identity is unreliable for separately installed plugins.
    const mappedRequest = ctx.fs.processPathFromHostPath(requestedPath)
    if (!mappedRequest || !isAbsolute(mappedRequest) || pathKey(mappedRequest) !== pathKey(requestedPath)) {
      fail('PDF_PROVIDER_UNSUPPORTED', 'This PDF operation requires the local filesystem provider')
    }
    await inspectPath(requestedPath, true)
    const target = await ctx.fs.resolve(path, { cwd: policy.workspaceRoot, signal })
    const hostPath = ctx.fs.processPath(target)
    const mappedHostPath = isAbsolute(hostPath) ? ctx.fs.processPathFromHostPath(hostPath) : undefined
    if (!mappedHostPath || !isAbsolute(mappedHostPath) || pathKey(mappedHostPath) !== pathKey(hostPath)) {
      fail('PDF_PROVIDER_UNSUPPORTED', 'The filesystem does not share this path with the PDF Host')
    }
    await inspectPath(hostPath, true)
    if (pathKey(await canonicalCandidate(requestedPath)) !== pathKey(hostPath)) {
      fail('PDF_PATH_CHANGED', 'The PDF path changed while resolving it')
    }
    return { target, hostPath, requestedPath, policy }
  }

  async function snapshot(target: FsTarget, path: string, signal?: AbortSignal, limit = maxBytes()): Promise<PdfFileRead> {
    const before = await ctx.fs.stat(target, signal)
    if (before === undefined) fail('PDF_NOT_FOUND', 'PDF file does not exist')
    if (before.type !== 'file') fail('PDF_NOT_REGULAR_FILE', 'PDF path must be a regular file')
    if ((before.size ?? 0) > limit) fail('PDF_TOO_LARGE', 'PDF exceeds the configured byte limit')
    const bytes = await ctx.fs.readBytes(target, signal, limit)
    if (bytes.byteLength > limit) fail('PDF_TOO_LARGE', 'PDF exceeds the configured byte limit')
    const after = await ctx.fs.stat(target, signal)
    if (after === undefined || after.version !== before.version) fail('PDF_STALE_VERSION', 'PDF changed while it was being read')
    return { path, bytes, version: hash(bytes), fsVersion: after.version, size: bytes.byteLength }
  }

  async function read(agent: PdfAgent, path: string, signal?: AbortSignal): Promise<PdfFileRead> {
    const located = await locate(agent, path, signal)
    return snapshot(located.target, located.hostPath, signal)
  }

  async function writePermission(agent: PdfAgent, path: string, signal?: AbortSignal) {
    const current = await locate(agent, path, signal)
    if (current.policy.mode === 'read-only') fail('FS_SANDBOX_DENIED', 'The current session is read-only')
    if (current.policy.mode === 'workspace-write') {
      let allowed = false
      for (const root of await roots(current.policy)) {
        const parent = await ctx.fs.resolve(root, { signal })
        if (ctx.fs.contains(parent, current.target)) { allowed = true; break }
      }
      if (!allowed) fail('FS_SANDBOX_DENIED', 'The PDF path is outside the current session writable roots')
    } else if (current.policy.mode !== 'danger-full-access') {
      fail('PDF_POLICY_UNAVAILABLE', 'Unknown filesystem policy; saving is unavailable')
    }
    return current
  }

  async function assertExpected(target: FsTarget, path: string, expected: string | null, signal?: AbortSignal) {
    const info = await ctx.fs.stat(target, signal)
    if (expected === null) {
      if (info !== undefined) fail('PDF_TARGET_EXISTS', 'Save As target already exists; observe its version before replacing it')
    } else {
      if (info === undefined) fail('PDF_STALE_VERSION', 'The source PDF has disappeared')
      if ((await snapshot(target, path, signal)).version !== expected) {
        fail('PDF_STALE_VERSION', 'The PDF was modified outside this editor; reload or save to another path')
      }
    }
  }

  async function save(
    agent: PdfAgent,
    path: string,
    content: Uint8Array,
    expectedVersion: string | null,
    saveOptions: { overwrite?: boolean; signal?: AbortSignal } = {},
  ): Promise<PdfFileVersion> {
    const signal = saveOptions.signal
    if (!(content instanceof Uint8Array) || content.byteLength > maxBytes()) fail('PDF_TOO_LARGE', 'Invalid PDF bytes or configured byte limit exceeded')
    if (expectedVersion !== null && !/^sha256:[a-f0-9]{64}$/.test(expectedVersion)) fail('PDF_INVALID_VERSION', 'A source content digest is required')
    // Snapshot caller-owned bytes before any await. overwrite never bypasses CAS.
    const bytes = Uint8Array.from(content)
    const initial = await writePermission(agent, path, signal)
    const key = pathKey(initial.hostPath)
    const previous = queues.get(key) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(async () => {
      if (bytes.byteLength > maxBytes()) fail('PDF_TOO_LARGE', 'PDF exceeds the current configured byte limit')
      const current = await writePermission(agent, path, signal)
      if (pathKey(current.hostPath) !== key) fail('PDF_PATH_CHANGED', 'The PDF target changed before saving')
      const ancestors = await inspectPath(current.hostPath)
      await assertExpected(current.target, current.hostPath, expectedVersion, signal)
      const temporary = join(dirname(current.hostPath), `.${basename(current.hostPath)}.${randomUUID()}.pdf-tmp`)
      let published = false
      try {
        const mode = expectedVersion === null ? 0o600 : (await stat(current.hostPath)).mode & 0o777
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode)
        try { await handle.writeFile(bytes, { signal }); await handle.sync() } finally { await handle.close() }
        signal?.throwIfAborted()
        const latest = await writePermission(agent, path, signal)
        if (pathKey(latest.hostPath) !== key || await inspectPath(latest.hostPath) !== ancestors) {
          fail('PDF_PATH_CHANGED', 'A PDF parent directory changed while saving')
        }
        await assertExpected(latest.target, latest.hostPath, expectedVersion, signal)
        const publicationLimit = maxBytes()
        if (bytes.byteLength > publicationLimit) fail('PDF_TOO_LARGE', 'PDF exceeds the current configured byte limit')
        signal?.throwIfAborted()
        // Publication is atomic. This cannot provide an OS-level CAS against an
        // unrelated process that writes between the final hash check and rename.
        if (expectedVersion === null) {
          try { await link(temporary, latest.hostPath) } catch (error) {
            if (codeOf(error) === 'EEXIST') fail('PDF_TARGET_EXISTS', 'Save As target appeared before publication')
            throw error
          }
        } else {
          await rename(temporary, latest.hostPath)
        }
        published = true
        const committedTarget = await ctx.fs.resolve(latest.hostPath)
        // Verification uses the limit that admitted this commit, even if the
        // user lowers the setting after publication has already occurred.
        const committed = await snapshot(committedTarget, latest.hostPath, undefined, publicationLimit)
        if (committed.version !== hash(bytes)) fail('PDF_SAVE_UNCERTAIN', 'Saved file differs from the submitted bytes')
        return { path: committed.path, version: committed.version, fsVersion: committed.fsVersion, size: committed.size }
      } catch (error) {
        if (published && !(error instanceof PdfFileError && error.code === 'PDF_SAVE_UNCERTAIN')) {
          throw new PdfFileError('PDF_SAVE_UNCERTAIN', 'PDF was published, but its final state could not be verified')
        }
        throw error
      } finally {
        await unlink(temporary).catch(error => { if (codeOf(error) !== 'ENOENT') { /* Publication remains authoritative. */ } })
      }
    })
    queues.set(key, operation)
    try { return await operation } finally { if (queues.get(key) === operation) queues.delete(key) }
  }
  return { read, save, resolvePath: async (agent: PdfAgent, path: string, signal?: AbortSignal) => (await locate(agent, path, signal)).hostPath }
}

/** Reject path-level symlinks/junctions and fingerprint every existing parent. */
async function inspectPath(path: string, allowMissingParents = false): Promise<string> {
  const absolute = resolve(path)
  const root = parse(absolute).root
  const parts = absolute.slice(root.length).split(sep).filter(Boolean)
  let current = root
  const parents: string[] = []
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index])
    let info
    try { info = await lstat(current, { bigint: true }) } catch (error) {
      if (codeOf(error) === 'ENOENT' && (allowMissingParents || index === parts.length - 1)) break
      throw error
    }
    if (info.isSymbolicLink()) fail('PDF_SYMLINK_UNSUPPORTED', 'PDF paths containing symbolic links or junctions are not writable by this adapter')
    if (index < parts.length - 1) {
      if (!info.isDirectory()) fail('PDF_NOT_REGULAR_FILE', 'A PDF path parent is not a directory')
      parents.push(`${pathKey(current)}:${info.dev}:${info.ino}`)
    } else if (!info.isFile()) {
      fail('PDF_NOT_REGULAR_FILE', 'PDF path must be a regular file')
    }
  }
  return parents.join('|')
}
async function canonicalCandidate(path: string): Promise<string> {
  let parent = path
  const suffix: string[] = []
  while (true) {
    try { return join(await realpath(parent), ...suffix) } catch (error) {
      if (codeOf(error) !== 'ENOENT' || dirname(parent) === parent) throw error
      suffix.unshift(basename(parent))
      parent = dirname(parent)
    }
  }
}
function pathKey(path: string): string { return process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path) }
function hash(bytes: Uint8Array): string { return `sha256:${createHash('sha256').update(bytes).digest('hex')}` }
function codeOf(error: unknown): unknown { return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined }
function fail(code: string, message: string): never { throw new PdfFileError(code, message) }

async function defaultWritableRoots(policy: PdfFilePolicy): Promise<readonly string[]> {
  const packageName = '@deepseek-ai/dsh-sandbox'
  const module = await import(packageName)
  return module.writableRoots(policy)
}
