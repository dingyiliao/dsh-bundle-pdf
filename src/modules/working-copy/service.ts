import { randomUUID } from 'node:crypto'
import { basename, isAbsolute, resolve } from 'node:path'
import { PASSIVE_POLL_TIMEOUT_MS } from '../../shared/passive-poll.js'
import { decodePdfBaseline, digestPdfBytes, encodePdfBaseline } from '../document/index.js'
import { appendGroup, moveCursor, projectedDocument, projectWorkingCopyOperations } from './history.js'
import { saveWorkingCopy } from './save.js'
import { freshRecord, workspaceSnapshot, type WorkingCopyState } from './state.js'
import type { PdfDocumentInfo } from '../../core/pdf-types.js'
import type {
  HostWorkspaceSnapshot, PdfDocumentPort, WorkingCopyDraftPort, WorkingCopyAgent, WorkingCopyFilePort, WorkingCopyFileRead,
  DocumentReleaseStatus, DocumentResidency, OpenWorkingCopyDocument,
} from './ports.js'
import { sessionFile } from '../../shared/address.js'
import { beginPdfSpan } from '../../shared/performance.js'
import { requestSchema } from '../../contracts/rpc/index.js'
import { draftSchema, type DraftRecord, type WorkspaceRecord } from './schema.js'

