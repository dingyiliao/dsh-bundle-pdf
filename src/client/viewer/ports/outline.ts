import type { PdfOutlineItem, PdfOutlineOperation } from '../../../core/pdf-types.js'

/** Embedded bookmarks share the Reader's serialized, undoable working copy. */
export interface OutlineAccess {
  documentId: string
  revision: number
  items?: PdfOutlineItem[]
  readOnlyReason?: string
  editable: boolean
  busy: boolean
  change(operations: PdfOutlineOperation[], expectedRevision: number): Promise<boolean>
}
