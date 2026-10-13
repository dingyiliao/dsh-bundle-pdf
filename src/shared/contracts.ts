import type { PdfAnnotation, PdfAnnotationOperation, PdfDocumentInfo } from '../core/pdf-types.ts'
import type { NativeReaderApi, ReaderDescriptor } from './native.ts'
import type { NavigationPosition } from '../navigation/index.ts'

/** User bookmark locations stay in plugin storage; they are not embedded in the PDF. */
export type PdfBookmarkPosition = Omit<NavigationPosition, 'documentVersion'>
export interface PdfUserBookmark {
  id: string
  title: string
  position: PdfBookmarkPosition
  stale: 'none' | 'content-changed' | 'page-missing'
  createdAt: string
  updatedAt: string
}

export interface PdfBookmarksApi {
  list(sessionId: string, documentId: string, signal?: AbortSignal): Promise<PdfUserBookmark[]>
  add(sessionId: string, documentId: string, title: string, position: PdfBookmarkPosition, signal?: AbortSignal): Promise<PdfUserBookmark[]>
  rename(sessionId: string, documentId: string, bookmarkId: string, title: string, signal?: AbortSignal): Promise<PdfUserBookmark[]>
  remove(sessionId: string, documentId: string, bookmarkId: string, signal?: AbortSignal): Promise<PdfUserBookmark[]>
}

/** Target languages offered by the per-selection translation panel. */
export const translationTargetLanguages = ['zh', 'en', 'ja', 'ko', 'fr', 'de'] as const
export const translationSourceLanguage = 'auto' as const

export interface PdfSettings {
  ocrEngine: string
  ocrLanguages: string
  ocrTimeoutMs: number
  translationEngine: string
  translationTargetLanguage: string
  translationTimeoutMs: number
  historyCapacity: number
  maxFileBytes: number
}

export const defaultSettings: PdfSettings = {
  ocrEngine: 'none', ocrLanguages: 'eng+chi_sim', ocrTimeoutMs: 120000,
  translationEngine: 'dsh-model', translationTargetLanguage: 'zh', translationTimeoutMs: 30000,
  historyCapacity: 100, maxFileBytes: 64 * 1024 * 1024,
}

/** Older settings used `none` to disable translation; keep those profiles usable. */
export function effectiveTranslationEngine(engineId: string): string {
  return engineId === 'none' ? defaultSettings.translationEngine : engineId
}

export interface WorkspaceSnapshot {
  id: string
  path: string
  /** Filesystem version used by the DSH document preview owner. */
  sourceVersion: string
  /** Page content identity; annotation edits do not invalidate reading anchors. */
  contentVersion: string
  revision: number
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
  conflict: boolean
  warning?: string
  document: PdfDocumentInfo
  /** Native annotations present in bytes before projecting unsaved operations. */
  baselineAnnotations?: PdfAnnotation[]
  reader: ReaderDescriptor
}

export interface PdfClientApi {
  native: NativeReaderApi
  bookmarks: PdfBookmarksApi
  open(sessionId: string, address: string, signal?: AbortSignal): Promise<WorkspaceSnapshot>
  change(sessionId: string, id: string, revision: number, operations: PdfAnnotationOperation[], signal?: AbortSignal): Promise<WorkspaceSnapshot>
  undo(sessionId: string, id: string, revision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot>
  redo(sessionId: string, id: string, revision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot>
  reload(sessionId: string, id: string, revision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot>
  /** Restore the last saved/opened baseline and remove the entire undo/redo history. */
  discard(sessionId: string, id: string, revision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot>
  /** Dispose working copies and durable drafts without reading or writing their PDF files. */
  discardMany(sessionId: string, ids: readonly string[], signal?: AbortSignal): Promise<void>
  /** Clear drafts for restored PDF tabs that have not mounted a reader yet. */
  discardAddresses(sessionId: string, addresses: readonly string[], signal?: AbortSignal): Promise<void>
  inspectTarget(sessionId: string, path: string, signal?: AbortSignal): Promise<{ version: string | null }>
  save(sessionId: string, id: string, revision: number, options: { path?: string; overwrite?: boolean; expectedTargetVersion?: string | null }, signal?: AbortSignal): Promise<WorkspaceSnapshot>
  subscribe(id: string, callback: (snapshot: WorkspaceSnapshot) => void): () => void
}
