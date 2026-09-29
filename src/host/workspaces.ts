import { createHash, randomUUID } from 'node:crypto'
import { applyPdfOperations, loadPdfDocument } from '../core/pdf-document.ts'
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
  let closing = false
  let disposal: Promise<void> | undefined

  async function materialize(id: string, record: DraftRecord, conflict = false): Promise<WorkspaceSnapshot> {
    const original = new Uint8Array(Buffer.from(record.original, 'base64'))
    if (Buffer.from(original).toString('base64') !== record.original || contentHash(original) !== record.sourceHash) {
      fail('pdf/draft-damaged', 'Saved draft source bytes failed their integrity check')
    }
    const operations = record.groups.slice(0, record.cursor).flat()
    const { bytes, document } = operations.length
      ? await applyPdfOperations(original, operations)
      : { bytes: original, document: await loadPdfDocument(original) }
    return {
      id, path: record.path, sourceVersion: record.sourceVersion, contentVersion: record.contentVersion,
      revision: record.revision, dirty: record.cursor > 0,
      canUndo: record.cursor > 0, canRedo: record.cursor < record.groups.length,
      conflict, document, bytes,
    }
  }

  function fresh(sessionId: string, source: PdfFileRead, revision = 0, contentVersion: string = randomUUID()): DraftRecord {
    return { format: 1, sessionId, path: source.path, sourceHash: source.version,
      sourceVersion: source.fsVersion, contentVersion, original: Buffer.from(source.bytes).toString('base64'),
      revision, groups: [], cursor: 0 }
  }

  async function publish(copy: WorkingCopy, record: DraftRecord, conflict = copy.snapshot.conflict, signal?: AbortSignal) {
    const snapshot = await materialize(copy.id, record, conflict)
    signal?.throwIfAborted()
    const persisted = { ...record, renderedHash: contentHash(snapshot.bytes) }
    // Persist redo history too: an undone edit remains available after a disconnected client returns.
    const key = recordKey(record.sessionId, record.path)
    if (record.groups.length) await drafts.put(key, persisted)
    else await drafts.delete(key)
    copy.record = persisted
    copy.snapshot = snapshot
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
        return publish(copy, fresh(sessionId, source, copy.record.revision + 1), false, signal)
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
    let snapshot = await materialize(id, record, record.sourceHash !== source?.version)
    signal.throwIfAborted()
    // A file may have committed just before the connection or draft cleanup
    // failed. Exact output equality proves that recovery need not reapply it.
    const alreadySaved = source && (record.renderedHash === source.version || contentHash(snapshot.bytes) === source.version)
    if (saved && source && (record.groups.length === 0 || alreadySaved)) {
      const contentVersion = alreadySaved ? record.contentVersion : randomUUID()
      record = fresh(sessionId, source, record.revision + 1, contentVersion)
      snapshot = await materialize(id, record, false)
      try { await drafts.delete(key) } catch (error) {
        snapshot = { ...snapshot, warning: `The PDF is saved, but recovered draft cleanup failed: ${errorText(error)}` }
      }
    }
    signal.throwIfAborted()
    copies.set(id, { id, record, snapshot })
    byPath.set(key, id)
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
    const copy = copies.get(input.id)
    if (!copy || copy.record.sessionId !== input.sessionId) fail('pdf/unknown-document', 'Reopen this PDF in the current session')
    if (copy.record.revision !== input.revision) fail('pdf/stale-revision', 'The working copy changed in another tab; reopen it to load the latest draft')
    const record = copy.record
    if (input.action === 'reload') {
      const source = await files.read(agent, record.path, signal)
      return publish(copy, fresh(input.sessionId, source, record.revision + 1), false, signal)
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
      // All PDF parsing finishes before publication. Post-commit bookkeeping
      // cannot turn a successful filesystem save into an ordinary parse error.
      const committedBytes = copy.snapshot.bytes.slice()
      const document = await loadPdfDocument(committedBytes)
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
    return publish(copy, { ...record, groups: [...record.groups.slice(0, record.cursor), input.operations],
      cursor: record.cursor + 1, revision: record.revision + 1 }, undefined, signal)
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
        return 'bytes' in value ? { ...value, bytes: Buffer.from(value.bytes).toString('base64') } : value
      } finally { if (queues.get(sessionId) === task) queues.delete(sessionId) }
    },
    dispose(): Promise<void> {
      if (disposal) return disposal
      closing = true
      disposal = (async () => { await Promise.allSettled([...queues.values()]); copies.clear(); byPath.clear(); queues.clear() })()
      return disposal
    },
  }
}
