import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { applyPdfOperations } from '../core/pdf-document.ts'
import type { PdfAnnotationOperation } from '../core/pdf-types.ts'
import { loadPdfForReading } from './pdf-inspection.ts'
import type { WorkspaceSnapshot } from '../shared/contracts.ts'
import { sessionFile } from '../shared/address.ts'
import { draftSchema, requestSchema, type DraftRecord } from './validation.ts'
import type { createLocalFiles, PdfFileRead } from './local-files.ts'
import type { PdfAgent } from './transport.ts'

interface DraftTable {
  get(key: string): DraftRecord | undefined
  put(key: string, value: DraftRecord): Promise<void>
  delete(key: string): Promise<unknown>
}
interface WorkingCopy {
  id: string
  record: DraftRecord
  snapshot: WorkspaceSnapshot
}
type Files = ReturnType<typeof createLocalFiles>
type RenderedPdf = Pick<WorkspaceSnapshot, 'bytes' | 'document'>
interface CachedRender {
  owner: string
  record: Pick<DraftRecord, 'original' | 'sourceHash' | 'groups' | 'cursor'>
  pdf: RenderedPdf
}

const renderCacheBytes = 32 * 1024 * 1024
const encodedCacheBytes = 4 * 1024 * 1024

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }
function pathKey(path: string): string { return process.platform === 'win32' ? path.toLowerCase() : path }
function recordKey(session: string, path: string): string {
  return createHash('sha256').update(JSON.stringify([session, pathKey(path)])).digest('hex')
}
function contentHash(bytes: Uint8Array): string { return `sha256:${createHash('sha256').update(bytes).digest('hex')}` }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** Authoritative working copies, serialized per session. A draft is durable before the UI accepts it. */
export function createWorkspaces(files: Files, drafts: DraftTable) {
  const copies = new Map<string, WorkingCopy>()
  const byPath = new Map<string, string>()
  const queues = new Map<string, Promise<unknown>>()
  // Only derived state is cached. Original bytes and operations remain the durable source of truth.
  const rendered = new Map<string, CachedRender>()
  const checkedSources = new Map<string, Pick<DraftRecord, 'original' | 'sourceHash'>>()
  const hashes = new WeakMap<Uint8Array, string>()
  const encoded = new WeakMap<Uint8Array, string>()
  let cachedBytes = 0
  let closing = false
  let disposal: Promise<void> | undefined

  function renderedHash(bytes: Uint8Array): string {
    let value = hashes.get(bytes)
    if (!value) { value = contentHash(bytes); hashes.set(bytes, value) }
    return value
  }

  function samePrefix(cached: CachedRender['record'], record: DraftRecord): boolean {
    if (cached.original !== record.original || cached.sourceHash !== record.sourceHash || cached.cursor > record.groups.length) return false
    for (let index = 0; index < cached.cursor; index++) {
      if (cached.groups[index] !== record.groups[index]) return false
    }
    return true
  }

  function dropRender(key: string) {
    const entry = rendered.get(key)
    if (!entry) return
    cachedBytes -= entry.pdf.bytes.byteLength
    rendered.delete(key)
  }

  function rememberRender(id: string, record: DraftRecord, pdf: RenderedPdf) {
    for (const [key, entry] of rendered) {
      if (entry.owner === id && !samePrefix(entry.record, record)) dropRender(key)
    }
    const key = `${id}:${record.cursor}`
    dropRender(key)
    if (pdf.bytes.byteLength > renderCacheBytes) return
    rendered.set(key, { owner: id, record: { original: record.original, sourceHash: record.sourceHash,
      cursor: record.cursor, groups: record.groups.slice(0, record.cursor) }, pdf })
    cachedBytes += pdf.bytes.byteLength
    const own: string[] = []
    for (const [entryKey, entry] of rendered) if (entry.owner === id) own.push(entryKey)
    // Keep the current state and at most two prior rendered states for rapid undo/redo.
    for (let index = 0; index < own.length - 3; index++) dropRender(own[index])
    while (cachedBytes > renderCacheBytes) dropRender(rendered.keys().next().value!)
  }

  function cachedRender(id: string, record: DraftRecord): RenderedPdf | undefined {
    const key = `${id}:${record.cursor}`
    const entry = rendered.get(key)
    if (!entry) return undefined
    if (!samePrefix(entry.record, record)) { dropRender(key); return undefined }
    rendered.delete(key)
    rendered.set(key, entry)
    return entry.pdf
  }

  function checkpointRender(id: string, record: DraftRecord): { cursor: number; pdf: RenderedPdf } | undefined {
    let best: { cursor: number; pdf: RenderedPdf } | undefined
    const current = copies.get(id)
    // The live snapshot is retained even when a large PDF exceeds the LRU budget.
    // A redo can therefore apply only its next group without decoding the source.
    if (current && current.record.cursor <= record.cursor && samePrefix(current.record, record)) {
      best = { cursor: current.record.cursor, pdf: current.snapshot }
    }
    for (const entry of rendered.values()) {
      if (entry.owner !== id || entry.record.cursor > record.cursor || entry.record.cursor <= (best?.cursor ?? -1)) continue
      if (samePrefix(entry.record, record)) best = { cursor: entry.record.cursor, pdf: entry.pdf }
    }
    return best
  }

  async function materialize(id: string, record: DraftRecord, conflict = false, supplied?: RenderedPdf): Promise<WorkspaceSnapshot> {
    let pdf = supplied ?? cachedRender(id, record)
    if (!pdf) {
      const checkpoint = checkpointRender(id, record)
      let bytes = checkpoint?.pdf.bytes
      if (!bytes) {
        bytes = Buffer.from(record.original, 'base64')
        const checked = checkedSources.get(id)
        if (checked?.original !== record.original || checked.sourceHash !== record.sourceHash) {
          if (base64(bytes) !== record.original || renderedHash(bytes) !== record.sourceHash) {
            fail('pdf/draft-damaged', 'Saved draft source bytes failed their integrity check')
          }
          if (copies.has(id)) checkedSources.set(id, { original: record.original, sourceHash: record.sourceHash })
        }
      }
      const operations: PdfAnnotationOperation[] = []
      for (let index = checkpoint?.cursor ?? 0; index < record.cursor; index++) {
        for (const operation of record.groups[index]) operations.push(operation)
      }
      pdf = operations.length
        ? await applyPdfOperations(bytes, operations)
        : checkpoint?.pdf ?? { bytes, document: await loadPdfForReading(bytes) }
    }
    return {
      id, path: record.path, sourceVersion: record.sourceVersion, contentVersion: record.contentVersion,
      revision: record.revision, dirty: record.cursor > 0,
      canUndo: record.cursor > 0, canRedo: record.cursor < record.groups.length,
      conflict, document: pdf.document, bytes: pdf.bytes,
    }
  }

  function fresh(sessionId: string, source: PdfFileRead, revision = 0, contentVersion: string = randomUUID()): DraftRecord {
    return { format: 1, sessionId, path: source.path, sourceHash: source.version,
      sourceVersion: source.fsVersion, contentVersion, original: base64(source.bytes),
      revision, groups: [], cursor: 0 }
  }

  async function sourcePdf(source: PdfFileRead): Promise<RenderedPdf> {
    // The file adapter has already checked the digest. A fresh working copy can
    // inspect those exact bytes without encoding, decoding and hashing another copy.
    hashes.set(source.bytes, source.version)
    return { bytes: source.bytes, document: await loadPdfForReading(source.bytes) }
  }

  async function publish(copy: WorkingCopy, record: DraftRecord, conflict = copy.snapshot.conflict, signal?: AbortSignal, pdf?: RenderedPdf) {
    const snapshot = await materialize(copy.id, record, conflict, pdf)
    signal?.throwIfAborted()
    const persisted = { ...record, renderedHash: renderedHash(snapshot.bytes) }
    // Persist redo history too: an undone edit remains available after a disconnected client returns.
    const key = recordKey(record.sessionId, record.path)
    if (record.groups.length) await drafts.put(key, persisted)
    else await drafts.delete(key)
    copy.record = persisted
    copy.snapshot = snapshot
    checkedSources.set(copy.id, { original: record.original, sourceHash: record.sourceHash })
    rememberRender(copy.id, persisted, snapshot)
    return snapshot
  }

  async function open(sessionId: string, address: string, agent: PdfAgent, signal: AbortSignal) {
    const file = sessionFile(address)
    if (file.sessionId !== sessionId) fail('pdf/session-mismatch', 'The file address belongs to a different session')
    const path = await files.resolvePath(agent, file.path, signal)
    let source: PdfFileRead | undefined
    try { source = await files.read(agent, path, signal) }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'PDF_NOT_FOUND')) throw error
    }
    const key = recordKey(sessionId, path)
    const existingId = byPath.get(key)
    if (existingId) {
      const copy = copies.get(existingId)!
      const conflict = copy.record.sourceHash !== source?.version
      if (source && !conflict && copy.record.sourceVersion !== source.fsVersion) {
        // A touch or byte-identical external replacement updates the preview
        // owner's observed filesystem version without changing draft revision.
        copy.record = { ...copy.record, sourceVersion: source.fsVersion }
        copy.snapshot = { ...copy.snapshot, sourceVersion: source.fsVersion }
      }
      if (source && conflict && !copy.snapshot.dirty && copy.record.groups.length === 0) {
        return publish(copy, fresh(sessionId, source, copy.record.revision + 1), false, signal, await sourcePdf(source))
      }
      copy.snapshot = { ...copy.snapshot, conflict }
      return copy.snapshot
    }
    const saved = drafts.get(key)
    if (!source && !saved) fail('PDF_NOT_FOUND', 'PDF file does not exist and no saved draft is available')
    let record = saved ? draftSchema.parse(saved) : fresh(sessionId, source!)
    if (record.sessionId !== sessionId || pathKey(record.path) !== pathKey(path)) {
      fail('pdf/draft-mismatch', 'The saved draft does not belong to this file and session')
    }
    if (source && record.sourceHash === source.version && record.sourceVersion !== source.fsVersion) {
      record = { ...record, sourceVersion: source.fsVersion }
    }
    const id = randomUUID()
    let snapshot = await materialize(id, record, record.sourceHash !== source?.version,
      saved ? undefined : await sourcePdf(source!))
    signal.throwIfAborted()
    // A file may have committed just before the connection or draft cleanup
    // failed. Exact output equality proves that recovery need not reapply it.
    const alreadySaved = saved && source && (record.renderedHash === source.version || renderedHash(snapshot.bytes) === source.version)
    if (saved && source && (record.groups.length === 0 || alreadySaved)) {
      const contentVersion = alreadySaved ? record.contentVersion : randomUUID()
      record = fresh(sessionId, source, record.revision + 1, contentVersion)
      snapshot = await materialize(id, record, false, await sourcePdf(source))
      try { await drafts.delete(key) } catch (error) {
        snapshot = { ...snapshot, warning: `The PDF is saved, but recovered draft cleanup failed: ${errorText(error)}` }
      }
    }
    signal.throwIfAborted()
    copies.set(id, { id, record, snapshot })
    byPath.set(key, id)
    checkedSources.set(id, { original: record.original, sourceHash: record.sourceHash })
    rememberRender(id, record, snapshot)
    return snapshot
  }

  async function run(raw: Record<string, unknown>, agent: PdfAgent, signal: AbortSignal) {
    const input = requestSchema.parse(raw)
    if (input.sessionId !== agent.session.id) fail('pdf/session-mismatch', 'Session identity mismatch')
    if (input.action === 'open') return open(input.sessionId, input.address, agent, signal)
    if (input.action === 'inspectTarget') {
      try { return { version: (await files.read(agent, input.path, signal)).version } }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'PDF_NOT_FOUND') return { version: null }
        throw error
      }
    }
    if (input.action === 'discardMany' || input.action === 'discardAddresses') {
      const keys = new Set<string>()
      const ids = new Set(input.action === 'discardMany' ? input.ids : [])
      if (input.action === 'discardAddresses') {
        for (const address of input.addresses) {
          const file = sessionFile(address)
          if (file.sessionId !== input.sessionId) fail('pdf/session-mismatch', 'PDF draft address belongs to another session')
          if (!/\.pdf$/i.test(file.path)) fail('pdf/invalid-address', 'Only PDF draft addresses can be discarded')
          const cwd = agent.session.header.cwd
          if (!isAbsolute(file.path) && (!cwd || !isAbsolute(cwd))) fail('pdf/invalid-address', 'A relative PDF draft needs the session working directory')
          // These keys address plugin-owned storage, not filesystem mutations.
          // Lexical resolution also works after the PDF or its directory vanished.
          const key = recordKey(input.sessionId, resolve(cwd ?? '', file.path))
          keys.add(key)
          const id = byPath.get(key)
          if (id) ids.add(id)
        }
      }
      // Validate every owner before deleting anything. Unknown IDs are already
      // disposed, making cleanup safe to retry after a lost response.
      for (const id of ids) {
        const copy = copies.get(id)
        if (copy && copy.record.sessionId !== input.sessionId) fail('pdf/session-mismatch', 'Working copy belongs to another session')
        if (copy) keys.add(recordKey(copy.record.sessionId, copy.record.path))
      }
      const failures: string[] = []
      const disposedIds = new Set<string>()
      for (const key of keys) {
        try {
          await drafts.delete(key)
          const id = byPath.get(key)
          if (!id) continue
          copies.delete(id)
          if (byPath.get(key) === id) byPath.delete(key)
          checkedSources.delete(id)
          disposedIds.add(id)
        } catch (error) { failures.push(errorText(error)) }
      }
      for (const [cacheKey, entry] of rendered) if (disposedIds.has(entry.owner)) dropRender(cacheKey)
      if (failures.length) fail('pdf/discard-failed', `Could not discard PDF drafts: ${failures.join('; ')}`)
      return { discarded: [...ids] }
    }
    const copy = copies.get(input.id)
    if (!copy || copy.record.sessionId !== input.sessionId) fail('pdf/unknown-document', 'Reopen this PDF in the current session')
    if (copy.record.revision !== input.revision) fail('pdf/stale-revision', 'The working copy changed in another tab; reopen it to load the latest draft')
    const record = copy.record
    if (input.action === 'discard') {
      // The baseline survives external file removal and includes a successful
      // manual save. Drop both undo and redo; never touch the source file.
      return publish(copy, { ...record, groups: [], cursor: 0, revision: record.revision + 1 }, undefined, signal)
    }
    if (input.action === 'reload') {
      const source = await files.read(agent, record.path, signal)
      return publish(copy, fresh(input.sessionId, source, record.revision + 1), false, signal, await sourcePdf(source))
    }
    if (input.action === 'save') {
      if (copy.snapshot.document.readOnly) fail('pdf/read-only', copy.snapshot.document.readOnlyReason ?? 'This PDF is read-only')
      const target = await files.resolvePath(agent, input.options.path ?? record.path, signal)
      const same = pathKey(target) === pathKey(record.path)
      const targetKey = recordKey(input.sessionId, target)
      if (!same && byPath.has(targetKey)) fail('pdf/target-open', 'The destination already has a working copy; choose another path')
      if (!same && drafts.get(targetKey)?.groups.length) fail('pdf/target-draft', 'The destination has a saved draft; open it first or choose another path')
      const expected = same ? record.sourceHash : input.options.expectedTargetVersion ?? null
      if (!same && expected !== null && input.options.overwrite !== true) fail('pdf/overwrite-required', 'Explicit replacement confirmation is required')
      // Materialization has already validated these immutable bytes. The file adapter
      // takes its own write buffer; retaining identity also avoids reopening the reader on save.
      const committedBytes = copy.snapshot.bytes
      const document = copy.snapshot.document
      signal.throwIfAborted()
      try {
        const saved = await files.save(agent, target, committedBytes, expected, { overwrite: input.options.overwrite, signal })
        const source = { ...saved, bytes: committedBytes }
        const next = fresh(input.sessionId, source, record.revision + 1, record.contentVersion)
        const snapshot: WorkspaceSnapshot = {
          id: copy.id, path: next.path, sourceVersion: next.sourceVersion, contentVersion: next.contentVersion,
          revision: next.revision, dirty: false, canUndo: false, canRedo: false, conflict: false,
          document, bytes: committedBytes,
        }
        // The PDF has committed. Keep the in-memory revision aligned even if draft cleanup fails.
        copy.record = next
        copy.snapshot = snapshot
        checkedSources.set(copy.id, { original: next.original, sourceHash: next.sourceHash })
        hashes.set(committedBytes, next.sourceHash)
        rememberRender(copy.id, next, snapshot)
        byPath.delete(recordKey(input.sessionId, record.path))
        byPath.set(recordKey(input.sessionId, saved.path), copy.id)
        const cleanupKeys = new Set([recordKey(input.sessionId, record.path), targetKey])
        const cleanupFailures: string[] = []
        for (const key of cleanupKeys) {
          try { await drafts.delete(key) } catch (error) { cleanupFailures.push(errorText(error)) }
        }
        if (cleanupFailures.length) {
          copy.snapshot = { ...snapshot, warning: `PDF saved to ${saved.path}, but draft cleanup failed: ${cleanupFailures.join('; ')}` }
        }
        return copy.snapshot
      } catch (error) {
        if (error instanceof Error && 'code' in error && (error.code === 'PDF_STALE_VERSION' || error.code === 'PDF_SAVE_UNCERTAIN') && same) {
          copy.snapshot = { ...copy.snapshot, conflict: true }
        }
        throw error
      }
    }
    if (copy.snapshot.document.readOnly) fail('pdf/read-only', 'This PDF cannot be edited')
    signal.throwIfAborted()
    if (input.action === 'undo') {
      if (!record.cursor) return copy.snapshot
      return publish(copy, { ...record, cursor: record.cursor - 1, revision: record.revision + 1 }, undefined, signal)
    }
    if (input.action === 'redo') {
      if (record.cursor === record.groups.length) return copy.snapshot
      return publish(copy, { ...record, cursor: record.cursor + 1, revision: record.revision + 1 }, undefined, signal)
    }
    if (input.action !== 'change') fail('pdf/invalid-action', 'Unknown PDF operation')
    if (record.cursor >= 500) fail('pdf/history-limit', 'Save the PDF before making more edits')
    // The editor preserves annotation IDs across serialization, so an edit needs
    // only the latest bytes and this batch. Durable recovery still replays the original history.
    const pdf = await applyPdfOperations(copy.snapshot.bytes, input.operations)
    return publish(copy, { ...record, groups: [...record.groups.slice(0, record.cursor), input.operations],
      cursor: record.cursor + 1, revision: record.revision + 1 }, undefined, signal, pdf)
  }

  return {
    async dispatch(sessionId: string, input: Record<string, unknown>, agent: PdfAgent, signal: AbortSignal) {
      if (closing) fail('pdf/unavailable', 'The PDF plugin is unloading')
      if (input.sessionId !== sessionId || sessionId !== agent.session.id) fail('pdf/session-mismatch', 'Session identity mismatch')
      const before = queues.get(sessionId) ?? Promise.resolve()
      const task = before.catch(() => undefined).then(() => { signal.throwIfAborted(); return run(input, agent, signal) })
      queues.set(sessionId, task)
      try {
        const value = await task
        if (!('bytes' in value)) return value
        const bytesHash = renderedHash(value.bytes)
        if (input.knownBytesHash === bytesHash) return { ...value, bytes: undefined, document: undefined, bytesHash }
        let wireBytes = encoded.get(value.bytes)
        if (!wireBytes) {
          wireBytes = base64(value.bytes)
          if (value.bytes.byteLength <= encodedCacheBytes) encoded.set(value.bytes, wireBytes)
        }
        return { ...value, bytes: wireBytes, bytesHash }
      } finally { if (queues.get(sessionId) === task) queues.delete(sessionId) }
    },
    dispose(): Promise<void> {
      if (disposal) return disposal
      closing = true
      disposal = (async () => {
        await Promise.allSettled([...queues.values()])
        copies.clear(); byPath.clear(); queues.clear(); rendered.clear(); checkedSources.clear(); cachedBytes = 0
      })()
      return disposal
    },
  }
}
