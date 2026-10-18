import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createLocalFiles, PdfFileError } from '../src/host/local-files.ts'
import type { PdfAgent } from '../src/host/transport.ts'

type Context = Parameters<typeof createLocalFiles>[0]
type Options = NonNullable<Parameters<typeof createLocalFiles>[1]>
const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55])
const revised = new Uint8Array([37, 80, 68, 70, 45, 50, 46, 48])

function fileContext(root: string, mapHostPath: (path: string) => string | undefined): Context {
  return {
    fs: {
      async resolve(path, options) {
        const absolute = resolve(options?.cwd ?? root, path)
        return { targetKey: absolute, displayPath: absolute }
      },
      processPath: target => String(target.targetKey),
      processPathFromHostPath: mapHostPath,
      contains: (parent, child) => String(child.targetKey).startsWith(String(parent.targetKey) + '/'),
      async stat(target) {
        let info
        try { info = await stat(String(target.targetKey), { bigint: true }) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw error
        }
        return { version: `${info.dev}:${info.ino}:${info.mtimeNs}:${info.size}`, type: info.isFile() ? 'file' as const : info.isDirectory() ? 'directory' as const : 'other' as const, size: Number(info.size) }
      },
      async readBytes(target, _signal, maxBytes) {
        const result = await readFile(String(target.targetKey))
        assert.ok(result.byteLength <= maxBytes)
        return result
      },
    },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root }) },
  }
}

function agent(root: string): PdfAgent {
  return { session: { id: 'local-files-test', header: { cwd: root } } }
}

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'dsh-pdf-local-files-'))
  try { await run(root) } finally { await rm(root, { recursive: true, force: true }) }
}

function expectCode(code: string) {
  return (error: unknown) => error instanceof PdfFileError && error.code === code
}

function localContext(root: string) { return fileContext(root, path => resolve(path)) }

function localFiles(root: string, options?: Options) {
  return createLocalFiles(localContext(root), { writableRoots: () => [root], ...options })
}

