import type { PdfDocumentIndexPolicy, PdfIndexingSnapshot } from '../../../contracts/indexing.js'

/** Session-scoped Host progress, mirrored without giving the Viewer a second task owner. */
export type PdfIndexingClientSnapshot = Omit<PdfIndexingSnapshot, 'revision'> & {
  status: 'loading' | 'ready' | 'unavailable'
  revision?: string
  /** Dismissed completion occurrences; index readiness remains in tasks. */
  dismissed?: Readonly<Record<string, number>>
}

export interface PdfIndexingApi {
  getSnapshot(sessionId: string): PdfIndexingClientSnapshot
  subscribe(sessionId: string, listener: () => void): () => void
  start(sessionId: string, documentId: string, signal: AbortSignal): Promise<void>
  rebuild(sessionId: string, documentId: string, signal: AbortSignal): Promise<void>
  cancel(sessionId: string, documentId: string, signal: AbortSignal): Promise<void>
  /** Stage document-local choices against the last observed settings revision. */
  configure(sessionId: string, documentId: string, revision: number, policy: PdfDocumentIndexPolicy, signal: AbortSignal): Promise<void>
  /** Restore profile defaults for the document content switches without changing other PDFs. */
  useDefaults(sessionId: string, documentId: string, revision: number, signal: AbortSignal): Promise<void>
  /** Hide only this completed occurrence across views of the same resource Session. */
  dismiss(sessionId: string, documentId: string, occurrence: number): void
}
