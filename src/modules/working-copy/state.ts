import { randomUUID } from 'node:crypto'
import type { PdfDocumentInfo } from '../../core/pdf-types.js'
import type { HostWorkspaceSnapshot, WorkingCopyFileRead } from './ports.js'
import type { WorkspaceRecord } from './schema.js'

/** Mutable only inside the serialized session transaction. */
export interface WorkingCopyState {
  id: string
  record: WorkspaceRecord
  baseline: PdfDocumentInfo
  snapshot: HostWorkspaceSnapshot
}

export function freshRecord(sessionId: string, source: WorkingCopyFileRead, revision = 0,
  contentVersion: string = randomUUID()): WorkspaceRecord {
  return { format: 1, sessionId, path: source.path, sourceHash: source.version,
    sourceVersion: source.fsVersion, contentVersion,
    revision, groups: [], groupDates: [], cursor: 0 }
}

export function workspaceSnapshot(id: string, record: WorkspaceRecord, baseline: PdfDocumentInfo,
  bytes: Uint8Array, document: PdfDocumentInfo, conflict: boolean): HostWorkspaceSnapshot {
  return {
    id, path: record.path, sourceVersion: record.sourceVersion, contentVersion: record.contentVersion,
    revision: record.revision, dirty: record.cursor > 0,
    canUndo: record.cursor > 0, canRedo: record.cursor < record.groups.length,
    conflict, document, baselineAnnotations: baseline.annotations, bytes,
  }
}
