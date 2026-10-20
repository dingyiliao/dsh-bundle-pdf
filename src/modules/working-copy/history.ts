import { projectPdfOperations } from '../annotations/index.js'
import type { PdfAnnotationOperation, PdfDocumentInfo } from '../../core/pdf-types.js'
import type { WorkspaceRecord } from './schema.js'

/** Replay exactly the active prefix; redo groups remain durable but invisible. */
export function operationsThrough(record: WorkspaceRecord): { operations: PdfAnnotationOperation[]; dates: string[] } {
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

export function projectedDocument(baseline: PdfDocumentInfo, record: WorkspaceRecord): PdfDocumentInfo {
  if (!record.cursor) return baseline
  const { operations, dates } = operationsThrough(record)
  return projectPdfOperations(baseline, operations, dates)
}

/** A new edit replaces the redo branch and advances the optimistic revision. */
export function appendGroup(record: WorkspaceRecord, operations: PdfAnnotationOperation[], date: string): WorkspaceRecord {
  return { ...record, groups: [...record.groups.slice(0, record.cursor), operations],
    groupDates: [...record.groupDates.slice(0, record.cursor), date],
    cursor: record.cursor + 1, revision: record.revision + 1 }
}

export function moveCursor(record: WorkspaceRecord, direction: 'undo' | 'redo'): WorkspaceRecord {
  return { ...record, cursor: record.cursor + (direction === 'undo' ? -1 : 1), revision: record.revision + 1 }
}