export type { HostWorkspaceSnapshot } from './ports.js'
type RenderedPdf = Pick<HostWorkspaceSnapshot, 'bytes' | 'document'>
interface DocumentReferences { ui: Set<string>; modelReferenceId?: string; pins: number; touched: number }
interface SuspendedCopy { record: WorkspaceRecord; conflict: boolean; warning?: string }
function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** Authoritative working copies, serialized per session. A draft is durable before the UI accepts it. */
export function createWorkingCopyService(files: WorkingCopyFilePort, drafts: WorkingCopyDraftPort, pdf: PdfDocumentPort) {
  const copies = new Map<string, WorkingCopyState>()
  const byPath = new Map<string, string>()
  // Identity and ownership outlive resident PDF bytes. Both entry points share
  // this table; cache eviction must not manufacture a new document identity.
  const references = new Map<string, DocumentReferences>()
  const suspended = new Map<string, SuspendedCopy>()
  const temporaryBaselines = new Set<string>()
  const releasedReferences = new Set<string>()
  const idleListeners = new Set<(sessionId: string, id: string) => void>()
  const documentListeners = new Set<() => void>()
  const pinWaiters = new Set<() => void>()
  const queues = new Map<string, Promise<unknown>>()
  const revisionListeners = new Map<string, Set<() => void>>()
  const hashes = new WeakMap<Uint8Array, string>()
  let closing = false
  let disposal: Promise<void> | undefined
  let documentSignature = '[]'

  function listOpenDocuments(): OpenWorkingCopyDocument[] {
    if (closing) return []
    return [...references].flatMap(([id, refs]) => {
      if (!refs.ui.size && refs.modelReferenceId === undefined) return []
      const active = copies.get(id), dormant = suspended.get(id)
      const record = active?.record ?? dormant?.record
      if (!record) return []
      return [{ sessionId: record.sessionId, id, contentVersion: record.contentVersion,
        sourceDigest: record.sourceHash, conflict: active?.snapshot.conflict ?? dormant!.conflict,
        title: (basename(record.path) || 'PDF').slice(0, 512) }]
    })
  }

  function notifyDocuments(): void {
    const signature = JSON.stringify(listOpenDocuments())
    if (signature === documentSignature) return
    documentSignature = signature
    for (const listener of [...documentListeners]) {
      try { void Promise.resolve(listener()).catch(() => undefined) }
      catch { /* Passive observers cannot fail or delay a completed document operation. */ }
    }
  }

  function recordFor(sessionId: string, id: string): WorkspaceRecord {
    const record = copies.get(id)?.record ?? suspended.get(id)?.record
    if (!record) fail('pdf/unknown-document', 'PDF working copy is unavailable; reopen it')
    if (record.sessionId !== sessionId) fail('pdf/session-mismatch', 'Working copy belongs to another session')
    return record
  }

  function touch(id: string): void { const refs = references.get(id); if (refs) refs.touched = Date.now() }
  function idle(sessionId: string, id: string): void {
    const refs = references.get(id)
    if (refs && !refs.ui.size && !refs.pins) for (const listener of idleListeners) {
      try { listener(sessionId, id) } catch { /* Reclamation must not fail a completed document operation. */ }
    }
  }
  function serialize<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const before = queues.get(sessionId) ?? Promise.resolve()
    const next = before.catch(() => undefined).then(task)
    queues.set(sessionId, next)
    return next.finally(() => { if (queues.get(sessionId) === next) queues.delete(sessionId) })
  }

  async function readSource(agent: WorkingCopyAgent, path: string, signal: AbortSignal): Promise<WorkingCopyFileRead | undefined> {
    try { return await files.read(agent, path, signal) }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'PDF_NOT_FOUND')) throw error
      return undefined
    }
  }

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
    if (!record.groups.length) { persisted.baseKey = undefined; persisted.original = undefined }
    copy.record = persisted
    copy.baseline = baseline
    copy.snapshot = snapshot
    if (!record.groups.length) await drafts.deleteBaseline(previous).catch(() => undefined)
    return snapshot
  }

  async function refresh(copy: WorkingCopyState, source: WorkingCopyFileRead | undefined, signal: AbortSignal) {
    if (source && copy.record.renderedHash && copy.record.renderedHash !== copy.record.sourceHash
      && copy.record.renderedHash === source.version) return recoverCommitted(copy, source, signal)
    const conflict = copy.record.sourceHash !== source?.version
    if (source && !conflict && copy.record.sourceVersion !== source.fsVersion) {
      copy.record = { ...copy.record, sourceVersion: source.fsVersion }
      copy.snapshot = { ...copy.snapshot, sourceVersion: source.fsVersion }
    }
    if (source && conflict && !copy.snapshot.dirty && copy.record.groups.length === 0) {
      return publish(copy, freshRecord(copy.record.sessionId, source, copy.record.revision + 1), false, signal, undefined, await sourcePdf(source))
    }
    copy.snapshot = { ...copy.snapshot, conflict }
    return copy.snapshot
  }

  async function resident(sessionId: string, id: string, agent: WorkingCopyAgent, signal: AbortSignal,
    observed?: { source: WorkingCopyFileRead | undefined }): Promise<WorkingCopyState> {
    recordFor(sessionId, id)
    const active = copies.get(id)
    if (active) return active
    const entry = suspended.get(id)!
    // Rebuild from the durable baseline, not from a possibly replaced source.
    // The source is checked afterwards using the same conflict rules as open.
    const hydrated = drafts.hydrate(entry.record)
    const baseline = await baselinePdf(hydrated)
    const record = { ...hydrated, original: undefined }
    const snapshot = workspaceSnapshot(id, record, baseline.document, baseline.bytes,
      projectedDocument(baseline.document, record), entry.conflict)
    signal.throwIfAborted()
    const copy = { id, record, baseline: baseline.document,
      snapshot: entry.warning ? { ...snapshot, warning: entry.warning } : snapshot }
    const source = observed ? observed.source : await readSource(agent, record.path, signal)
    signal.throwIfAborted()
    copies.set(id, copy)
    suspended.delete(id)
    await refresh(copy, source, signal)
    return copy
  }

  function own(id: string, owner: 'ui' | 'agent', referenceId?: string): void {
    let refs = references.get(id)
    if (!refs) { refs = { ui: new Set(), pins: 0, touched: Date.now() }; references.set(id, refs) }
    if (owner === 'ui') refs.ui.add(referenceId ?? 'legacy-ui')
    else refs.modelReferenceId = referenceId ?? randomUUID()
    touch(id)
  }

  async function open(sessionId: string, address: string, owner: 'ui' | 'agent', referenceId: string | undefined,
    agent: WorkingCopyAgent, signal: AbortSignal) {
    if (owner === 'ui' && releasedReferences.has(JSON.stringify([sessionId, referenceId ?? 'legacy-ui']))) {
      fail('pdf/reference-released', 'This PDF view has closed; open it with a new view reference')
    }
    const file = sessionFile(address)
    if (file.sessionId !== sessionId) fail('pdf/session-mismatch', 'The file address belongs to a different session')
    const path = await files.resolvePath(agent, file.path, signal)
    const source = await readSource(agent, path, signal)
    const key = drafts.key(sessionId, path)
    const existingId = byPath.get(key)
    if (existingId) {
      const wasResident = copies.has(existingId)
      const copy = await resident(sessionId, existingId, agent, signal, { source })
      const snapshot = wasResident ? await refresh(copy, source, signal) : copy.snapshot
      own(existingId, owner, referenceId)
      return snapshot
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
    own(id, owner, referenceId)
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
      const record = copies.get(id)?.record ?? suspended.get(id)?.record
      if (record && record.sessionId !== input.sessionId) fail('pdf/session-mismatch', 'Working copy belongs to another session')
      if (record) keys.add(drafts.key(record.sessionId, record.path))
    }
    const failures: string[] = []
    for (const key of keys) {
      try {
        const currentId = byPath.get(key)
        const stored = drafts.get(key) ?? (currentId ? copies.get(currentId)?.record ?? suspended.get(currentId)?.record : undefined)
        await drafts.delete(key)
        const id = byPath.get(key)
        if (id) {
          copies.delete(id)
          suspended.delete(id)
          references.delete(id)
          if (byPath.get(key) === id) byPath.delete(key)
        }
        if (stored) await drafts.deleteBaseline(stored).catch(() => undefined)
      } catch (error) { failures.push(errorText(error)) }
    }
    if (failures.length) fail('pdf/discard-failed', `Could not discard PDF drafts: ${failures.join('; ')}`)
    return { discarded: [...ids] }
  }

  async function suspendCopy(sessionId: string, id: string, evict?: () => Promise<unknown>): Promise<DocumentReleaseStatus> {
    const record = copies.get(id)?.record ?? suspended.get(id)?.record
    if (!record) return 'already-closed'
    if (record.sessionId !== sessionId) fail('pdf/session-mismatch', 'Working copy belongs to another session')
    const refs = references.get(id)!
    if (refs.ui.size) return 'retained-ui'
    if (refs.pins) return 'retained-operation'
    const copy = copies.get(id)
    if (!copy) return 'already-closed'
    let next = copy.record
    if (!next.baseKey || !drafts.get(next.baseKey)) {
      if (next.groups.length) next = await drafts.persist(next, drafts.key(sessionId, next.path), copy.snapshot.bytes)
      else {
        // A clean copy also needs its original bytes if the disk file disappears
        // while dormant. This is a cache baseline, not a saved user draft.
        const baseKey = `base_${randomUUID()}`
        await drafts.put(baseKey, { ...next, baseKey: undefined,
          original: encodePdfBaseline(copy.snapshot.bytes), groups: [], groupDates: [], cursor: 0, renderedHash: undefined })
        temporaryBaselines.add(baseKey)
        next = { ...next, baseKey, original: undefined }
      }
      copy.record = next
    }
    // The eviction callback runs within the same session queue as acquisition;
    // no new operation can observe native buffers halfway through disposal.
    await evict?.()
    suspended.set(id, { record: { ...next, original: undefined },
      conflict: copy.snapshot.conflict, warning: copy.snapshot.warning })
    copies.delete(id)
    return 'released'
  }

  async function run(raw: Record<string, unknown>, agent: WorkingCopyAgent, signal: AbortSignal) {
    const input = requestSchema.parse(raw)
    if (input.sessionId !== agent.session.id) fail('pdf/session-mismatch', 'Session identity mismatch')
    if (input.action === 'open') return open(input.sessionId, input.address, input.owner ?? 'ui', input.referenceId, agent, signal)
    if (input.action === 'release') {
      if (input.id === undefined) {
        // A failed/lost open reply may hide the document ID from the Client.
        // Closing the occurrence by token also fences delayed open retries.
        releasedReferences.add(JSON.stringify([input.sessionId, input.referenceId]))
        const released: string[] = []
        for (const [id, refs] of references) {
          const record = copies.get(id)?.record ?? suspended.get(id)?.record
          if (record?.sessionId !== input.sessionId || !refs.ui.delete(input.referenceId)) continue
          touch(id)
          idle(input.sessionId, id)
          released.push(id)
        }
        return { released }
      }
      const record = copies.get(input.id)?.record ?? suspended.get(input.id)?.record
      if (!record) return { id: input.id, status: 'already-closed' as const }
      recordFor(input.sessionId, input.id)
      references.get(input.id)!.ui.delete(input.referenceId)
      touch(input.id)
      idle(input.sessionId, input.id)
      return { id: input.id, status: references.get(input.id)!.ui.size ? 'retained-ui' as const : 'released' as const }
    }
    if (input.action === 'refresh') {
      const wasResident = copies.has(input.id)
      const copy = await resident(input.sessionId, input.id, agent, signal)
      touch(input.id)
      return wasResident ? refresh(copy, await readSource(agent, copy.record.path, signal), signal) : copy.snapshot
    }
    if (input.action === 'inspectTarget') {
      try { return { version: (await files.read(agent, input.path, signal)).version } }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'PDF_NOT_FOUND') return { version: null }
        throw error
      }
    }
    if (input.action === 'discardMany' || input.action === 'discardAddresses') return discardCopies(input, agent)
    const copy = await resident(input.sessionId, input.id, agent, signal)
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
    const span = beginPdfSpan('host.dispatch')
    const task = serialize(sessionId, async () => {
      signal.throwIfAborted()
      const value = await run(input, agent, signal)
      if (value && typeof value === 'object' && 'id' in value) touch(String(value.id))
      return value
    })
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
      notifyDocuments()
    }
  }
  return {
    execute,
    /** Inspect source bytes without acquiring an owner or creating a durable draft. */
    async inspectFile(sessionId: string, path: string, agent: WorkingCopyAgent, signal: AbortSignal) {
      if (closing) fail('pdf/unavailable', 'The PDF plugin is unloading')
      if (sessionId !== agent.session.id) fail('pdf/session-mismatch', 'Session identity mismatch')
      return serialize(sessionId, async () => {
        signal.throwIfAborted()
        const source = await files.read(agent, path, signal)
        const document = await pdf.inspect(source.bytes)
        signal.throwIfAborted()
        return { path: source.path, size: source.size, sourceVersion: source.fsVersion,
          sourceDigest: source.version, document }
      })
    },
    /** Pin the whole operation, including image decoding or save approval waits. */
    async acquire(sessionId: string, id: string, agent: WorkingCopyAgent, signal: AbortSignal): Promise<() => void> {
      if (closing) fail('pdf/unavailable', 'The PDF plugin is unloading')
      if (sessionId !== agent.session.id) fail('pdf/session-mismatch', 'Session identity mismatch')
      signal.throwIfAborted()
      recordFor(sessionId, id)
      const refs = references.get(id)!
      refs.pins += 1
      touch(id)
      let released = false
      const release = () => {
        if (released) return
        released = true
        refs.pins -= 1
        touch(id)
        idle(sessionId, id)
        if (![...references.values()].some(value => value.pins)) for (const done of [...pinWaiters]) done()
      }
      try {
        await serialize(sessionId, async () => {
          signal.throwIfAborted()
          if (closing) fail('pdf/unavailable', 'The PDF plugin is unloading')
          await resident(sessionId, id, agent, signal)
        })
        signal.throwIfAborted()
        return release
      } catch (error) { release(); throw error }
      finally { notifyDocuments() }
    },
    touch(sessionId: string, id: string): void { recordFor(sessionId, id); touch(id) },
    onIdle(listener: (sessionId: string, id: string) => void): () => void {
      idleListeners.add(listener)
      return () => { idleListeners.delete(listener) }
    },
    listOpenDocuments,
    /** Passive ownership/source notifications; subscribers schedule their own asynchronous work. */
    onDocumentsChanged(listener: () => void): () => void {
      if (closing) return () => {}
      documentListeners.add(listener)
      return () => { documentListeners.delete(listener) }
    },
    listDocuments(): DocumentResidency[] {
      return [...references.entries()].map(([id, refs]) => {
        const copy = copies.get(id)
        const record = copy?.record ?? suspended.get(id)!.record
        return { sessionId: record.sessionId, id, bytes: copy?.snapshot.bytes.byteLength ?? 0,
          resident: Boolean(copy), touched: refs.touched, uiReferences: refs.ui.size,
          modelOwned: refs.modelReferenceId !== undefined, modelReferenceId: refs.modelReferenceId, pins: refs.pins }
      })
    },
    async waitForRevision(sessionId: string, id: string, knownRevision: number, signal: AbortSignal): Promise<number> {
      const current = () => {
        const record = copies.get(id)?.record ?? suspended.get(id)?.record
        if (closing || !record || record.sessionId !== sessionId) fail('pdf/unknown-document', 'PDF working copy is unavailable in this session')
        return record.revision
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
        const timer = setTimeout(() => { cleanup(); resolve(knownRevision) }, PASSIVE_POLL_TIMEOUT_MS)
        set.add(onChange)
        signal.addEventListener('abort', onAbort, { once: true })
        // Close the race between the first revision check and registration.
        onChange()
      })
    },
    isUiOwned(sessionId: string, id: string): boolean {
      recordFor(sessionId, id)
      return Boolean(references.get(id)?.ui.size)
    },
    async suspend(sessionId: string, id: string, evict?: () => Promise<unknown>): Promise<DocumentReleaseStatus> {
      if (closing) return 'already-closed'
      return serialize(sessionId, () => suspendCopy(sessionId, id, evict))
    },
    async releaseBackground(sessionId: string, id: string, evict?: () => Promise<unknown>,
      expectedReferenceId?: string | null): Promise<DocumentReleaseStatus> {
      if (closing) return 'already-closed'
      try {
        return await serialize(sessionId, async () => {
          const record = copies.get(id)?.record ?? suspended.get(id)?.record
          if (!record) return 'already-closed'
          recordFor(sessionId, id)
          const refs = references.get(id)!
          // Runtime detach/close may wait behind a different document's native
          // eviction. It must not release a newer open admitted in that interval.
          if (expectedReferenceId !== undefined && (refs.modelReferenceId ?? null) !== expectedReferenceId) return 'retained-model'
          refs.modelReferenceId = undefined
          touch(id)
          notifyDocuments()
          return suspendCopy(sessionId, id, evict)
        })
      } finally { notifyDocuments() }
    },
    readSnapshot(sessionId: string, id: string): HostWorkspaceSnapshot {
      if (closing) fail('pdf/unavailable', 'The PDF plugin is unloading')
      const copy = copies.get(id)
      if (!copy) {
        recordFor(sessionId, id)
        fail('pdf/document-suspended', 'Acquire this PDF working copy before reading its resident snapshot')
      }
      if (copy.record.sessionId !== sessionId) fail('pdf/session-mismatch', 'Working copy belongs to another session')
      return copy.snapshot
    },
    bytesHash: renderedHash,
    dispose(): Promise<void> {
      if (disposal) return disposal
      closing = true
      notifyDocuments()
      for (const listeners of [...revisionListeners.values()]) {
        for (const listener of [...listeners]) listener()
      }
      disposal = (async () => {
        await Promise.allSettled([...queues.values()])
        // Admission is stopped above. Tool/UI adapters cancel their work before
        // disposal; their finally blocks must unpin before shared state is freed.
        if ([...references.values()].some(value => value.pins)) await new Promise<void>(resolve => {
          const done = () => { pinWaiters.delete(done); resolve() }
          pinWaiters.add(done)
        })
        const durableBaselines = new Set([...copies.values(), ...suspended.values()]
          .filter(value => value.record.groups.length).map(value => value.record.baseKey))
        await Promise.allSettled([...temporaryBaselines].filter(key => !durableBaselines.has(key)).map(key => drafts.delete(key)))
        copies.clear(); suspended.clear(); byPath.clear(); references.clear(); releasedReferences.clear(); queues.clear(); revisionListeners.clear(); idleListeners.clear(); documentListeners.clear(); pinWaiters.clear(); temporaryBaselines.clear()
      })()
      return disposal
    },
  }
}
