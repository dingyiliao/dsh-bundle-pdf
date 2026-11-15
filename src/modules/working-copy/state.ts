import { randomUUID } from 'node:crypto'
import type { HostWorkspaceSnapshot, WorkingCopyFileRead } from './ports.js'
import type { BaselineResource, ContentContext } from './model.js'
import type { WorkspaceRecord } from './schema.js'
import type { BaselineMismatchDecision } from '../../shared/contracts.js'

/** Mutable only inside the serialized session transaction. */
export interface WorkingCopyState {
  id: string
  record: WorkspaceRecord
  baseline: BaselineResource
  snapshot: HostWorkspaceSnapshot
}

export function freshRecord(sessionId: string, source: WorkingCopyFileRead, revision = 0,
  contentVersion: string = randomUUID()): WorkspaceRecord {
  return { format: 1, sessionId, path: source.path, sourceHash: source.version, baselineId: source.version,
    sourceVersion: source.fsVersion, contentVersion,
    revision, groups: [], groupDates: [], cursor: 0 }
}

export function workspaceSnapshot(id: string, record: WorkspaceRecord, baseline: BaselineResource,
  document: BaselineResource['document'], conflict: boolean, baselineMismatch?: BaselineMismatchDecision): HostWorkspaceSnapshot {
  const contentContext: ContentContext = {
    baselineId: baseline.baselineId,
    revision: record.revision,
    sourceDigest: baseline.source.digest,
    contentVersion: record.contentVersion,
    indexContentDigest: document.indexContentDigest,
    indexPageDigests: document.indexPageDigests,
  }
  return {
    id, path: record.path, baselineId: baseline.baselineId, sourceVersion: record.sourceVersion, contentVersion: record.contentVersion,
    contentContext,
    revision: record.revision, dirty: record.cursor > 0,
    canUndo: record.cursor > 0, canRedo: record.cursor < record.groups.length,
    conflict, ...(baselineMismatch ? { baselineMismatch } : {}), document, baselineAnnotations: baseline.document.annotations, baselineOutline: baseline.document.outline,
    baselineFormFields: baseline.document.formFields, bytes: baseline.bytes,
  }
}
