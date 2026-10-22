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

export interface PdfFormWidget {
  page: number
  rect: PdfRect
  /** One selectable value for a radio widget, absent for other field types. */
  option?: string
}

/** A canonical AcroForm field; widgets locate its visible controls on pages. */
export interface PdfFormField {
  /** Stable canonical PDF field object identity; absent only in older metadata. */
  id?: string
  /** Display name; imported PDFs can contain distinct fields with the same name. */
  name: string
  type: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'option-list' | 'unsupported'
  value: string | boolean | string[]
  widgets: PdfFormWidget[]
  options?: string[]
  maxLength?: number
  multiline?: boolean
  /** Whether an option-list accepts more than one selected value. */
  multiple?: boolean
  readOnly: boolean
  required: boolean
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

/** Editable PDF outline metadata. Original destinations and styles remain owned by the PDF adapter. */
export interface PdfOutlineItem {
  id: string
  title: string
  /** Resolved one-based page, absent for external, unsupported or unavailable destinations. */
  page?: number
  /** Unsaved projection explicitly replaces the original destination, even on the same page. */
  targetChanged?: true
  children: PdfOutlineItem[]
}

export interface PdfDocumentInfo {
  pageCount: number
  pages: PdfPageInfo[]
  annotations: PdfAnnotation[]
  title?: string
  signed: boolean
  encrypted: boolean
  formKind?: 'acroform' | 'xfa'
  formFields?: PdfFormField[]
  /** An empty array is an editable empty outline; absence means inspection is unavailable. */
  outline?: PdfOutlineItem[]
  outlineReadOnlyReason?: string
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

export type PdfFormOperation = { type: 'set-field'; value: string | boolean | string[] } & (
  { fieldId: string; name?: never } | { name: string; fieldId?: never })

export type PdfOutlineOperation =
  | { type: 'outline-add'; id: string; title: string; page: number; parentId?: string; index?: number }
  | { type: 'outline-update'; id: string; patch: { title?: string; page?: number } }
  | { type: 'outline-delete'; id: string }
  /** Index is measured in the destination's children after removing the moving subtree. */
  | { type: 'outline-move'; id: string; parentId?: string; index: number }

export type PdfWorkingCopyOperation = PdfAnnotationOperation | PdfFormOperation | PdfOutlineOperation

export type PdfDocumentErrorCode =
  | 'encrypted'
  | 'password-required'
  | 'invalid-pdf'
  | 'read-only'
  | 'invalid-operation'
  | 'unknown-annotation'
  | 'annotation-read-only'
  | 'unknown-outline'
  | 'outline-read-only'

export class PdfDocumentError extends Error {
  constructor(public readonly code: PdfDocumentErrorCode, message: string) {
    super(message)
    this.name = 'PdfDocumentError'
  }
}
