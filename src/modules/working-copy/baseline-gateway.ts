import { decodePdfBaseline } from '../document/index.js'
import { protectedDocumentInfo } from './protected.js'
import { asBaselineId, sourceVersionOf, type BaselineAcquireFailure, type BaselineProvider,
  type BaselineResource, type SourceVersion } from './model.js'
import { PdfDocumentError } from '../../core/pdf-types.js'
import type { PdfDocumentPort, ProtectedDocumentPort, WorkingCopyFileRead } from './ports.js'
import type { WorkspaceRecord } from './schema.js'

export type BaselineAccess = { owner: 'ui' | 'agent'; password?: string }

function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }

export function classifyBaselineFailure(error: unknown): BaselineAcquireFailure {
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
  const message = errorText(error)
  const normalizedCode = error instanceof PdfDocumentError && error.code === 'encrypted' ? 'pdf/password-required' : code
  if (code === 'PDF_NOT_FOUND' || code === 'pdf/source-missing') return { kind: 'source-missing', message, code, cause: error }
  if (error instanceof PdfDocumentError && error.code === 'invalid-pdf') return { kind: 'invalid-pdf', message, code, cause: error }
  if (error instanceof PdfDocumentError && error.code === 'encrypted' || code === 'pdf/password-required'
    || code === 'pdf/protected-document' || code === 'pdf/not-encrypted') {
    return { kind: 'protected', message, code: normalizedCode, cause: error }
  }
  if (code === 'pdf/native-size' || code === 'pdf/native-busy') return { kind: 'capacity', message, code, cause: error }
  if (code === 'pdf/native-unavailable' || code === 'pdf/unavailable') return { kind: 'native-unavailable', message, code, cause: error }
  return { kind: 'unknown', message, cause: error, ...(code ? { code } : {}) }
}

/** Acquire immutable PDF baselines without owning working-copy identity or credentials. */
export function createBaselineGateway(pdf: PdfDocumentPort, protectedDocument?: ProtectedDocumentPort,
  rememberHash?: (bytes: Uint8Array, hash: string) => void): BaselineProvider<BaselineAccess> & {
    fromStored(record: WorkspaceRecord): Promise<BaselineResource>
  } {
  async function ordinary(source: SourceVersion & { bytes: Uint8Array }): Promise<BaselineResource> {
    rememberHash?.(source.bytes, source.digest)
    return { baselineId: asBaselineId(source.digest), source, bytes: source.bytes,
      document: await pdf.inspect(source.bytes) }
  }

  async function inspect(source: SourceVersion & { bytes: Uint8Array }, access: BaselineAccess,
    signal: AbortSignal): Promise<BaselineResource> {
    if (access.password !== undefined && protectedDocument) {
      const document = await protectedDocument.inspect(source.bytes, access.password, signal).catch((cause: unknown) => {
        if (access.owner === 'agent' && cause instanceof Error && 'code' in cause && cause.code === 'pdf/password-required') {
          fail('pdf/password-required', 'A password is required to open this protected PDF')
        }
        throw cause
      })
      if (!document) fail('pdf/not-encrypted', 'This PDF no longer requires a password; reopen it')
      return { baselineId: asBaselineId(source.digest), source, bytes: source.bytes,
        document: protectedDocumentInfo(document, !!protectedDocument.materializeAnnotations) }
    }
    let parseError: unknown
    try { return await ordinary(source) }
    catch (error) {
      parseError = error
      if (!protectedDocument || !(error instanceof PdfDocumentError)
        || error.code !== 'invalid-pdf' && error.code !== 'encrypted') throw error
    }
    const document = await protectedDocument.inspect(source.bytes, access.password, signal).catch((cause: unknown) => {
      if (access.owner === 'agent' && cause instanceof Error && 'code' in cause && cause.code === 'pdf/password-required') {
        fail('pdf/password-required', 'A password is required to open this protected PDF')
      }
      throw cause
    })
    if (!document) {
      if (access.password !== undefined || access.owner === 'agent') fail('pdf/password-required', 'A password is required to open this protected PDF')
      throw parseError
    }
    if (access.owner === 'agent' && access.password === undefined && document.encrypted) {
      fail('pdf/password-required', 'A password is required to open this protected PDF')
    }
    return { baselineId: asBaselineId(source.digest), source, bytes: source.bytes,
      document: protectedDocumentInfo(document, !!protectedDocument.materializeAnnotations) }
  }

  return {
    async acquire(source, access, signal) {
      try {
        return { kind: 'acquired', baseline: await inspect(source, access, signal ?? new AbortController().signal) }
      } catch (error) {
        return { kind: 'failed', error: classifyBaselineFailure(error) }
      }
    },
    async release() { /* Native handles are owned by the PDF adapter's scoped lease. */ },
    async fromStored(record) {
      if (!record.original) fail('pdf/draft-damaged', 'Saved draft baseline is missing')
      const bytes = decodePdfBaseline(record.original, record.sourceHash)
      rememberHash?.(bytes, record.sourceHash)
      return ordinary({ path: record.path, digest: record.sourceHash,
        version: record.sourceVersion, size: bytes.byteLength, bytes })
    },
  }
}

export function baselineSource(source: WorkingCopyFileRead): SourceVersion & { bytes: Uint8Array } {
  return { ...sourceVersionOf(source), bytes: source.bytes }
}
