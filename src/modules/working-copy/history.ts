import { projectPdfOperations } from '../annotations/index.js'
import { isOutlineOperation, projectOutlineOperations } from '../outlines/index.js'
import { projectFormOperations } from './form-projection.js'
import type { PdfAnnotationOperation, PdfDocumentInfo, PdfWorkingCopyOperation } from '../../core/pdf-types.js'
import type { WorkspaceRecord } from './schema.js'

/** Replay exactly the active prefix; redo groups remain durable but invisible. */
export function operationsThrough(record: WorkspaceRecord): { operations: PdfWorkingCopyOperation[]; dates: string[] } {
  const operations: PdfWorkingCopyOperation[] = []
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
  let document = baseline
  for (let index = 0; index < record.cursor; index++) {
    document = projectWorkingCopyOperations(document, record.groups[index], record.groupDates[index])
  }
  return document
}

export function projectWorkingCopyOperations(document: PdfDocumentInfo, operations: readonly PdfWorkingCopyOperation[],
  dates: string | readonly string[]): PdfDocumentInfo {
  const annotations = operations.filter((operation): operation is PdfAnnotationOperation =>
    operation.type === 'add' || operation.type === 'update' || operation.type === 'delete')
  const forms = operations.filter((operation): operation is Extract<PdfWorkingCopyOperation, { type: 'set-field' }> => operation.type === 'set-field')
  const annotationDates = typeof dates === 'string' ? dates : operations.flatMap((operation, index) =>
    operation.type === 'add' || operation.type === 'update' || operation.type === 'delete' ? [dates[index]] : [])
  const projected = annotations.length ? projectPdfOperations(document, annotations, annotationDates) : document
  return projectOutlineOperations(projectFormOperations(projected, forms), operations.filter(isOutlineOperation))
}

/** A new edit replaces the redo branch and advances the optimistic revision. */
export function appendGroup(record: WorkspaceRecord, operations: PdfWorkingCopyOperation[], date: string): WorkspaceRecord {
  return { ...record, groups: [...record.groups.slice(0, record.cursor), operations],
    groupDates: [...record.groupDates.slice(0, record.cursor), date],
    cursor: record.cursor + 1, revision: record.revision + 1 }
}

export function moveCursor(record: WorkspaceRecord, direction: 'undo' | 'redo'): WorkspaceRecord {
  return { ...record, cursor: record.cursor + (direction === 'undo' ? -1 : 1), revision: record.revision + 1 }
}
