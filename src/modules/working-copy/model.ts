import type { PdfDocumentInfo, PdfWorkingCopyOperation } from '../../core/pdf-types.js'

/** A stable identity for the exact PDF baseline bytes used by a working copy. */
export type BaselineId = string & { readonly __baselineId: unique symbol }

export function asBaselineId(value: string): BaselineId {
  return value as BaselineId
}

export interface SourceVersion {
  readonly path: string
  /** Digest of the exact source bytes. */
  readonly digest: string
  /** Filesystem/provider version; never a replacement for digest. */
  readonly version: string
  readonly size: number
}

/**
 * The fixed PDF version from which operations are projected.
 * `bytes` are Host-only and never cross the Client RPC boundary.
 */
export interface BaselineResource<TDocument = PdfDocumentInfo> {
  readonly baselineId: BaselineId
  readonly source: SourceVersion
  readonly bytes: Uint8Array
  readonly document: TDocument
  /** Native handles are adapter-owned and scoped; they are not persisted here. */
}

export interface OperationGroup {
  readonly operations: readonly PdfWorkingCopyOperation[]
  readonly date: string
}

/** The logical editable state; it survives native baseline eviction. */
export interface OperationSet {
  readonly baselineId: BaselineId | undefined
  readonly groups: readonly OperationGroup[]
  readonly cursor: number
  readonly revision: number
}

/** The durable identity shared by Reader and model entry points. */
export interface WorkingCopyRecord {
  readonly sessionId: string
  readonly path: string
  readonly source: SourceVersion
  readonly operations: OperationSet
}

/** The identity shared by Reader and model renderers for one derived content revision. */
export interface ContentContext {
  readonly baselineId: BaselineId
  /** Working-copy revision; changes on edits, undo/redo, reload and save. */
  readonly revision: number
  readonly sourceDigest: string
  readonly contentVersion: string
  readonly indexContentDigest?: string
  readonly indexPageDigests?: readonly (string | null)[]
}

/** A renderer-specific result; it does not own a native handle. */
export interface ContentSnapshot<TContent = unknown> extends ContentContext {
  readonly id: string
  readonly renderer: 'reader' | 'agent'
  readonly content: TContent
}

export function contentSnapshotOf<TContent>(id: string, renderer: ContentSnapshot['renderer'], context: ContentContext,
  content: TContent): ContentSnapshot<TContent> {
  return { ...context, id, renderer, content }
}

export type BaselineAcquireFailure =
  | { readonly kind: 'source-missing'; readonly message: string; readonly code?: string; readonly cause?: unknown }
  | { readonly kind: 'invalid-pdf'; readonly message: string; readonly code?: string; readonly cause?: unknown }
  | { readonly kind: 'protected'; readonly message: string; readonly code?: string; readonly cause?: unknown }
  | { readonly kind: 'capacity'; readonly message: string; readonly code?: string; readonly cause?: unknown }
  | { readonly kind: 'native-unavailable'; readonly message: string; readonly code?: string; readonly cause?: unknown }
  | { readonly kind: 'unknown'; readonly message: string; readonly cause: unknown; readonly code?: string }

export type BaselineAcquireResult<TDocument = PdfDocumentInfo> =
  | { readonly kind: 'acquired'; readonly baseline: BaselineResource<TDocument> }
  | { readonly kind: 'failed'; readonly error: BaselineAcquireFailure }

/** Baseline acquisition hides encryption, password and native implementation details. */
export interface BaselineProvider<TAccess = unknown, TDocument = PdfDocumentInfo> {
  acquire(source: SourceVersion & { readonly bytes: Uint8Array }, access: TAccess,
    signal?: AbortSignal): Promise<BaselineAcquireResult<TDocument>>
  release(baseline: BaselineResource<TDocument>): Promise<void>
}

export function operationSetOf(record: {
  baselineId?: string
  sourceHash?: string
  groups: readonly (readonly PdfWorkingCopyOperation[])[]
  groupDates: readonly string[]
  cursor: number
  revision: number
}): OperationSet {
  return {
    baselineId: record.baselineId ? asBaselineId(record.baselineId)
      : record.groups.length && record.sourceHash ? asBaselineId(record.sourceHash) : undefined,
    groups: record.groups.map((operations, index) => ({
      operations,
      date: record.groupDates[index] ?? new Date(0).toISOString(),
    })),
    cursor: record.cursor,
    revision: record.revision,
  }
}

export function sourceVersionOf(source: {
  path: string
  version: string
  fsVersion: string
  size: number
}): SourceVersion {
  return { path: source.path, digest: source.version, version: source.fsVersion, size: source.size }
}
