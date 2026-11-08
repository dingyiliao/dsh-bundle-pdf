import type { PdfDocumentErrorCode, PdfDocumentInfo, PdfWorkingCopyOperation } from '../../../core/pdf-types.js'

export type PdfDocumentWorkerRequest =
  | { action: 'inspect'; bytes: Uint8Array }
  | { action: 'materialize'; bytes: Uint8Array; operations: readonly PdfWorkingCopyOperation[]; operationDates: readonly string[] }

export type PdfDocumentWorkerReply =
  | { ok: true; document: PdfDocumentInfo; bytes?: Uint8Array }
  | { ok: false; error: { message: string; code?: PdfDocumentErrorCode } }
