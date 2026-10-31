import type { RetrievalChunk } from './text.js'

export type RetrievalMode = 'auto' | 'lexical' | 'semantic' | 'hybrid'
export interface RetrievalDocument {
  id: string
  path: string
  sourceDigest: string
  contentVersion: string
  pageCount: number
}
export interface RetrievalEmbedding {
  /** Includes provider, model revision, dimensions and query/document encoding configuration. */
  fingerprint: string
  /** Provider-attested document encoding identity. When absent the complete
   * fingerprint/binding pair remains the conservative persistent vector key. */
  documentFingerprint?: string
  /** Registration lifetime, separate from the reusable model/config fingerprint. */
  generation?: string
  /** Exact engine binding identity; third-party fingerprints may omit configuration. */
  configurationIdentity?: string
  dimensions: number
  maxBatchSize: number
  maxInputCharacters?: number
  availability?(signal: AbortSignal): Promise<boolean>
  embed(texts: string[], purpose: 'query' | 'document', signal: AbortSignal): Promise<number[][]>
}
export interface RetrievalCache {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  /** Remove all derived records. Required when this cache supports explicit rebuilds. */
  clear?(): Promise<void>
}
export type RetrievalPageUnitKind = 'native-text' | 'ocr-text' | 'image-description'
export interface RetrievalPageUnitProducer {
  id: string
  version?: string
  model?: string
  configurationIdentity?: string
}
export interface RetrievalPageUnitSpan {
  startUtf16: number
  endUtf16: number
  rectPdf: [number, number, number, number]
}
/** One exact representation of a logical content block. Generated offsets stay
 * local to this unit and must never be interpreted as native PDF text offsets. */
export interface RetrievalPageUnit {
  id: string
  blockId: string
  kind: RetrievalPageUnitKind
  text: string
  /** SHA-256 of the exact representation text, prefixed with sha256:. */
  digest: string
  paragraphBreaks?: number[]
  nativeRange?: { startUtf16: number; endUtf16: number }
  rectPdf?: [number, number, number, number]
  spans?: RetrievalPageUnitSpan[]
  producer?: RetrievalPageUnitProducer
  inputDigest?: string
}
export interface RetrievalPageFailure {
  code: string
}
export interface RetrievalPage {
  /** Joined native text; legacy OCR-only ports may keep their existing format. */
  text: string
  source: 'pdf-text' | 'ocr'
  warnings?: string[]
  paragraphBreaks?: number[]
  /** When supplied, these are the complete searchable units for this page. */
  units?: RetrievalPageUnit[]
  contentIdentity?: string
  /** Available representations are usable, but optional extraction was incomplete.
   * Such pages are never persisted and retry only through an explicit rebuild. */
  failure?: RetrievalPageFailure
}
export interface RetrievalPorts {
  documents: {
    snapshot(sessionId: string, documentId: string): RetrievalDocument
    /** One build-owned lease, independent of the lifetime of any one subscriber. */
    retain?(sessionId: string, documentId: string, signal: AbortSignal): Promise<() => void>
  }
  pages: {
    /** Synchronous extraction/pipeline identity, independent of embedding selection. */
    identity?(sessionId: string): string
    read(sessionId: string, documentId: string, page: number, signal: AbortSignal): Promise<RetrievalPage>
  }
  cache?: RetrievalCache
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
  /** Re-extract and re-embed this source with the selected engine, preserving unrelated indexes. */
  rebuild?: boolean
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
  search(sessionId: string, input: RetrievalInput, signal?: AbortSignal): Promise<RetrievalResult>
  /** Revalidate after adapter awaits, including reference issuance; never an authorization grant. */
  validate(sessionId: string, result: RetrievalResult): void
  cancelSession(sessionId: string): void
  /** Invalidate active searches and derived caches; later searches rebuild on demand. */
  rebuild(): Promise<void>
  dispose(): Promise<void>
}
