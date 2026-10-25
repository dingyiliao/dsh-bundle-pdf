import type { PromptContentPart } from '../../explanation/index.js'
import type { PdfRect } from '../../../core/pdf-types.js'
import type { AgentNavigationRequest } from '../../../contracts/navigation.js'

/** The DSH document slot provides this lease; Viewer needs no Slot runtime. */
export interface ReaderContentLease {
  readonly revision: number
  readonly loaded: (version: string) => void
  readonly failed: () => void
}

/** Volatile reading position; no PDF text or selection crosses this channel. */
export type PdfReadingContextUpdate =
  | { action: 'set'; sessionId: string; tabId: string; leaseId: string;
    documentId: string; contentVersion: string; page: number }
  | { action: 'clear'; sessionId: string; tabId: string; leaseId: string }

export type ReaderContextReporter = (update: PdfReadingContextUpdate) => Promise<void>
export interface PdfAgentNavigationApi {
  wait(context: { sessionId: string; tabId: string; leaseId: string; documentId: string;
    contentVersion: string }, signal: AbortSignal): Promise<AgentNavigationRequest | null>
  watchRequest(context: { sessionId: string; tabId: string; leaseId: string; documentId: string;
    contentVersion: string; requestId: string }, signal: AbortSignal): Promise<{ active: boolean }>
  complete(context: { sessionId: string; tabId: string; leaseId: string; documentId: string;
    contentVersion: string; requestId: string; status: 'opened' | 'stale' | 'unavailable';
    targetRevision?: number; sourceDigest?: string },
  signal: AbortSignal): Promise<void>
}
export type ReaderPromptExplanation = (content: string | readonly PromptContentPart[], signal: AbortSignal) => Promise<void>

/** A PDF region rendered and authenticated by Host, not pixels captured from the Client canvas. */
export interface PdfRegionEvidence {
  refId: string
  documentId: string
  page: number
  rectPdf: PdfRect
  sourcePath: string
  sourceDigest: string
  sourceVersion: string
  contentVersion: string
  revision: number
  mediaType: 'image/png'
  width: number
  height: number
  bytes: Uint8Array
}

export interface PdfRegionEvidenceApi {
  prepare(request: { sessionId: string; documentId: string; page: number; rectPdf: PdfRect;
    expectedRevision: number; expectedContentVersion: string; maxEdge?: number },
  signal?: AbortSignal): Promise<PdfRegionEvidence>
}

/** Host-re-extracted quote at the selected PDFium glyph positions. */
export interface PdfTextSelectionEvidence {
  text: string
  documentId: string
  sourcePath: string
  sourceDigest: string
  sourceVersion: string
  contentVersion: string
  revision: number
  excerpts: readonly { page: number; text: string; refId: string; startUtf16: number; endUtf16: number }[]
}

export interface PdfTextSelectionEvidenceApi {
  prepare(request: { sessionId: string; documentId: string; expectedRevision: number;
    expectedContentVersion: string; quote: string;
    fragments: readonly { page: number; rect: PdfRect; quadPoints: readonly number[] }[] },
  signal?: AbortSignal): Promise<PdfTextSelectionEvidence>
}