test('host-shared filesystem capability permits local reads across package identities', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'dsh-pdf-local-files-'))
  try {
    const path = join(root, 'example.pdf')
    await writeFile(path, bytes)
    const files = createLocalFiles(fileContext(root, hostPath => resolve(hostPath)))
    const agent: PdfAgent = { session: { id: 'local-files-test', header: { cwd: root } } }
    const result = await files.read(agent, 'example.pdf')
    assert.equal(result.path, path)
    assert.deepEqual([...result.bytes], [...bytes])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('read returns a content digest and detects missing, directory and over-limit targets', async () => withRoot(async root => {
  const files = localFiles(root, { maxBytes: bytes.length })
  await assert.rejects(files.read(agent(root), 'missing.pdf'), expectCode('PDF_NOT_FOUND'))
  await mkdir(join(root, 'folder'))
  await assert.rejects(files.read(agent(root), 'folder'), expectCode('PDF_NOT_REGULAR_FILE'))
  await writeFile(join(root, 'example.pdf'), bytes)
  const result = await files.read(agent(root), 'example.pdf')
  assert.match(result.version, /^sha256:[a-f0-9]{64}$/)
  assert.equal(result.size, bytes.length)
  assert.deepEqual([...result.bytes], [...bytes])
  await writeFile(join(root, 'large.pdf'), new Uint8Array(bytes.length + 1))
  await assert.rejects(files.read(agent(root), 'large.pdf'), expectCode('PDF_TOO_LARGE'))
}))

test('read rejects changed or excessive provider responses', async () => withRoot(async root => {
  await writeFile(join(root, 'example.pdf'), bytes)
  const ctx = localContext(root)
  const originalStat = ctx.fs.stat.bind(ctx.fs)
  let reads = 0
  ctx.fs.stat = async (...args) => {
    const info = await originalStat(...args)
    if (++reads === 2 && info) return { ...info, version: 'changed' }
    return info
  }
  await assert.rejects(createLocalFiles(ctx).read(agent(root), 'example.pdf'), expectCode('PDF_STALE_VERSION'))

  const oversized = localContext(root)
  oversized.fs.readBytes = async () => new Uint8Array(bytes.length + 1)
  await assert.rejects(createLocalFiles(oversized, { maxBytes: bytes.length }).read(agent(root), 'example.pdf'), expectCode('PDF_TOO_LARGE'))
}))

test('source policy, provider and path validation fail before accessing bytes', async () => withRoot(async root => {
  await writeFile(join(root, 'example.pdf'), bytes)
  const ctx = localContext(root)
  const files = createLocalFiles(ctx, { isLocalProvider: async () => false })
  await assert.rejects(files.read(agent(root), 'example.pdf'), expectCode('PDF_PROVIDER_UNSUPPORTED'))
  ctx.sandboxPolicy.resolve = () => ({ mode: 'workspace-write', workspaceRoot: 'relative' })
  await assert.rejects(createLocalFiles(ctx).read(agent(root), 'example.pdf'), expectCode('PDF_POLICY_UNAVAILABLE'))
  ctx.sandboxPolicy.resolve = () => ({ mode: 'workspace-write', workspaceRoot: root })
  const local = createLocalFiles(ctx)
  for (const path of ['', '   ', 'bad\0name.pdf']) {
    await assert.rejects(local.read(agent(root), path), expectCode('PDF_INVALID_PATH'))
  }
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(local.read(agent(root), 'example.pdf', cancelled.signal), { name: 'AbortError' })
}))

test('path validation rejects symlinks, non-directory parents and changing provider mappings', async () => withRoot(async root => {
  await writeFile(join(root, 'example.pdf'), bytes)
  await symlink(join(root, 'example.pdf'), join(root, 'alias.pdf'))
  await assert.rejects(localFiles(root).read(agent(root), 'alias.pdf'), expectCode('PDF_SYMLINK_UNSUPPORTED'))
  await assert.rejects(localFiles(root).read(agent(root), 'example.pdf/child.pdf'), expectCode('PDF_NOT_REGULAR_FILE'))
  const ctx = localContext(root)
  ctx.fs.processPath = () => join(root, 'different.pdf')
  await assert.rejects(createLocalFiles(ctx).read(agent(root), 'example.pdf'), expectCode('PDF_PATH_CHANGED'))
  ctx.fs.processPath = () => 'relative.pdf'
  await assert.rejects(createLocalFiles(ctx).read(agent(root), 'example.pdf'), expectCode('PDF_PROVIDER_UNSUPPORTED'))
}))

test('save validates content limits, expected digest and mutable settings', async () => withRoot(async root => {
  await writeFile(join(root, 'example.pdf'), bytes)
  assert.throws(() => localFiles(root, { maxBytes: 0 }), /Invalid PDF byte limit/)
  assert.throws(() => localFiles(root, { maxBytes: 1.5 }), /Invalid PDF byte limit/)
  let limit = bytes.length
  const files = localFiles(root, { getMaxBytes: () => limit })
  await assert.rejects(files.save(agent(root), 'example.pdf', new Uint8Array(bytes.length + 1), null), expectCode('PDF_TOO_LARGE'))
  await assert.rejects(files.save(agent(root), 'example.pdf', bytes, 'invalid'), expectCode('PDF_INVALID_VERSION'))
  limit = 0
  await assert.rejects(files.read(agent(root), 'example.pdf'), /Invalid PDF byte limit/)
}))

test('save policy allows workspace roots and full access, but denies read-only or unknown policy', async () => withRoot(async root => {
  const ctx = localContext(root)
  const policy = { mode: 'read-only' as 'read-only' | 'workspace-write' | 'danger-full-access', workspaceRoot: root }
  ctx.sandboxPolicy.resolve = () => policy
  const files = createLocalFiles(ctx, { writableRoots: () => [root] })
  await assert.rejects(files.save(agent(root), 'new.pdf', bytes, null), expectCode('FS_SANDBOX_DENIED'))
  policy.mode = 'workspace-write'
  await assert.rejects(createLocalFiles(ctx, { writableRoots: () => [] }).save(agent(root), 'new.pdf', bytes, null), expectCode('FS_SANDBOX_DENIED'))
  policy.mode = 'danger-full-access'
  assert.equal((await files.save(agent(root), 'new.pdf', bytes, null)).size, bytes.length)
  policy.mode = 'unknown' as typeof policy.mode
  await assert.rejects(files.save(agent(root), 'other.pdf', bytes, null), expectCode('PDF_POLICY_UNAVAILABLE'))
}))

test('save creates a new PDF and overwrites only the observed version, preserving mode', async () => withRoot(async root => {
  const files = localFiles(root)
  const path = join(root, 'example.pdf')
  const first = await files.save(agent(root), 'example.pdf', bytes, null)
  assert.equal(first.path, path)
  assert.deepEqual([...(await readFile(path))], [...bytes])
  await assert.rejects(files.save(agent(root), 'example.pdf', bytes, null), expectCode('PDF_TARGET_EXISTS'))
  await chmod(path, 0o640)
  const second = await files.save(agent(root), 'example.pdf', revised, first.version, { overwrite: true })
  assert.notEqual(first.version, second.version)
  assert.deepEqual([...(await readFile(path))], [...revised])
  assert.equal((await stat(path)).mode & 0o777, 0o640)
  await assert.rejects(files.save(agent(root), 'example.pdf', bytes, first.version), expectCode('PDF_STALE_VERSION'))
  await assert.rejects(files.save(agent(root), 'missing.pdf', bytes, first.version), expectCode('PDF_STALE_VERSION'))
  assert.deepEqual((await readdir(root)).sort(), ['example.pdf'])
}))

test('save copies caller bytes before first await and rechecks after publication', async () => withRoot(async root => {
  const ctx = localContext(root)
  let release!: () => void
  const gate = new Promise<void>(resolveGate => { release = resolveGate })
  const originalResolve = ctx.fs.resolve.bind(ctx.fs)
  let firstResolve = true
  ctx.fs.resolve = async (...args) => {
    if (firstResolve) { firstResolve = false; await gate }
    return originalResolve(...args)
  }
  const content = Uint8Array.from(bytes)
  const saving = createLocalFiles(ctx, { writableRoots: () => [root] }).save(agent(root), 'new.pdf', content, null)
  content[0] = 0
  release()
  await saving
  assert.deepEqual([...(await readFile(join(root, 'new.pdf')))], [...bytes])
}))

test('default sandbox roots permit a PDF under the workspace and concurrent Save As is serialized', async () => withRoot(async root => {
  const files = createLocalFiles(localContext(root))
  const outcomes = await Promise.allSettled([
    files.save(agent(root), 'new.pdf', bytes, null),
    files.save(agent(root), 'new.pdf', revised, null),
  ])
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = outcomes.find(result => result.status === 'rejected')
  assert.ok(rejected?.status === 'rejected')
  assert.ok(expectCode('PDF_TARGET_EXISTS')(rejected.reason))
  assert.deepEqual((await readdir(root)).sort(), ['new.pdf'])
}))

test('Save As refuses a competing file created during the final publication check', async () => withRoot(async root => {
  const ctx = localContext(root)
  const originalStat = ctx.fs.stat.bind(ctx.fs)
  let checks = 0
  ctx.fs.stat = async (target, signal) => {
    if (String(target.targetKey) === join(root, 'new.pdf') && ++checks === 2) {
      await writeFile(join(root, 'new.pdf'), revised)
    }
    return originalStat(target, signal)
  }
  await assert.rejects(createLocalFiles(ctx, { writableRoots: () => [root] }).save(agent(root), 'new.pdf', bytes, null), expectCode('PDF_TARGET_EXISTS'))
  assert.deepEqual([...(await readFile(join(root, 'new.pdf')))], [...revised])
  assert.deepEqual((await readdir(root)).sort(), ['new.pdf'])
}))

test('save detects a changed writable parent after staging bytes', async () => withRoot(async root => {
  await mkdir(join(root, 'chapter'))
  const ctx = localContext(root)
  const originalResolve = ctx.fs.resolve.bind(ctx.fs)
  let targetResolves = 0
  ctx.fs.resolve = async (path, options) => {
    if (path === 'chapter/new.pdf' && ++targetResolves === 3) {
      await rename(join(root, 'chapter'), join(root, 'old-chapter'))
      await mkdir(join(root, 'chapter'))
    }
    return originalResolve(path, options)
  }
  await assert.rejects(createLocalFiles(ctx, { writableRoots: () => [root] }).save(agent(root), 'chapter/new.pdf', bytes, null), expectCode('PDF_PATH_CHANGED'))
  await assert.rejects(stat(join(root, 'chapter', 'new.pdf')), { code: 'ENOENT' })
}))

test('saving checks the live byte limit again before publication', async () => withRoot(async root => {
  let checks = 0
  const files = localFiles(root, { getMaxBytes: () => ++checks >= 4 ? bytes.length - 1 : bytes.length })
  await assert.rejects(files.save(agent(root), 'new.pdf', bytes, null), expectCode('PDF_TOO_LARGE'))
  await assert.rejects(stat(join(root, 'new.pdf')), { code: 'ENOENT' })
  assert.deepEqual(await readdir(root), [])
}))

test('Save As refuses an unrelated writer winning the race after the final version check', async () => withRoot(async root => {
  const path = join(root, 'new.pdf')
  let checks = 0
  const files = localFiles(root, { getMaxBytes: () => {
    // The fourth limit read occurs after the final version check, immediately
    // before the exclusive hard-link publication. Simulate another process.
    if (++checks === 4) writeFileSync(path, revised)
    return bytes.length
  } })
  await assert.rejects(files.save(agent(root), 'new.pdf', bytes, null), expectCode('PDF_TARGET_EXISTS'))
  assert.deepEqual([...(await readFile(path))], [...revised])
  assert.deepEqual(await readdir(root), ['new.pdf'])
}))

test('aborting after bytes are staged never publishes the target', async () => withRoot(async root => {
  const ctx = localContext(root)
  const controller = new AbortController()
  const originalResolve = ctx.fs.resolve.bind(ctx.fs)
  let targetResolves = 0
  ctx.fs.resolve = async (path, options) => {
    if (path === 'new.pdf' && ++targetResolves === 3) controller.abort()
    return originalResolve(path, options)
  }
  await assert.rejects(createLocalFiles(ctx, { writableRoots: () => [root] }).save(agent(root), 'new.pdf', bytes, null, { signal: controller.signal }), { name: 'AbortError' })
  assert.deepEqual(await readdir(root), [])
}))

test('post-publication verification reports uncertainty without undoing the saved PDF', async () => withRoot(async root => {
  const ctx = localContext(root)
  ctx.fs.readBytes = async () => revised
  await assert.rejects(createLocalFiles(ctx, { writableRoots: () => [root] }).save(agent(root), 'new.pdf', bytes, null), expectCode('PDF_SAVE_UNCERTAIN'))
  assert.deepEqual([...(await readFile(join(root, 'new.pdf')))], [...bytes])
}))

test('a provider error after publication becomes save uncertainty rather than a false rejection', async () => withRoot(async root => {
  const ctx = localContext(root)
  const originalResolve = ctx.fs.resolve.bind(ctx.fs)
  let targetResolves = 0
  ctx.fs.resolve = async (path, options) => {
    if (resolve(options?.cwd ?? root, path) === join(root, 'new.pdf') && ++targetResolves === 4) {
      throw new Error('provider unavailable during verification')
    }
    return originalResolve(path, options)
  }
  await assert.rejects(createLocalFiles(ctx, { writableRoots: () => [root] }).save(agent(root), 'new.pdf', bytes, null), expectCode('PDF_SAVE_UNCERTAIN'))
  assert.deepEqual([...(await readFile(join(root, 'new.pdf')))], [...bytes])
}))

test('filesystem without a shared host path is rejected before reading a PDF', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'dsh-pdf-remote-files-'))
  try {
    const agent: PdfAgent = { session: { id: 'remote-files-test', header: { cwd: root } } }
    for (const map of [() => undefined, () => join(root, 'different.pdf')]) {
      const files = createLocalFiles(fileContext(root, map))
      await assert.rejects(files.read(agent, 'example.pdf'),
        (error: unknown) => error instanceof PdfFileError && error.code === 'PDF_PROVIDER_UNSUPPORTED')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
