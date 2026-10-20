import { applyPdfOperations, loadPdfDocument } from './pdf-document.js'
import type { PdfDocumentPort } from '../../../modules/working-copy/index.js'

/** The only working-copy dependency on the PDF writer/parser implementation. */
export const pdfLibDocumentAdapter: PdfDocumentPort = {
  inspect: loadPdfDocument,
  materialize: applyPdfOperations,
}
