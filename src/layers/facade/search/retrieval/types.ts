import type { RetrievalChunk } from '../../../derived/content/retrieval/text.js'
import type { RetrievalCache, RetrievalPage } from '../../../derived/indexing/types.js'

export type RetrievalMode = 'auto' | 'lexical' | 'semantic' | 'hybrid'
export interface RetrievalDocument {
  id: string
  path: string
  sourceDigest: string
  /** Stable page-content identity; annotations and file serialization are excluded.
   * Raw sourceDigest remains mandatory for caller freshness and evidence. */
  indexContentDigest?: string
  /** Ordered Host-verified page identities. A null entry is bound to the exact source bytes. */
  indexPageDigests?: readonly (string | null)[]
  contentVersion: string
  pageCount: number
}
export interface RetrievalEmbedding {
  /** Stable provider/model encoding identity, including revision and dimensions.
   * Excludes endpoint, credentials and transport limits. */
  fingerprint: string
  /** Provider-attested document encoding identity. When absent, persistence uses
   * the full encoding fingerprint, never the live binding or registration. */
  documentFingerprint?: string
  /** Registration lifetime, separate from the reusable model/config fingerprint. */
  generation?: string
  /** Live request binding fence only; never part of persistent cache identity. */
  configurationIdentity?: string
  dimensions: number
  maxBatchSize: number
  maxInputCharacters?: number
  availability?(signal: AbortSignal): Promise<boolean>
  embed(texts: string[], purpose: 'query' | 'document', signal: AbortSignal): Promise<number[][]>
}
export interface RetrievalPorts {
  documents: {
    snapshot(sessionId: string, documentId: string): RetrievalDocument
    /** A build-owned lease for source work, independent of any one subscriber. */
    retain?(sessionId: string, documentId: string, signal: AbortSignal): Promise<() => void>
  }
  pages: {
    /** Synchronous extraction/pipeline identity, independent of embedding selection. */
    identity?(sessionId: string): string
    /** Accepted content-artifact policy; independent of a follow-session model's
     * runtime selection. A caller still fences in-flight work with identity(). */
    indexIdentity?(sessionId: string): string
    read(sessionId: string, documentId: string, page: number, signal: AbortSignal): Promise<RetrievalPage>
  }
  cache?: RetrievalCache
  /** Host-only diagnostic observer, after caller authority is revalidated and before shared errors are sanitized. */
  onFailure?(sessionId: string, documentId: string, error: unknown): void
  embedding?: { select(sessionId: string): RetrievalEmbedding | undefined }
  limits?: Partial<{
    pagesPerStep: number; embeddingBatchesPerStep: number; maxChunks: number
    maxIndexes: number; maxMemoryBytes: number; maxConcurrentJobs: number; maxConcurrentQueries: number
  }>
}
export interface RetrievalInput {
  documentId: string
  query: string
  terms?: string[]
  mode?: RetrievalMode
  topK?: number
  fromPage?: number
  /** The requested scope, not a claim that every page has already been indexed. */
  maxPages?: number
  cursor?: string
}
/** Query-free preparation shares the same scoped index as later searches. */
export type RetrievalPrepareInput = Pick<RetrievalInput, 'documentId' | 'fromPage' | 'maxPages'> & {
  /** Start a fresh structural generation, reusing validated source layers and vectors. */
  rebuild?: boolean
  /** Stable attempt identity makes a forced rebuild resumable across retries. */
  rebuildToken?: string
}
/** Observable work counts, separate from task completion and document authority. */
export interface RetrievalProgress {
  indexedPages: number
  totalPages: number
  embeddedChunks: number
  totalChunks: number
  /** Current work, distinct from counters that also advance on cache hits. */
  phase?: 'restoring' | 'extracting' | 'embedding' | 'ready'
  reusedChunks?: number
  computedChunks?: number
  /** Pages that still lack requested content, including usable partial pages. */
  failedPages?: number
}
export interface RetrievalResult {
  status: 'building' | 'complete' | 'incomplete'
  requestedMode: RetrievalMode
  effectiveMode: Exclude<RetrievalMode, 'auto'>
  fallbackReason?: string
  indexGeneration: string
  document: RetrievalDocument
  scope: { fromPage: number; toPage: number }
  coverage: {
    indexedPages: number; totalPages: number
    /** No native or OCR text; a generated image description does not imply page transcription. */
    noTextPages: number[]
    ocrPages: number[]
    imageDescriptionPages: number[]
    failedPages: { page: number; attempts: number; code: string }[]
    qualityWarnings: { page: number; warnings: string[] }[]
    embeddedChunks: number; totalChunks: number
    visual: 'not-indexed' | 'image-descriptions'
  }
  /** Native offsets support exact evidence; generated units require their own
   * representation provenance and approximate PDF region evidence. */
  chunks: (RetrievalChunk & { score: number })[]
  nextCursor?: string
}
export interface RetrievalService {
  /** Operational state only; never a document access or engine capability grant. */
  state(): 'ready' | 'rebuilding' | 'failed' | 'disposed'
  prepare(sessionId: string, input: RetrievalPrepareInput, signal?: AbortSignal,
    onProgress?: (progress: RetrievalProgress) => void): Promise<void>
  /** Cooperatively finish one bounded unit. Reuse the occurrence object across slices of one task. */
  prepareSlice(sessionId: string, input: RetrievalPrepareInput, signal?: AbortSignal,
    onProgress?: (progress: RetrievalProgress) => void, occurrence?: object): Promise<boolean>
  search(sessionId: string, input: RetrievalInput, signal?: AbortSignal): Promise<RetrievalResult>
  /** Revalidate after adapter awaits, including reference issuance; never an authorization grant. */
  validate(sessionId: string, result: RetrievalResult): void
  cancelSession(sessionId: string): void
  /** Invalidate active searches and derived caches; later searches rebuild on demand. */
  rebuild(): Promise<void>
  dispose(): Promise<void>
}
