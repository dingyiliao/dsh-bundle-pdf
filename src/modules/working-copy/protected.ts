import type { PdfDocumentInfo, PdfWorkingCopyOperation } from '../../core/pdf-types.js'

/** A protected copy is only writable if its Reader also has an encrypted writer. */
export function protectedReaderInfo(document: PdfDocumentInfo, canWrite: boolean): PdfDocumentInfo {
  if (!document.annotationEditing || canWrite) return document
  const { annotationEditing: _, ...info } = document
  return { ...info, readOnly: true, readOnlyReason: 'encrypted-document',
    annotations: info.annotations.map(annotation => annotation.editable
      ? { ...annotation, editable: false, readOnlyReason: 'encrypted-document' } : annotation) }
}

export function validateProtectedOperations(operations: readonly PdfWorkingCopyOperation[]): void {
  for (const operation of operations) {
    if (operation.type === 'add') {
      const { id, replyToId, contents, author } = operation.annotation
      if (replyToId !== undefined) unsupported('Replies on encrypted PDFs are not supported')
      if (id.includes('\0') || contents?.includes('\0') || author?.includes('\0')) invalidText()
    } else if (operation.type === 'update') {
      if (operation.patch.commentPosition !== undefined) unsupported('Comment-card positioning on encrypted PDFs is not supported')
      if (operation.patch.contents?.includes('\0')) invalidText()
    } else if (operation.type !== 'delete') unsupported('Encrypted PDFs only support annotation edits')
  }
}

function invalidText(): never {
  throw Object.assign(new Error('An encrypted PDF annotation contains an invalid NUL character'), { code: 'pdf/invalid-operation' })
}

function unsupported(message: string): never {
  throw Object.assign(new Error(message), { code: 'pdf/protected-annotation-operation' })
}
