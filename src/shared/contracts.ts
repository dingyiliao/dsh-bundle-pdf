import type { PdfAnnotationOperation, PdfDocumentInfo } from '../core/pdf-types.ts'

export interface PdfSettings {
  ocrEngine: string
  ocrLanguages: string
  ocrTimeoutMs: number
  defaultColor: string
  historyCapacity: number
  maxFileBytes: number
}

export const defaultSettings: PdfSettings = {
  ocrEngine: 'none', ocrLanguages: 'eng+chi_sim', ocrTimeoutMs: 120000,
  defaultColor: '#ffff00', historyCapacity: 100, maxFileBytes: 64 * 1024 * 1024,
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
  bytes: Uint8Array
}

export interface PdfClientApi {
  open(sessionId: string, address: string, signal?: AbortSignal): Promise<WorkspaceSnapshot>
  change(sessionId: string, id: string, revision: number, operations: PdfAnnotationOperation[], signal?: AbortSignal): Promise<WorkspaceSnapshot>
  undo(sessionId: string, id: string, revision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot>
  redo(sessionId: string, id: string, revision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot>
  reload(sessionId: string, id: string, revision: number, signal?: AbortSignal): Promise<WorkspaceSnapshot>
  inspectTarget(sessionId: string, path: string, signal?: AbortSignal): Promise<{ version: string | null }>
  save(sessionId: string, id: string, revision: number, options: { path?: string; overwrite?: boolean; expectedTargetVersion?: string | null }, signal?: AbortSignal): Promise<WorkspaceSnapshot>
  subscribe(id: string, callback: (snapshot: WorkspaceSnapshot) => void): () => void
}
