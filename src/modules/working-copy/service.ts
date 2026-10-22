import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { decodePdfBaseline, digestPdfBytes, encodePdfBaseline } from '../document/index.js'
import { appendGroup, moveCursor, projectedDocument, projectWorkingCopyOperations } from './history.js'
import { saveWorkingCopy } from './save.js'
import { freshRecord, workspaceSnapshot, type WorkingCopyState } from './state.js'
import type { PdfDocumentInfo } from '../../core/pdf-types.js'
import type {
  HostWorkspaceSnapshot, PdfDocumentPort, WorkingCopyDraftPort, WorkingCopyAgent, WorkingCopyFilePort, WorkingCopyFileRead,
} from './ports.js'
import { sessionFile } from '../../shared/address.js'
import { beginPdfSpan } from '../../shared/performance.js'
import { requestSchema } from '../../contracts/rpc/index.js'
import { draftSchema, type DraftRecord, type WorkspaceRecord } from './schema.js'

export type { HostWorkspaceSnapshot } from './ports.js'
type RenderedPdf = Pick<HostWorkspaceSnapshot, 'bytes' | 'document'>
function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** Authoritative working copies, serialized per session. A draft is durable before the UI accepts it. */
export function createWorkingCopyService(files: WorkingCopyFilePort, drafts: WorkingCopyDraftPort, pdf: PdfDocumentPort) {
  const copies = new Map<string, WorkingCopyState>()
  const byPath = new Map<string, string>()
  // Once a Client has opened a copy it must never be evicted by an Agent tool.
  const uiOwned = new Set<string>()
  const queues = new Map<string, Promise<unknown>>()
  const revisionListeners = new Map<string, Set<() => void>>()
  const hashes = new WeakMap<Uint8Array, string>()
  let closing = false
  let disposal: Promise<void> | undefined

  function renderedHash(bytes: Uint8Array): string {
    let value = hashes.get(bytes)
    if (!value) { value = digestPdfBytes(bytes); hashes.set(bytes, value) }
    return value
  }

  async function restoreMissingBaseline(saved: DraftRecord, source: WorkingCopyFileRead | undefined): Promise<RenderedPdf | undefined> {
    if (saved.original || !saved.baseKey || drafts.get(saved.baseKey)) return undefined
    // Draft operations refer to the original bytes. A changed or missing file
    // cannot replace that baseline without silently applying edits to another PDF.
    if (!source || source.version !== saved.sourceHash) {
      fail('pdf/draft-damaged', 'Saved draft baseline is missing and the original PDF is unavailable or has changed')
    }
    const baseline = await sourcePdf(source)
    await drafts.put(saved.baseKey, {
      ...saved, original: encodePdfBaseline(baseline.bytes), baseKey: undefined,
      groups: [], groupDates: [], cursor: 0, renderedHash: undefined,
    })
    return baseline
  }

  async function baselinePdf(record: WorkspaceRecord): Promise<RenderedPdf> {
    if (!record.original) fail('pdf/draft-damaged', 'Saved draft baseline is missing')
    const bytes = decodePdfBaseline(record.original, record.sourceHash)
    return { bytes, document: await pdf.inspect(bytes) }
  }

  async function sourcePdf(source: WorkingCopyFileRead): Promise<RenderedPdf> {
    // The file adapter has already checked the digest. A fresh working copy can
    // inspect those exact bytes without encoding, decoding and hashing another copy.
    hashes.set(source.bytes, source.version)
    return { bytes: source.bytes, document: await pdf.inspect(source.bytes) }
  }

  async function recoverCommitted(copy: WorkingCopyState, source: WorkingCopyFileRead, signal?: AbortSignal): Promise<HostWorkspaceSnapshot> {
    const previous = copy.record
    const committed = await sourcePdf(source)
    signal?.throwIfAborted()
    const next = freshRecord(previous.sessionId, source, previous.revision + 1, previous.contentVersion)
    const snapshot = workspaceSnapshot(copy.id, next, committed.document, committed.bytes, committed.document, false)
    // The on-disk digest proves the materialized draft was published. Make the
    // live copy clean before attempting storage cleanup, which may fail again.
    copy.record = next
    copy.baseline = committed.document
    copy.snapshot = snapshot
    const key = drafts.key(previous.sessionId, previous.path)
    const cleanupFailures: string[] = []
    let draftDeleted = false
    try { await drafts.delete(key); draftDeleted = true } catch (error) { cleanupFailures.push(errorText(error)) }
    if (draftDeleted) {
      try { await drafts.deleteBaseline(previous) } catch (error) { cleanupFailures.push(errorText(error)) }
    }
    if (cleanupFailures.length) {
      copy.snapshot = { ...snapshot, warning: `PDF saved to ${source.path}, but draft cleanup failed: ${cleanupFailures.join('; ')}` }
    }
    return copy.snapshot
  }

  async function publish(copy: WorkingCopyState, record: WorkspaceRecord, conflict = copy.snapshot.conflict,
    signal?: AbortSignal, document?: PdfDocumentInfo, source?: RenderedPdf) {
    const baseline = source?.document ?? copy.baseline
    const bytes = source?.bytes ?? copy.snapshot.bytes
    const snapshot = workspaceSnapshot(copy.id, record, baseline, bytes,
      document ?? projectedDocument(baseline, record), conflict)
    signal?.throwIfAborted()
    const key = drafts.key(record.sessionId, record.path)
    // A redo branch remains durable. Only the small operation record is rewritten.
    const previous = copy.record
    const persisted = await drafts.persist(record, key, bytes)
    copy.record = persisted
    copy.baseline = baseline
    copy.snapshot = snapshot
    if (!record.groups.length) await drafts.deleteBaseline(previous).catch(() => undefined)
    return snapshot
  }

  async function open(sessionId: string, address: string, owner: 'ui' | 'agent', agent: WorkingCopyAgent, signal: AbortSignal) {
    const file = sessionFile(address)
    if (file.sessionId !== sessionId) fail('pdf/session-mismatch', 'The file address belongs to a different session')
    const path = await files.resolvePath(agent, file.path, signal)
    let source: WorkingCopyFileRead | undefined
    try { source = await files.read(agent, path, signal) }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'PDF_NOT_FOUND')) throw error
    }
    const key = drafts.key(sessionId, path)
    const existingId = byPath.get(key)
    if (existingId) {
      if (owner === 'ui') uiOwned.add(existingId)
      const copy = copies.get(existingId)!
      if (source && copy.record.renderedHash && copy.record.renderedHash !== copy.record.sourceHash
        && copy.record.renderedHash === source.version) {
        return recoverCommitted(copy, source, signal)
      }
      const conflict = copy.record.sourceHash !== source?.version
      if (source && !conflict && copy.record.sourceVersion !== source.fsVersion) {
        // A touch or byte-identical external replacement updates the preview
        // owner's observed filesystem version without changing draft revision.
        copy.record = { ...copy.record, sourceVersion: source.fsVersion }
        copy.snapshot = { ...copy.snapshot, sourceVersion: source.fsVersion }
      }
      if (source && conflict && !copy.snapshot.dirty && copy.record.groups.length === 0) {
        return publish(copy, freshRecord(sessionId, source, copy.record.revision + 1), false, signal, undefined, await sourcePdf(source))
      }
      copy.snapshot = { ...copy.snapshot, conflict }
      return copy.snapshot
    }
    const saved = drafts.get(key)
    if (!source && !saved) fail('PDF_NOT_FOUND', 'PDF file does not exist and no saved draft is available')
    const stored = saved ? draftSchema.parse(saved) : undefined
    if (stored && (stored.sessionId !== sessionId || !drafts.samePath(stored.path, path))) {
      fail('pdf/draft-mismatch', 'The saved draft does not belong to this file and session')
    }
    const id = randomUUID()
    // A file may have committed just before the connection or draft cleanup
    // failed. A hash persisted before the write proves that recovery is complete.
    const alreadySaved = stored && source && stored.renderedHash !== stored.sourceHash
      && stored.renderedHash === source.version
    let record: WorkspaceRecord
    let baseline: RenderedPdf
    let snapshot: HostWorkspaceSnapshot
    if (stored && source && (stored.groups.length === 0 || alreadySaved)) {
      record = freshRecord(sessionId, source, stored.revision + 1,
        alreadySaved ? stored.contentVersion : randomUUID())
      baseline = await sourcePdf(source)
      snapshot = workspaceSnapshot(id, record, baseline.document, baseline.bytes, baseline.document, false)
      try {
        await drafts.delete(key)
        await drafts.deleteBaseline(stored)
      } catch (error) {
        snapshot = { ...snapshot, warning: `The PDF is saved, but recovered draft cleanup failed: ${errorText(error)}` }
      }
    } else {
      const restoredBaseline = stored ? await restoreMissingBaseline(stored, source) : undefined
      record = stored ? drafts.hydrate(stored) : freshRecord(sessionId, source!)
      if (source && record.sourceHash === source.version && record.sourceVersion !== source.fsVersion) {
        record = { ...record, sourceVersion: source.fsVersion }
      }
      baseline = restoredBaseline ?? (stored ? await baselinePdf(record) : await sourcePdf(source!))
      snapshot = workspaceSnapshot(id, record, baseline.document, baseline.bytes,
        projectedDocument(baseline.document, record), record.sourceHash !== source?.version)
      if (stored && (!stored.baseKey || !stored.groupDates)) {
        // Migrate the old inline-byte draft once, preserving its undo/redo branch.
        record = await drafts.persist(record, key, baseline.bytes)
      }
      record = { ...record, original: undefined }
    }
    signal.throwIfAborted()
    copies.set(id, { id, record, baseline: baseline.document, snapshot })
    byPath.set(key, id)
    if (owner === 'ui') uiOwned.add(id)
    return snapshot
  }

  async function discardCopies(input: { action: 'discardMany'; sessionId: string; ids: string[] }
    | { action: 'discardAddresses'; sessionId: string; addresses: string[] }, agent: WorkingCopyAgent) {
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
        const key = drafts.key(input.sessionId, resolve(cwd ?? '', file.path))
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
      if (copy) keys.add(drafts.key(copy.record.sessionId, copy.record.path))
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
          uiOwned.delete(id)
          if (byPath.get(key) === id) byPath.delete(key)
        }
        if (stored) await drafts.deleteBaseline(stored).catch(() => undefined)
      } catch (error) { failures.push(errorText(error)) }
    }
    if (failures.length) fail('pdf/discard-failed', `Could not discard PDF drafts: ${failures.join('; ')}`)
    return { discarded: [...ids] }
  }

  async function run(raw: Record<string, unknown>, agent: WorkingCopyAgent, signal: AbortSignal) {
    const input = requestSchema.parse(raw)
    if (input.sessionId !== agent.session.id) fail('pdf/session-mismatch', 'Session identity mismatch')
    if (input.action === 'open') return open(input.sessionId, input.address, input.owner ?? 'ui', agent, signal)
    if (input.action === 'inspectTarget') {
      try { return { version: (await files.read(agent, input.path, signal)).version } }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'PDF_NOT_FOUND') return { version: null }
        throw error
      }
    }
    if (input.action === 'discardMany' || input.action === 'discardAddresses') return discardCopies(input, agent)
    const copy = copies.get(input.id)
    if (!copy || copy.record.sessionId !== input.sessionId) fail('pdf/unknown-document', 'Reopen this PDF in the current session')
    if (copy.record.revision !== input.revision) fail('pdf/stale-revision', 'The working copy changed in another tab; reopen it to load the latest draft')
    const record = copy.record
    if (input.action === 'discard') {
      // Discard the draft against the current source, not the stale baseline.
      // A missing/unreadable source leaves the draft intact so it can be saved
      // elsewhere instead of silently appearing to resolve a conflict.
      const source = await files.read(agent, record.path, signal)
      if (source.version !== record.sourceHash) {
        return publish(copy, freshRecord(input.sessionId, source, record.revision + 1), false, signal, undefined, await sourcePdf(source))
      }
      return publish(copy, { ...record, sourceVersion: source.fsVersion,
        groups: [], groupDates: [], cursor: 0, revision: record.revision + 1 }, false, signal)
    }
    if (input.action === 'reload') {
      const source = await files.read(agent, record.path, signal)
      return publish(copy, freshRecord(input.sessionId, source, record.revision + 1), false, signal, undefined, await sourcePdf(source))
    }
    if (input.action === 'save') return saveWorkingCopy({ files, drafts, pdf, byPath, renderedHash,
      rememberSavedHash: (bytes, hash) => hashes.set(bytes, hash), recoverCommitted },
    copy, input.options, input.sessionId, agent, signal)
    if (copy.snapshot.document.readOnly) fail('pdf/read-only', 'This PDF cannot be edited')
    signal.throwIfAborted()
    if (input.action === 'undo') {
      if (!record.cursor) return copy.snapshot
      return publish(copy, moveCursor(record, 'undo'), undefined, signal)
    }
    if (input.action === 'redo') {
      if (record.cursor === record.groups.length) return copy.snapshot
      const document = projectWorkingCopyOperations(copy.snapshot.document, record.groups[record.cursor], record.groupDates[record.cursor])
      return publish(copy, moveCursor(record, 'redo'), undefined, signal, document)
    }
    if (input.action !== 'change') fail('pdf/invalid-action', 'Unknown PDF operation')
    if (record.cursor >= 500) fail('pdf/history-limit', 'Save the PDF before making more edits')
    if (input.expectedSourceHash !== undefined) {
      // Model edits use a fresh source check inside this session's mutation
      // queue. Ordinary UI changes retain their established behavior.
      if (input.expectedSourceHash !== record.sourceHash) {
        fail('pdf/source-conflict', 'The PDF source identity changed since the model edit began')
      }
      const source = await files.read(agent, record.path, signal)
      if (source.version !== input.expectedSourceHash) {
        fail('pdf/source-conflict', 'The PDF source changed outside this working copy')
      }
    }
    const groupDate = new Date().toISOString()
    const document = projectWorkingCopyOperations(copy.snapshot.document, input.operations, groupDate)
    return publish(copy, appendGroup(record, input.operations, groupDate), undefined, signal, document)
  }

  async function execute(sessionId: string, input: Record<string, unknown>, agent: WorkingCopyAgent, signal: AbortSignal) {
    if (closing) fail('pdf/unavailable', 'The PDF plugin is unloading')
    if (input.sessionId !== sessionId || sessionId !== agent.session.id) fail('pdf/session-mismatch', 'Session identity mismatch')
    const before = queues.get(sessionId) ?? Promise.resolve()
    const span = beginPdfSpan('host.dispatch')
    const task = before.catch(() => undefined).then(() => { signal.throwIfAborted(); return run(input, agent, signal) })
    queues.set(sessionId, task)
    try {
      const value = await task
      if (value && typeof value === 'object' && 'id' in value && 'revision' in value
        && input.action !== 'open' && input.action !== 'inspectTarget') {
        for (const listener of revisionListeners.get(`${sessionId}\0${String(value.id)}`) ?? []) listener()
      }
      return value
    } catch (error) {
      span.end(signal.aborted ? 'cancelled' : 'error')
      throw error
    } finally {
      span.end()
      if (queues.get(sessionId) === task) queues.delete(sessionId)
    }
  }
  return {
    execute,
    async waitForRevision(sessionId: string, id: string, knownRevision: number, signal: AbortSignal): Promise<number> {
      const current = () => {
        const copy = copies.get(id)
        if (closing || !copy || copy.record.sessionId !== sessionId) fail('pdf/unknown-document', 'PDF working copy is unavailable in this session')
        return copy.snapshot.revision
      }
      signal.throwIfAborted()
      const first = current()
      if (first !== knownRevision) return first
      return new Promise<number>((resolve, reject) => {
        const key = `${sessionId}\0${id}`
        let set = revisionListeners.get(key)
        if (!set) { set = new Set(); revisionListeners.set(key, set) }
        const cleanup = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          set!.delete(onChange)
          if (!set!.size) revisionListeners.delete(key)
        }
        const onChange = () => {
          try {
            const next = current()
            if (next === knownRevision) return
            cleanup(); resolve(next)
          } catch (error) { cleanup(); reject(error) }
        }
        const onAbort = () => { cleanup(); reject(signal.reason) }
        const timer = setTimeout(() => { cleanup(); resolve(knownRevision) }, 15_000)
        set.add(onChange)
        signal.addEventListener('abort', onAbort, { once: true })
        // Close the race between the first revision check and registration.
        onChange()
      })
    },
    isUiOwned(sessionId: string, id: string): boolean {
      const copy = copies.get(id)
      if (!copy || copy.record.sessionId !== sessionId) fail('pdf/unknown-document', 'PDF working copy is unavailable in this session')
      return uiOwned.has(id)
    },
    async releaseBackground(sessionId: string, id: string): Promise<'released' | 'retained-ui' | 'already-closed'> {
      if (closing) return 'already-closed'
      // Wait behind any ongoing session mutation before removing the copy. This
      // does not delete persisted drafts, so reopening recovers unsaved work.
      const before = queues.get(sessionId) ?? Promise.resolve()
      const task = before.catch(() => undefined).then(() => {
        const copy = copies.get(id)
        if (!copy) return 'already-closed' as const
        if (copy.record.sessionId !== sessionId) fail('pdf/session-mismatch', 'Working copy belongs to another session')
        if (uiOwned.has(id)) return 'retained-ui' as const
        const key = drafts.key(sessionId, copy.record.path)
        copies.delete(id)
        if (byPath.get(key) === id) byPath.delete(key)
        return 'released' as const
      })
      queues.set(sessionId, task)
      try { return await task } finally { if (queues.get(sessionId) === task) queues.delete(sessionId) }
    },
    readSnapshot(sessionId: string, id: string): HostWorkspaceSnapshot {
      if (closing) fail('pdf/unavailable', 'The PDF plugin is unloading')
      const copy = copies.get(id)
      if (!copy) fail('pdf/unknown-document', 'PDF working copy is unavailable; reopen it')
      if (copy.record.sessionId !== sessionId) fail('pdf/session-mismatch', 'Working copy belongs to another session')
      return copy.snapshot
    },
    bytesHash: renderedHash,
    dispose(): Promise<void> {
      if (disposal) return disposal
      closing = true
      for (const listeners of [...revisionListeners.values()]) {
        for (const listener of [...listeners]) listener()
      }
      disposal = (async () => {
        await Promise.allSettled([...queues.values()])
        copies.clear(); byPath.clear(); uiOwned.clear(); queues.clear(); revisionListeners.clear()
      })()
      return disposal
    },
  }
}
