import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { applyPdfOperations } from '../core/pdf-document.ts'
import { projectPdfOperations } from '../core/pdf-operation-projection.ts'
import type { PdfAnnotationOperation, PdfDocumentInfo } from '../core/pdf-types.ts'
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
  record: WorkspaceRecord
  baseline: PdfDocumentInfo
  snapshot: WorkspaceSnapshot
}
type Files = ReturnType<typeof createLocalFiles>
type RenderedPdf = Pick<WorkspaceSnapshot, 'bytes' | 'document'>
type WorkspaceRecord = DraftRecord & { groupDates: string[] }

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
  const hashes = new WeakMap<Uint8Array, string>()
  const encoded = new WeakMap<Uint8Array, string>()
  let closing = false
  let disposal: Promise<void> | undefined

  function renderedHash(bytes: Uint8Array): string {
    let value = hashes.get(bytes)
    if (!value) { value = contentHash(bytes); hashes.set(bytes, value) }
    return value
  }

  function baselineKey(record: WorkspaceRecord): string {
    return `base_${recordKey(record.sessionId, record.path)}_${record.sourceHash.slice(7)}`
  }

  function operationsThrough(record: WorkspaceRecord): { operations: PdfAnnotationOperation[]; dates: string[] } {
    const operations: PdfAnnotationOperation[] = []
    const dates: string[] = []
    for (let index = 0; index < record.cursor; index++) {
      for (const operation of record.groups[index]) {
        operations.push(operation)
        dates.push(record.groupDates[index])
      }
    }
    return { operations, dates }
  }

  function projectedDocument(baseline: PdfDocumentInfo, record: WorkspaceRecord): PdfDocumentInfo {
    if (!record.cursor) return baseline
    const { operations, dates } = operationsThrough(record)
    return projectPdfOperations(baseline, operations, dates)
  }

  function snapshotFor(id: string, record: WorkspaceRecord, baseline: PdfDocumentInfo,
    bytes: Uint8Array, document: PdfDocumentInfo, conflict: boolean): WorkspaceSnapshot {
    return {
      id, path: record.path, sourceVersion: record.sourceVersion, contentVersion: record.contentVersion,
      revision: record.revision, dirty: record.cursor > 0,
      canUndo: record.cursor > 0, canRedo: record.cursor < record.groups.length,
      conflict, document, baselineAnnotations: baseline.annotations, bytes,
    }
  }

  function hydrate(saved: DraftRecord): WorkspaceRecord {
    const baseline = saved.original ? saved : saved.baseKey ? drafts.get(saved.baseKey) : undefined
    if (!baseline?.original || baseline.sourceHash !== saved.sourceHash
      || baseline.sessionId !== saved.sessionId || pathKey(baseline.path) !== pathKey(saved.path)) {
      fail('pdf/draft-damaged', 'Saved draft baseline is missing or does not belong to this file')
    }
    return { ...saved, original: baseline.original,
      groupDates: saved.groupDates ?? saved.groups.map(() => new Date().toISOString()) }
  }

  async function baselinePdf(record: WorkspaceRecord): Promise<RenderedPdf> {
    if (!record.original) fail('pdf/draft-damaged', 'Saved draft baseline is missing')
    const bytes = Buffer.from(record.original, 'base64')
    if (base64(bytes) !== record.original || renderedHash(bytes) !== record.sourceHash) {
      fail('pdf/draft-damaged', 'Saved draft source bytes failed their integrity check')
    }
    return { bytes, document: await loadPdfForReading(bytes) }
  }

  function fresh(sessionId: string, source: PdfFileRead, revision = 0, contentVersion: string = randomUUID()): WorkspaceRecord {
    return { format: 1, sessionId, path: source.path, sourceHash: source.version,
      sourceVersion: source.fsVersion, contentVersion,
      revision, groups: [], groupDates: [], cursor: 0 }
  }

  async function sourcePdf(source: PdfFileRead): Promise<RenderedPdf> {
    // The file adapter has already checked the digest. A fresh working copy can
    // inspect those exact bytes without encoding, decoding and hashing another copy.
    hashes.set(source.bytes, source.version)
    return { bytes: source.bytes, document: await loadPdfForReading(source.bytes) }
  }

  async function persist(record: WorkspaceRecord, sourceKey: string, baselineBytes: Uint8Array,
    materializedHash?: string): Promise<WorkspaceRecord> {
    if (!record.groups.length) {
      await drafts.delete(sourceKey)
      return record
    }
    const baseKey = record.baseKey ?? baselineKey(record)
    if (!record.baseKey) {
      const base: DraftRecord = {
        ...record, original: record.original ?? base64(baselineBytes), baseKey: undefined,
        groups: [], groupDates: [], cursor: 0, renderedHash: undefined,
      }
      await drafts.put(baseKey, base)
    }
    const persisted: DraftRecord = {
      ...record, original: undefined, baseKey, renderedHash: materializedHash,
    }
    await drafts.put(sourceKey, persisted)
    return { ...record, original: undefined, baseKey, renderedHash: materializedHash }
  }

  async function deleteBaseline(record: DraftRecord) {
    if (record.baseKey) await drafts.delete(record.baseKey)
  }

  async function publish(copy: WorkingCopy, record: WorkspaceRecord, conflict = copy.snapshot.conflict,
    signal?: AbortSignal, document?: PdfDocumentInfo, source?: RenderedPdf) {
    const baseline = source?.document ?? copy.baseline
    const bytes = source?.bytes ?? copy.snapshot.bytes
    const snapshot = snapshotFor(copy.id, record, baseline, bytes,
      document ?? projectedDocument(baseline, record), conflict)
    signal?.throwIfAborted()
    const key = recordKey(record.sessionId, record.path)
    // A redo branch remains durable. Only the small operation record is rewritten.
    const previous = copy.record
    const persisted = await persist(record, key, bytes)
    copy.record = persisted
    copy.baseline = baseline
    copy.snapshot = snapshot
    if (!record.groups.length) await deleteBaseline(previous).catch(() => undefined)
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
        return publish(copy, fresh(sessionId, source, copy.record.revision + 1), false, signal, undefined, await sourcePdf(source))
      }
      copy.snapshot = { ...copy.snapshot, conflict }
      return copy.snapshot
    }
    const saved = drafts.get(key)
    if (!source && !saved) fail('PDF_NOT_FOUND', 'PDF file does not exist and no saved draft is available')
    const stored = saved ? draftSchema.parse(saved) : undefined
    if (stored && (stored.sessionId !== sessionId || pathKey(stored.path) !== pathKey(path))) {
      fail('pdf/draft-mismatch', 'The saved draft does not belong to this file and session')
    }
    const id = randomUUID()
    // A file may have committed just before the connection or draft cleanup
    // failed. A hash persisted before the write proves that recovery is complete.
    const alreadySaved = stored && source && stored.renderedHash !== stored.sourceHash
      && stored.renderedHash === source.version
    let record: WorkspaceRecord
    let baseline: RenderedPdf
    let snapshot: WorkspaceSnapshot
    if (stored && source && (stored.groups.length === 0 || alreadySaved)) {
      record = fresh(sessionId, source, stored.revision + 1,
        alreadySaved ? stored.contentVersion : randomUUID())
      baseline = await sourcePdf(source)
      snapshot = snapshotFor(id, record, baseline.document, baseline.bytes, baseline.document, false)
      try {
        await drafts.delete(key)
        await deleteBaseline(stored)
      } catch (error) {
        snapshot = { ...snapshot, warning: `The PDF is saved, but recovered draft cleanup failed: ${errorText(error)}` }
      }
    } else {
      record = stored ? hydrate(stored) : fresh(sessionId, source!)
      if (source && record.sourceHash === source.version && record.sourceVersion !== source.fsVersion) {
        record = { ...record, sourceVersion: source.fsVersion }
      }
      baseline = stored ? await baselinePdf(record) : await sourcePdf(source!)
      snapshot = snapshotFor(id, record, baseline.document, baseline.bytes,
        projectedDocument(baseline.document, record), record.sourceHash !== source?.version)
      if (stored && (!stored.baseKey || !stored.groupDates)) {
        // Migrate the old inline-byte draft once, preserving its undo/redo branch.
        record = await persist(record, key, baseline.bytes)
      }
      record = { ...record, original: undefined }
    }
    signal.throwIfAborted()
    copies.set(id, { id, record, baseline: baseline.document, snapshot })
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
      for (const key of keys) {
        try {
          const currentId = byPath.get(key)
          const stored = drafts.get(key) ?? (currentId ? copies.get(currentId)?.record : undefined)
          await drafts.delete(key)
          const id = byPath.get(key)
          if (id) {
            copies.delete(id)
            if (byPath.get(key) === id) byPath.delete(key)
          }
          if (stored) await deleteBaseline(stored).catch(() => undefined)
        } catch (error) { failures.push(errorText(error)) }
      }
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
      return publish(copy, { ...record, groups: [], groupDates: [], cursor: 0, revision: record.revision + 1 }, undefined, signal)
    }
    if (input.action === 'reload') {
      const source = await files.read(agent, record.path, signal)
      return publish(copy, fresh(input.sessionId, source, record.revision + 1), false, signal, undefined, await sourcePdf(source))
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
      // Materialize the active operation prefix once, only at the save boundary.
      const { operations, dates } = operationsThrough(record)
      const committed = operations.length
        ? await applyPdfOperations(copy.snapshot.bytes, operations, dates)
        : { bytes: copy.snapshot.bytes, document: copy.baseline }
      const committedBytes = committed.bytes
      const document = committed.document
      signal.throwIfAborted()
      if (record.groups.length && renderedHash(committedBytes) !== record.sourceHash) {
        // Persist the exact output identity before publication. A crash after
        // rename but before draft cleanup can then recognize the committed PDF.
        // Equal bytes cannot prove a save happened; preserve a redo-only draft
        // if such a save fails before publication.
        copy.record = await persist(record, recordKey(record.sessionId, record.path),
          copy.snapshot.bytes, renderedHash(committedBytes))
      }
      try {
        const saved = await files.save(agent, target, committedBytes, expected, { overwrite: input.options.overwrite, signal })
        const source = { ...saved, bytes: committedBytes }
        const next = fresh(input.sessionId, source, record.revision + 1, record.contentVersion)
        const snapshot: WorkspaceSnapshot = {
          id: copy.id, path: next.path, sourceVersion: next.sourceVersion, contentVersion: next.contentVersion,
          revision: next.revision, dirty: false, canUndo: false, canRedo: false, conflict: false,
          document, baselineAnnotations: document.annotations, bytes: committedBytes,
        }
        // The PDF has committed. Keep the in-memory revision aligned even if draft cleanup fails.
        copy.record = next
        copy.baseline = document
        copy.snapshot = snapshot
        hashes.set(committedBytes, next.sourceHash)
        byPath.delete(recordKey(input.sessionId, record.path))
        byPath.set(recordKey(input.sessionId, saved.path), copy.id)
        const cleanupKeys = new Set([recordKey(input.sessionId, record.path), targetKey])
        const cleanupFailures: string[] = []
        for (const key of cleanupKeys) {
          try { await drafts.delete(key) } catch (error) { cleanupFailures.push(errorText(error)) }
        }
        try { await deleteBaseline(record) } catch (error) { cleanupFailures.push(errorText(error)) }
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
      const document = projectPdfOperations(copy.snapshot.document, record.groups[record.cursor], record.groupDates[record.cursor])
      return publish(copy, { ...record, cursor: record.cursor + 1, revision: record.revision + 1 }, undefined, signal, document)
    }
    if (input.action !== 'change') fail('pdf/invalid-action', 'Unknown PDF operation')
    if (record.cursor >= 500) fail('pdf/history-limit', 'Save the PDF before making more edits')
    const groupDate = new Date().toISOString()
    const document = projectPdfOperations(copy.snapshot.document, input.operations, groupDate)
    return publish(copy, { ...record, groups: [...record.groups.slice(0, record.cursor), input.operations],
      groupDates: [...record.groupDates.slice(0, record.cursor), groupDate],
      cursor: record.cursor + 1, revision: record.revision + 1 }, undefined, signal, document)
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
        if (input.knownBytesHash === bytesHash) return { ...value, bytes: undefined, bytesHash }
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
        copies.clear(); byPath.clear(); queues.clear()
      })()
      return disposal
    },
  }
}
