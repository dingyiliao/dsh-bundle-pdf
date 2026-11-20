import { freshRecord, workspaceSnapshot, type WorkingCopyState } from './state.js'
import { projectedDocument } from './history.js'
import type { BaselineResource } from './model.js'
import type { HostWorkspaceSnapshot, WorkingCopyDraftPort, WorkingCopyFileRead } from './ports.js'
import type { DraftRecord, WorkspaceRecord } from './schema.js'
import type { BaselineMismatchDecision } from '../../../shared/contracts.js'
import type { PdfDocumentInfo } from '../../../shared/pdf-types.js'

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }

export interface TransitionDependencies {
  drafts: WorkingCopyDraftPort
  sourceBaseline(source: WorkingCopyFileRead): Promise<BaselineResource>
}

/** Coordinates durable effects and atomic record/baseline/snapshot publication. */
export function createWorkingCopyTransitions(deps: TransitionDependencies) {
  async function cleanupDraft(record: DraftRecord | WorkspaceRecord): Promise<string[]> {
    const failures: string[] = []
    const key = deps.drafts.key(record.sessionId, record.path)
    let deleted = false
    try { await deps.drafts.delete(key); deleted = true } catch (error) { failures.push(errorText(error)) }
    if (deleted) {
      try { await deps.drafts.deleteBaseline(record as DraftRecord) } catch (error) { failures.push(errorText(error)) }
    }
    return failures
  }

  async function recoverCommitted(copy: WorkingCopyState, source: WorkingCopyFileRead,
    signal?: AbortSignal): Promise<HostWorkspaceSnapshot> {
    const previous = copy.record
    const committed = await deps.sourceBaseline(source)
    signal?.throwIfAborted()
    const next = freshRecord(previous.sessionId, source, previous.revision + 1, previous.contentVersion)
    const snapshot = workspaceSnapshot(copy.id, next, committed, committed.document, false)
    copy.record = next; copy.baseline = committed; copy.snapshot = snapshot
    const cleanupFailures = await cleanupDraft(previous)
    if (cleanupFailures.length) {
      copy.snapshot = { ...snapshot, warning: `PDF saved to ${source.path}, but draft cleanup failed: ${cleanupFailures.join('; ')}` }
    }
    return copy.snapshot
  }

  async function publish(copy: WorkingCopyState, record: WorkspaceRecord, conflict = copy.snapshot.conflict,
    signal?: AbortSignal, document?: PdfDocumentInfo, source?: BaselineResource): Promise<HostWorkspaceSnapshot> {
    const baseline = source ?? copy.baseline
    const snapshot = workspaceSnapshot(copy.id, record, baseline,
      document ?? projectedDocument(baseline.document, record), conflict,
      conflict ? copy.snapshot.baselineMismatch : undefined)
    signal?.throwIfAborted()
    const previous = copy.record
    if (baseline.document.encrypted) {
      const cleanupFailures = previous.sourceHash !== record.sourceHash || !record.groups.length
        ? await cleanupDraft(previous) : []
      copy.record = record; copy.baseline = baseline
      copy.snapshot = cleanupFailures.length
        ? { ...snapshot, warning: `Current protected baseline adopted, but stale draft cleanup failed: ${cleanupFailures.join('; ')}` }
        : snapshot
      return copy.snapshot
    }
    const persisted = await deps.drafts.persist(record, deps.drafts.key(record.sessionId, record.path), baseline.bytes)
    if (!record.groups.length) { persisted.baseKey = undefined; persisted.original = undefined }
    copy.record = persisted; copy.baseline = baseline; copy.snapshot = snapshot
    if (!record.groups.length) await deps.drafts.deleteBaseline(previous).catch(() => undefined)
    return snapshot
  }

  async function refresh(copy: WorkingCopyState, source: WorkingCopyFileRead | undefined,
    signal: AbortSignal): Promise<HostWorkspaceSnapshot> {
    if (source && copy.record.renderedHash && copy.record.renderedHash !== copy.record.sourceHash
      && copy.record.renderedHash === source.version) return recoverCommitted(copy, source, signal)
    const conflict = copy.record.sourceHash !== source?.version
    const baselineMismatch: BaselineMismatchDecision | undefined = conflict ? {
      operationsBaselineId: copy.baseline.baselineId,
      ...(source ? { currentBaselineId: source.version } : {}), choices: ['adopt-current', 'retain-operations'],
    } : undefined
    if (source && !conflict && copy.record.sourceVersion !== source.fsVersion) {
      copy.record = { ...copy.record, sourceVersion: source.fsVersion }
      copy.snapshot = { ...copy.snapshot, sourceVersion: source.fsVersion }
    }
    if (source && conflict && !copy.snapshot.dirty && copy.record.groups.length === 0) {
      if (copy.snapshot.document.encrypted) {
        copy.snapshot = { ...copy.snapshot, conflict: true, baselineMismatch }
        return copy.snapshot
      }
      return publish(copy, freshRecord(copy.record.sessionId, source, copy.record.revision + 1), false,
        signal, undefined, await deps.sourceBaseline(source))
    }
    copy.snapshot = { ...copy.snapshot, conflict, baselineMismatch }
    return copy.snapshot
  }

  return { cleanupDraft, recoverCommitted, publish, refresh }
}
