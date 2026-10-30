import type { PdfAnnotation, PdfDocumentInfo, PdfFormField, PdfOutlineItem, PdfWorkingCopyOperation } from '../core/pdf-types.js'
import type { NativeReaderApi, ReaderDescriptor } from './native.js'
import type { NavigationPosition } from '../navigation/index.js'
import { defaultExplanationPromptTemplate } from './explanation-template.js'

/** Durable location used to resume reading a PDF. */
export type PdfReadingPosition = Omit<NavigationPosition, 'documentVersion'>

/** Where reading stopped in one file, with the reason it may no longer apply. */
export interface PdfStoredReadingPosition {
  position: PdfReadingPosition
  stale: 'none' | 'content-changed' | 'page-missing'
  updatedAt: string
}

export interface PdfReadingPositionApi {
  /** The remembered position for this file path, or null when none was ever stored. */
  get(sessionId: string, documentId: string, signal?: AbortSignal): Promise<PdfStoredReadingPosition | null>
  set(sessionId: string, documentId: string, position: PdfReadingPosition, signal?: AbortSignal): Promise<void>
}

/** Target languages offered by the per-selection translation panel. */
export const translationTargetLanguages = ['zh', 'en', 'ja', 'ko', 'fr', 'de'] as const
export const translationSourceLanguage = 'auto' as const

export interface PdfSettings {
  ocrEngine?: string
  imageEngine?: string
  embeddingEngine?: string
  /** Recognize scanned or damaged pages with the selected OCR engine while indexing. */
  indexScanPages?: boolean
  /** Optional generated whole-page visual descriptions, independently of OCR. */
  indexImageDescriptions?: boolean
  engineConfigurations?: import('../modules/engines/types.js').EngineConfigurations
  ocrTimeoutMs: number
  translationEngine: string
  translationTargetLanguage: string
  translationTimeoutMs: number
  historyCapacity: number
  maxFileBytes: number
  explanationGeneralInstruction: string
  explanationTextInstruction: string
  explanationImageInstruction: string
  /** Legacy layout template retained for existing profile patches. */
  explanationPromptTemplate: string
}

export const defaultSettings: PdfSettings = {
  ocrEngine: 'session-llm', imageEngine: 'dsh-vision', embeddingEngine: 'none', engineConfigurations: {},
  indexScanPages: true, indexImageDescriptions: false,
  ocrTimeoutMs: 120000,
  translationEngine: 'dsh-model', translationTargetLanguage: 'zh', translationTimeoutMs: 30000,
  historyCapacity: 100, maxFileBytes: 64 * 1024 * 1024,
  explanationGeneralInstruction: '', explanationTextInstruction: '', explanationImageInstruction: '',
  explanationPromptTemplate: defaultExplanationPromptTemplate,
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
  /** Embedded outline before draft operations. */
  baselineOutline?: PdfOutlineItem[]
  baselineFormFields?: PdfFormField[]
  reader: ReaderDescriptor
}

export interface PdfClientApi {
  native: NativeReaderApi
  positions: PdfReadingPositionApi
  open(sessionId: string, address: string, signal?: AbortSignal, referenceId?: string): Promise<WorkspaceSnapshot>
  /** Omit id to permanently close this occurrence's reference, including opens whose reply was lost. */
  release(sessionId: string, id: string | undefined, referenceId: string, signal?: AbortSignal): Promise<void>
  change(sessionId: string, id: string, revision: number, operations: PdfWorkingCopyOperation[], signal?: AbortSignal): Promise<WorkspaceSnapshot>
  undo(sessionId: string, id: string, revision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot>
  redo(sessionId: string, id: string, revision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot>
  reload(sessionId: string, id: string, revision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot>
  /** Restore the last saved/opened baseline and remove the entire undo/redo history. */
  discard(sessionId: string, id: string, revision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot>
  /** Dispose working copies and durable drafts without reading or writing their PDF files. */
  discardMany(sessionId: string, ids: readonly string[], signal?: AbortSignal): Promise<void>
  /** Explicit destructive draft cleanup; never use for view close or Session switching. */
  discardAddresses(sessionId: string, addresses: readonly string[], signal?: AbortSignal): Promise<void>
  inspectTarget(sessionId: string, path: string, signal?: AbortSignal): Promise<{ version: string | null }>
  save(sessionId: string, id: string, revision: number, options: { path?: string; overwrite?: boolean; expectedTargetVersion?: string | null }, signal?: AbortSignal): Promise<WorkspaceSnapshot>
  subscribe(id: string, callback: (snapshot: WorkspaceSnapshot) => void): () => void
}
