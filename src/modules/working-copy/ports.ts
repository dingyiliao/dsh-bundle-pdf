import type { WorkspaceSnapshot } from '../../shared/contracts.js'
import type { PdfDocumentInfo, PdfWorkingCopyOperation } from '../../core/pdf-types.js'
import type { DraftRecord, WorkspaceRecord } from './schema.js'

/** Host-only snapshot; PDF bytes never cross the Client RPC boundary. */
export type HostWorkspaceSnapshot = Omit<WorkspaceSnapshot, 'reader'> & { bytes: Uint8Array }

export type DocumentReleaseStatus = 'released' | 'retained-ui' | 'retained-model' | 'retained-operation' | 'already-closed'

/** Lightweight registry metadata, independent of resident snapshots/native buffers. */
export interface DocumentResidency {
  sessionId: string
  id: string
  bytes: number
  resident: boolean
  touched: number
  uiReferences: number
  modelOwned: boolean
  modelReferenceId?: string
  pins: number
}

/** Minimum authority needed by read-only features after session authorization. */
export interface WorkingCopyReadPort {
  readSnapshot(sessionId: string, documentId: string): HostWorkspaceSnapshot
}

/** The DSH agent is intentionally represented by only the session fields used here. */
export interface WorkingCopyAgent {
  readonly session: { readonly id: string; readonly header: { readonly cwd?: string } }
}

export interface WorkingCopyFileVersion {
  path: string
  version: string
  fsVersion: string
  size: number
}

export interface WorkingCopyFileRead extends WorkingCopyFileVersion {
  bytes: Uint8Array
}

/** Sandbox checks, canonical paths and atomic publication are owned by this port's adapter. */
export interface WorkingCopyFilePort {
  resolvePath(agent: WorkingCopyAgent, path: string, signal?: AbortSignal): Promise<string>
  read(agent: WorkingCopyAgent, path: string, signal?: AbortSignal): Promise<WorkingCopyFileRead>
  save(agent: WorkingCopyAgent, path: string, content: Uint8Array, expectedVersion: string | null,
    options?: { overwrite?: boolean; signal?: AbortSignal }): Promise<WorkingCopyFileVersion>
}

/** V1 storage table semantics, independent of the DSH Storage Domain type. */
export interface V1DraftPort {
  get(key: string): DraftRecord | undefined
  put(key: string, value: DraftRecord): Promise<unknown>
  delete(key: string): Promise<unknown>
}

/** Persistence-specific keying and write order live behind this adapter. */
export interface WorkingCopyDraftPort extends V1DraftPort {
  key(sessionId: string, path: string): string
  samePath(left: string, right: string): boolean
  hydrate(saved: DraftRecord): WorkspaceRecord
  persist(record: WorkspaceRecord, key: string, baselineBytes: Uint8Array,
    renderedHash?: string): Promise<WorkspaceRecord>
  deleteBaseline(record: DraftRecord): Promise<void>
}

export interface PdfDocumentPort {
  inspect(bytes: Uint8Array): Promise<PdfDocumentInfo>
  materialize(bytes: Uint8Array, operations: readonly PdfWorkingCopyOperation[],
    operationDates: readonly string[]): Promise<{ bytes: Uint8Array; document: PdfDocumentInfo }>
}
