/** All geometry is in unrotated PDF user space; page numbers are one based. */
export type PdfRect = [number, number, number, number]
export type PdfColor = [number, number, number]
export type EditableAnnotationType = 'Highlight' | 'Underline' | 'StrikeOut' | 'Text'

export interface PdfPageInfo {
  page: number
  /** Absent when read-only inspection exposes only the visible page box. */
  mediaBox?: PdfRect
  cropBox: PdfRect
  rotation: number
  userUnit: number
}

export interface PdfAnnotation {
  id: string
  page: number
  subtype: string
  rect?: PdfRect
  /** Eight numbers per quadrilateral: top-left, top-right, bottom-left, bottom-right. */
  quadPoints?: number[]
  color?: PdfColor
  opacity?: number
  contents?: string
  author?: string
  /** Raw PDF date strings, absent when the source omits them. */
  createdAt?: string
  modifiedAt?: string
  flags: number
  supported: boolean
  editable: boolean
  readOnlyReason?: string
}

export interface PdfDocumentInfo {
  pageCount: number
  pages: PdfPageInfo[]
  annotations: PdfAnnotation[]
  title?: string
  signed: boolean
  encrypted: boolean
  readOnly: boolean
  readOnlyReason?: string
}

export interface NewPdfAnnotation {
  /** A caller-generated unique ID persisted in the annotation dictionary. */
  id: string
  page: number
  subtype: EditableAnnotationType
  rect: PdfRect
  quadPoints?: number[]
  color?: PdfColor
  contents?: string
  author?: string
}

export type PdfAnnotationOperation =
  | { type: 'add'; annotation: NewPdfAnnotation }
  | { type: 'update'; id: string; patch: { contents?: string; color?: PdfColor } }
  | { type: 'delete'; id: string }

export type PdfDocumentErrorCode =
  | 'encrypted'
  | 'password-required'
  | 'invalid-pdf'
  | 'read-only'
  | 'invalid-operation'
  | 'unknown-annotation'
  | 'annotation-read-only'

export class PdfDocumentError extends Error {
  constructor(public readonly code: PdfDocumentErrorCode, message: string) {
    super(message)
    this.name = 'PdfDocumentError'
  }
}
