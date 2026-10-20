import type { PdfDocumentPort, HostWorkspaceSnapshot, WorkingCopyAgent, WorkingCopyDraftPort,
  WorkingCopyFilePort, WorkingCopyFileRead } from './ports.js'
import { operationsThrough } from './history.js'
import { expectedSaveVersion, type SaveOptions } from './save-plan.js'
import { freshRecord, type WorkingCopyState } from './state.js'

function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** Dependencies of the single publication transaction, supplied by the session owner. */
export interface SaveDependencies {
  files: WorkingCopyFilePort
  drafts: WorkingCopyDraftPort
  pdf: PdfDocumentPort
  byPath: Map<string, string>
  renderedHash(bytes: Uint8Array): string
  rememberSavedHash(bytes: Uint8Array, hash: string): void
  recoverCommitted(copy: WorkingCopyState, source: WorkingCopyFileRead, signal?: AbortSignal): Promise<HostWorkspaceSnapshot>
}

/** Materialize, compare-and-swap, publish, then clean the V1 draft. */
export async function saveWorkingCopy(deps: SaveDependencies, copy: WorkingCopyState, options: SaveOptions,
  sessionId: string, agent: WorkingCopyAgent, signal: AbortSignal): Promise<HostWorkspaceSnapshot> {
  const { files, drafts, pdf, byPath, renderedHash, rememberSavedHash, recoverCommitted } = deps
  const record = copy.record
  if (copy.snapshot.document.readOnly) fail('pdf/read-only', copy.snapshot.document.readOnlyReason ?? 'This PDF is read-only')
  const target = await files.resolvePath(agent, options.path ?? record.path, signal)
  const same = drafts.samePath(target, record.path)
  const targetKey = drafts.key(sessionId, target)
  if (!same && byPath.has(targetKey)) fail('pdf/target-open', 'The destination already has a working copy; choose another path')
  if (!same && drafts.get(targetKey)?.groups.length) fail('pdf/target-draft', 'The destination has a saved draft; open it first or choose another path')
  const expected = expectedSaveVersion(record.sourceHash, same, options)
  // Materialize the active operation prefix once, only at the save boundary.
  const { operations, dates } = operationsThrough(record)
  const committed = operations.length
    ? await pdf.materialize(copy.snapshot.bytes, operations, dates)
    : { bytes: copy.snapshot.bytes, document: copy.baseline }
  const committedBytes = committed.bytes
  const document = committed.document
  signal.throwIfAborted()
  if (record.groups.length && renderedHash(committedBytes) !== record.sourceHash) {
    // Persist the exact output identity before publication. A crash after
    // rename but before draft cleanup can then recognize the committed PDF.
    // Equal bytes cannot prove a save happened; preserve a redo-only draft
    // if such a save fails before publication.
    copy.record = await drafts.persist(record, drafts.key(record.sessionId, record.path),
      copy.snapshot.bytes, renderedHash(committedBytes))
  }
  try {
    const saved = await files.save(agent, target, committedBytes, expected, { overwrite: options.overwrite, signal })
    const source = { ...saved, bytes: committedBytes }
    const next = freshRecord(sessionId, source, record.revision + 1, record.contentVersion)
    const snapshot: HostWorkspaceSnapshot = {
      id: copy.id, path: next.path, sourceVersion: next.sourceVersion, contentVersion: next.contentVersion,
      revision: next.revision, dirty: false, canUndo: false, canRedo: false, conflict: false,
      document, baselineAnnotations: document.annotations, bytes: committedBytes,
    }
    // The PDF has committed. Keep the in-memory revision aligned even if draft cleanup fails.
    copy.record = next
    copy.baseline = document
    copy.snapshot = snapshot
    rememberSavedHash(committedBytes, next.sourceHash)
    byPath.delete(drafts.key(sessionId, record.path))
    byPath.set(drafts.key(sessionId, saved.path), copy.id)
    const cleanupKeys = new Set([drafts.key(sessionId, record.path), targetKey])
    const cleanupFailures: string[] = []
    let draftsDeleted = true
    for (const key of cleanupKeys) {
      try { await drafts.delete(key) } catch (error) { draftsDeleted = false; cleanupFailures.push(errorText(error)) }
    }
    if (draftsDeleted) {
      try { await drafts.deleteBaseline(record) } catch (error) { cleanupFailures.push(errorText(error)) }
    }
    if (cleanupFailures.length) {
      copy.snapshot = { ...snapshot, warning: `PDF saved to ${saved.path}, but draft cleanup failed: ${cleanupFailures.join('; ')}` }
    }
    return copy.snapshot
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'PDF_STALE_VERSION' || error.code === 'PDF_SAVE_UNCERTAIN') && same) {
      // A post-rename verification failure is not proof that the write
      // failed. Check the exact committed digest before showing a conflict.
      try {
        const source = await files.read(agent, target, signal)
        if (copy.record.renderedHash && copy.record.renderedHash === source.version) {
          return await recoverCommitted(copy, source, signal)
        }
      } catch { /* A later open can retry recovery from the durable marker. */ }
      copy.snapshot = { ...copy.snapshot, conflict: true }
    }
    throw error
  }
}
