/** All geometry is in unrotated PDF user space; page numbers are one based. */
export type PdfRect = [number, number, number, number]
export type PdfColor = [number, number, number]
export type EditableAnnotationType = 'Highlight' | 'Underline' | 'StrikeOut' | 'Text'
export const DEFAULT_HIGHLIGHT_OPACITY = 0.4

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
  /** ID of the annotation referenced by PDF /IRT, when it is on the same page. */
  replyToId?: string
  /** PDF /RT relation. A missing /RT on a reply means an ordinary reply (R). */
  replyType?: 'R' | 'Group'
  /** Host projection identity for multiple page entries referencing one PDF dictionary. */
  sourceObjectId?: string
  /** Host projection identity of an associated popup annotation, when present. */
  popupObjectId?: string
  /** DSH's persisted top-left placement for the comment card, in PDF user space. */
  commentPosition?: [number, number]
  page: number
  subtype: string
  /** Named navigation actions retained by Host inspection for the native reader. */
  linkAction?: string
  rect?: PdfRect
  /** Eight numbers per quadrilateral: top-left, top-right, bottom-left, bottom-right. */
  quadPoints?: number[]
  color?: PdfColor
  opacity?: number
  contents?: string
  /** Imported PDF /RC rich text exists; editing Contents will convert it to plain text. */
  hasRichText?: true
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
  /** Add a Text reply to this annotation via PDF /IRT and /RT /R. */
  replyToId?: string
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
  | { type: 'update'; id: string; patch: { contents?: string; color?: PdfColor; rect?: PdfRect; commentPosition?: [number, number] } }
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
