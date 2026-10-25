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
  /** Registration lifetime, separate from the reusable model/config fingerprint. */
  generation?: string
  dimensions: number
  maxBatchSize: number
  maxInputCharacters?: number
  availability?(signal: AbortSignal): Promise<boolean>
  embed(texts: string[], purpose: 'query' | 'document', signal: AbortSignal): Promise<number[][]>
}
export interface RetrievalCache {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}
export interface RetrievalPorts {
  documents: {
    snapshot(sessionId: string, documentId: string): RetrievalDocument
    /** One build-owned lease, independent of the lifetime of any one subscriber. */
    retain?(sessionId: string, documentId: string, signal: AbortSignal): Promise<() => void>
  }
  pages: { read(sessionId: string, documentId: string, page: number, signal: AbortSignal): Promise<{
    text: string; source: 'pdf-text' | 'ocr'; warnings?: string[]
  }> }
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
export interface RetrievalResult {
  status: 'building' | 'complete' | 'incomplete'
  requestedMode: RetrievalMode
  effectiveMode: Exclude<RetrievalMode, 'auto'>
  fallbackReason?: string
  indexGeneration: string
  document: RetrievalDocument
  scope: { fromPage: number; toPage: number }
  coverage: {
    indexedPages: number; totalPages: number; noTextPages: number[]; ocrPages: number[]
    failedPages: { page: number; attempts: number; code: string }[]
    qualityWarnings: { page: number; warnings: string[] }[]
    embeddedChunks: number; totalChunks: number
    visual: 'not-indexed'
  }
  /** Original text ranges. The caller mints exact evidence refs only for returned hits. */
  chunks: (RetrievalChunk & { score: number })[]
  nextCursor?: string
}
export interface RetrievalService {
  search(sessionId: string, input: RetrievalInput, signal?: AbortSignal): Promise<RetrievalResult>
  /** Revalidate after adapter awaits, including reference issuance; never an authorization grant. */
  validate(sessionId: string, result: RetrievalResult): void
  cancelSession(sessionId: string): void
  dispose(): Promise<void>
}
