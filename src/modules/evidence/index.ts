import { randomUUID } from 'node:crypto'
import type { HostWorkspaceSnapshot, WorkingCopyReadPort } from '../working-copy/index.js'
import { findExactInPage, findNormalizedInPage } from '../search/index.js'
import { joinPageText } from '../../shared/page-text.js'
import { approximateTextRects } from './geometry.js'
import { evidenceSha256 } from './provenance.js'
import { textWindow } from './text-window.js'
import { createMemoryEvidenceReferenceStore,
  isSavedTextReference, type EvidenceReferenceStore, type PdfTextEvidence } from './reference-store.js'
import type { NativeTextContent } from '../../shared/native.js'

export { evidenceSha256, imageEvidenceSource } from './provenance.js'
export { assertFreshSource } from './source-freshness.js'
export type { FreshSourceRead } from './source-freshness.js'
export type { ImageEvidenceSource } from './provenance.js'
export { savedReferenceSchema, savedTextReferenceSchema, savedImageReferenceSchema,
  textEvidenceSchema, imageEvidenceSchema, createMemoryEvidenceReferenceStore } from './reference-store.js'
export type { EvidenceReferenceStore, PdfTextEvidence, PdfImageEvidence, SavedReference,
  SavedTextReference, SavedImageReference } from './reference-store.js'
export { createImageEvidenceRegistry } from './image-reference.js'
export { prepareTextSelectionEvidence } from './selection.js'
export type { SelectionEvidenceRequest, SelectionFragment, SelectionTextReader } from './selection.js'
export type { ImageEvidenceCapture, ImageAttachmentVerifier } from './image-reference.js'
export { captureRenderedPageEvidence, captureOcrPageEvidence } from './image-capture.js'
export type { OcrPageEvidenceValue } from './image-capture.js'
export { windowPageText } from './text-window.js'
export { evidenceNavigationRequestSchema, revalidateEvidenceNavigation } from './navigation-check.js'
export type { EvidenceNavigationRequest } from './navigation-check.js'
export { readPageWindow, searchPageWindows, listPageAnnotations } from './agent-page-read.js'
export type { AgentPageReadPort, PageAnnotation } from './agent-page-read.js'
export { renderPageForAgent, ocrPageForAgent } from './agent-page-image.js'
export type { AgentPageImagePort, AgentImageServices, AgentOcrPort, AgentImageUnderstandingPort,
  AgentImageAttachmentPort, RenderedPageValue, DerivedPageValue } from './agent-page-image.js'

export interface PageTextReadPort {
  readPageText(sessionId: string, documentId: string, page: number, signal: AbortSignal): Promise<{
    snapshot: HostWorkspaceSnapshot; content: NativeTextContent
  }>
}

const MAX_CONTEXT_BYTES = 32_000
const MAX_CONTEXT_OUTPUT_BYTES = 64_000
const hash = evidenceSha256
function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }

interface Version { documentId: string; contentVersion: string; revision: number; sourceDigest: string }

interface Cursor {
  kind: 'locate' | 'context'; sessionId: string; documentId: string; contentVersion: string; revision: number
  sourceDigest: string
  queryHash: string; page: number; offset: number; scopePage?: number
}
function encodeCursor(cursor: Cursor): string { return Buffer.from(JSON.stringify(cursor)).toString('base64url') }
function decodeCursor(value: string): Cursor {
  try {
    if (value.length > 4096) throw new Error('Cursor too long')
    const decoded = Buffer.from(value, 'base64url')
    if (decoded.toString('base64url') !== value) throw new Error('Non-canonical cursor')
    const item = JSON.parse(decoded.toString('utf8')) as Cursor
    if (!item || !['locate', 'context'].includes(item.kind) || typeof item.sessionId !== 'string'
      || typeof item.documentId !== 'string' || typeof item.contentVersion !== 'string'
      || typeof item.sourceDigest !== 'string'
      || !Number.isSafeInteger(item.revision) || item.revision < 0
      || !Number.isSafeInteger(item.page) || item.page < 1
      || !Number.isSafeInteger(item.offset) || item.offset < 0
      || typeof item.queryHash !== 'string') throw new Error('Invalid cursor')
    return item
  } catch { return fail('pdf/invalid-window', 'Invalid PDF cursor; restart from the first window') }
}

/** Session-fenced, read-only evidence use cases. The store is durable in the Host composition. */
export function createEvidenceReader(workspaces: WorkingCopyReadPort, pages: PageTextReadPort,
  references: EvidenceReferenceStore = createMemoryEvidenceReferenceStore()) {
  const digests = new WeakMap<Uint8Array, string>()
  const digestOf = (bytes: Uint8Array) => {
    let digest = digests.get(bytes)
    if (!digest) { digest = hash(bytes); digests.set(bytes, digest) }
    return digest
  }
  const sameVersion = (left: Version, right: HostWorkspaceSnapshot): boolean =>
    left.documentId === right.id && left.contentVersion === right.contentVersion
      && left.revision === right.revision && left.sourceDigest === digestOf(right.bytes)

  function status(sessionId: string, documentId: string) {
    const snapshot = workspaces.readSnapshot(sessionId, documentId)
    return { documentId: snapshot.id, path: snapshot.path, pageCount: snapshot.document.pageCount,
      sourceDigest: digestOf(snapshot.bytes), sourceVersion: snapshot.sourceVersion,
      contentVersion: snapshot.contentVersion, revision: snapshot.revision,
      dirty: snapshot.dirty, conflict: snapshot.conflict, canUndo: snapshot.canUndo, canRedo: snapshot.canRedo,
      observedAt: new Date().toISOString(),
      limitations: ['Status reflects the working copy at observation time; external changes require a new file check.'] }
  }

  function createEvidence(snapshot: HostWorkspaceSnapshot, page: number,
    text: string, startUtf16: number, endUtf16: number, content?: NativeTextContent): PdfTextEvidence {
    const excerpt = text.slice(startUtf16, endUtf16)
    const rects = content && approximateTextRects(content, snapshot.document.pages?.[page - 1], startUtf16, endUtf16)
    const evidence: PdfTextEvidence = { refId: `pdfref_${randomUUID()}`, documentId: snapshot.id,
      sourcePath: snapshot.path, sourceDigest: digestOf(snapshot.bytes), sourceVersion: snapshot.sourceVersion,
      contentVersion: snapshot.contentVersion, revision: snapshot.revision, page, source: 'pdf-text',
      pageTextDigest: hash(text),
      snapshot: { text: excerpt, sha256: hash(excerpt) },
      locator: { kind: 'text-window', startUtf16, endUtf16, ...(rects ? { rectsPdf: rects } : {}) },
      precision: rects ? 'approximate-geometry' : 'exact-text',
      limitations: rects
        ? ['PDF-space boxes approximate selection bounds from glyph origins; they are not exact painted outlines.']
        : ['Text offsets refer to joined page text; visual PDF coordinates are not verified.'] }
    return evidence
  }

  async function remember(sessionId: string, snapshot: HostWorkspaceSnapshot, page: number,
    text: string, startUtf16: number, endUtf16: number, content?: NativeTextContent): Promise<PdfTextEvidence> {
    const evidence = createEvidence(snapshot, page, text, startUtf16, endUtf16, content)
    await references.put(evidence.refId, { sessionId, evidence, pageTextDigest: hash(text), createdAt: Date.now() })
    return evidence
  }

  function reference(sessionId: string, refId: string): PdfTextEvidence {
    const saved = references.get(refId)
    if (!saved || !isSavedTextReference(saved) || saved.sessionId !== sessionId) {
      fail('pdf/reference-unavailable', 'PDF text reference is unavailable in this session')
    }
    const snapshot = workspaces.readSnapshot(sessionId, saved.evidence.documentId)
    if (!sameVersion(saved.evidence, snapshot)) {
      fail('pdf/stale-reader', 'PDF changed since this reference was captured')
    }
    return saved.evidence
  }

  async function revalidateReference(sessionId: string, refId: string, documentId: string, signal: AbortSignal) {
    const saved = references.get(refId)
    if (!saved || !isSavedTextReference(saved) || saved.sessionId !== sessionId) {
      fail('pdf/reference-unavailable', 'PDF reference is unavailable in this session and document')
    }
    // Ownership is resolved before reading text; a refId is never an access token.
    const current = workspaces.readSnapshot(sessionId, documentId)
    if (current.path !== saved.evidence.sourcePath) {
      fail('pdf/reference-unavailable', 'PDF reference belongs to a different source path')
    }
    if (sameVersion(saved.evidence, current)) {
      return { evidence: saved.evidence, revalidated: false }
    }
    if (saved.evidence.page > current.document.pageCount) {
      fail('pdf/stale-reader', 'Referenced page no longer exists')
    }
    const result = await read(sessionId, documentId, saved.evidence.page, signal)
    // An annotation-only save changes revision and source bytes, but not the
    // joined page text. A new PDF with merely the same short quote is unsafe.
    if (hash(result.text) !== saved.pageTextDigest
      || result.text.slice(saved.evidence.locator.startUtf16, saved.evidence.locator.endUtf16)
        !== saved.evidence.snapshot.text
      || hash(saved.evidence.snapshot.text) !== saved.evidence.snapshot.sha256) {
      fail('pdf/stale-reader', 'Referenced page text changed; locate the quote again')
    }
    return { evidence: await remember(sessionId, result.snapshot, saved.evidence.page, result.text,
      saved.evidence.locator.startUtf16, saved.evidence.locator.endUtf16, result.content), revalidated: true }
  }

  async function read(sessionId: string, documentId: string, page: number, signal: AbortSignal,
    expected?: Version) {
    signal.throwIfAborted()
    const result = await pages.readPageText(sessionId, documentId, page, signal)
    const latest = workspaces.readSnapshot(sessionId, documentId)
    if (!sameVersion({ documentId: result.snapshot.id, contentVersion: result.snapshot.contentVersion,
      revision: result.snapshot.revision, sourceDigest: digestOf(result.snapshot.bytes) }, latest)
      || expected && !sameVersion(expected, latest)) {
      fail('pdf/stale-reader', 'PDF changed during evidence extraction; retry')
    }
    return { snapshot: result.snapshot, content: result.content, text: joinPageText(result.content.items) }
  }

  function checkedCursor(value: string | undefined, expected: Omit<Cursor, 'page' | 'offset'>): Cursor | undefined {
    if (!value) return undefined
    const cursor = decodeCursor(value)
    if (cursor.kind !== expected.kind || cursor.sessionId !== expected.sessionId
      || cursor.documentId !== expected.documentId || cursor.contentVersion !== expected.contentVersion
      || cursor.revision !== expected.revision || cursor.sourceDigest !== expected.sourceDigest
      || cursor.queryHash !== expected.queryHash
      || cursor.scopePage !== expected.scopePage) fail('pdf/stale-reader', 'PDF cursor does not match this query or version')
    return cursor
  }

  async function locate(sessionId: string, input: {
    documentId: string; quote: string; mode?: 'exact' | 'normalized'; page?: number; fromPage?: number; cursor?: string
  }, signal: AbortSignal) {
    const snapshot = workspaces.readSnapshot(sessionId, input.documentId)
    const pageCount = snapshot.document.pageCount
    const initialPage = input.page ?? input.fromPage ?? 1
    if (initialPage > pageCount) fail('pdf/invalid-page', 'Page is outside the document')
    const mode = input.mode ?? 'exact'
    const identity = { kind: 'locate' as const, sessionId, documentId: input.documentId,
      contentVersion: snapshot.contentVersion, revision: snapshot.revision,
      sourceDigest: digestOf(snapshot.bytes),
      queryHash: hash(JSON.stringify([input.quote, mode, input.page ?? null, input.fromPage ?? null])),
      ...(input.page === undefined ? {} : { scopePage: input.page }) }
    const cursor = checkedCursor(input.cursor, identity)
    let current = cursor?.page ?? initialPage
    const throughPage = Math.min(pageCount, current + 9, input.page ?? pageCount)
    if (current > throughPage) fail('pdf/invalid-window', 'Cursor is outside the requested page range')
    const matches: Array<{ page: number; offset: number; endOffset: number; excerpt: string; evidence: PdfTextEvidence }> = []
    const noTextPages: number[] = []
    const pagesScanned: number[] = []
    const version = { documentId: snapshot.id, contentVersion: snapshot.contentVersion,
      revision: snapshot.revision, sourceDigest: digestOf(snapshot.bytes) }
    for (; current <= throughPage; current++) {
      const result = await read(sessionId, input.documentId, current, signal, version)
      pagesScanned.push(current)
      if (!result.text.trim()) noTextPages.push(current)
      const start = cursor?.page === current ? cursor.offset : 0
      const found = (mode === 'exact' ? findExactInPage : findNormalizedInPage)(result.text, input.quote, start, 5 - matches.length)
      for (const match of found.matches) {
        matches.push({ page: current, ...match,
          evidence: await remember(sessionId, result.snapshot, current, result.text, match.offset, match.endOffset, result.content) })
      }
      if (matches.length === 5) {
        const next = found.nextOffset === null ? current + 1 : current
        const offset = found.nextOffset ?? 0
        const nextCursor = next <= (input.page ?? pageCount)
          ? encodeCursor({ ...identity, page: next, offset }) : null
        return { status: nextCursor ? 'partial' as const : matches.length > 1 ? 'ambiguous' as const : 'ok' as const,
          documentId: snapshot.id, path: snapshot.path, sourceDigest: digestOf(snapshot.bytes),
          sourceVersion: snapshot.sourceVersion, contentVersion: snapshot.contentVersion, revision: snapshot.revision,
          matches, coverage: { pagesScanned, noTextPages, truncated: nextCursor !== null, nextCursor } }
      }
    }
    const nextCursor = throughPage < (input.page ?? pageCount)
      ? encodeCursor({ ...identity, page: throughPage + 1, offset: 0 }) : null
    return { status: nextCursor ? 'partial' as const : matches.length === 0 ? 'not_found' as const
      : matches.length > 1 ? 'ambiguous' as const : 'ok' as const,
      documentId: snapshot.id, path: snapshot.path, sourceDigest: digestOf(snapshot.bytes),
      sourceVersion: snapshot.sourceVersion, contentVersion: snapshot.contentVersion, revision: snapshot.revision,
      matches, coverage: { pagesScanned, noTextPages, truncated: nextCursor !== null, nextCursor } }
  }

  async function context(sessionId: string, input: {
    documentId: string
    focus: { kind: 'page-window'; page: number; offsetUtf16?: number }
      | { kind: 'reference'; refId: string }
      | { kind: 'query'; quote: string; fromPage?: number }
    maxPages?: number; maxChars?: number; cursor?: string
  }, signal: AbortSignal) {
    const snapshot = workspaces.readSnapshot(sessionId, input.documentId)
    const maxPages = input.maxPages ?? 3, maxChars = input.maxChars ?? 8000
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10
      || !Number.isSafeInteger(maxChars) || maxChars < 2 || maxChars > 12000) {
      fail('pdf/invalid-window', 'Invalid PDF context limits')
    }
    const suppliedCursor = input.cursor ? decodeCursor(input.cursor) : undefined
    if (suppliedCursor && suppliedCursor.kind !== 'context') {
      fail('pdf/invalid-window', 'pdf_context accepts only its own pagination cursor; locate candidates with pdf_locate first')
    }
    let focusPage: number, focusOffset: number
    let revalidatedReference: { from: string; to: string } | null = null
    if (input.focus.kind === 'reference') {
      const resolved = await revalidateReference(sessionId, input.focus.refId, input.documentId, signal)
      focusPage = resolved.evidence.page
      focusOffset = Math.max(0, resolved.evidence.locator.startUtf16 - 300)
      if (resolved.revalidated) revalidatedReference = { from: input.focus.refId, to: resolved.evidence.refId }
    } else if (input.focus.kind === 'query') {
      if (suppliedCursor?.kind === 'context') {
        focusPage = suppliedCursor.page
        focusOffset = suppliedCursor.offset
      } else {
        const located = await locate(sessionId, { documentId: input.documentId,
          quote: input.focus.quote, fromPage: input.focus.fromPage }, signal)
        if (located.matches.length !== 1 || located.status === 'partial') {
          return { status: located.status === 'partial' ? 'partial' as const : located.status,
            documentId: snapshot.id, path: snapshot.path, sourceDigest: digestOf(snapshot.bytes),
            sourceVersion: snapshot.sourceVersion, contentVersion: snapshot.contentVersion,
            revision: snapshot.revision, chunks: [], candidates: located.matches, revalidatedReference,
            coverage: { ...located.coverage, actualChars: 0, actualBytes: 0 },
            limitations: ['Query focus is ambiguous or not fully scanned; use pdf_locate to inspect candidates.'] }
        }
        focusPage = located.matches[0]!.page
        focusOffset = Math.max(0, located.matches[0]!.offset - 300)
      }
    } else { focusPage = input.focus.page; focusOffset = input.focus.offsetUtf16 ?? 0 }
    if (focusPage > snapshot.document.pageCount) fail('pdf/invalid-page', 'Page is outside the document')
    const identity = { kind: 'context' as const, sessionId, documentId: input.documentId,
      contentVersion: snapshot.contentVersion, revision: snapshot.revision,
      sourceDigest: digestOf(snapshot.bytes),
      queryHash: hash(JSON.stringify([input.focus, maxPages, maxChars])) }
    const cursor = suppliedCursor?.kind === 'context' ? checkedCursor(input.cursor, identity) : undefined
    let current = cursor?.page ?? focusPage
    let offset = cursor?.offset ?? focusOffset
    const version = { documentId: snapshot.id, contentVersion: snapshot.contentVersion,
      revision: snapshot.revision, sourceDigest: digestOf(snapshot.bytes) }
    const chunks: Array<{ page: number; evidence: PdfTextEvidence }> = []
    const pagesScanned: number[] = [], noTextPages: number[] = []
    let chars = 0, bytes = 0, nextCursor: string | null = null
    while (current <= snapshot.document.pageCount && pagesScanned.length < maxPages && chars < maxChars - 1) {
      const result = await read(sessionId, input.documentId, current, signal, version)
      pagesScanned.push(current)
      if (!result.text.trim()) noTextPages.push(current)
      if (offset > result.text.length) fail('pdf/invalid-window', 'Context offset is outside the page')
      if (result.text.length > offset) {
        let limit = Math.min(8000, maxChars - chars)
        let accepted: { window: ReturnType<typeof textWindow>; evidence: PdfTextEvidence; nextBytes: number } | undefined
        while (limit >= 2) {
          const window = textWindow(result.text, offset, limit, 8000)
          const nextBytes = Buffer.byteLength(window.text, 'utf8')
          if (bytes + nextBytes <= MAX_CONTEXT_BYTES) {
            const evidence = createEvidence(result.snapshot, current, result.text, offset, offset + window.text.length,
              result.content)
            const proposedOutputBytes = Buffer.byteLength(JSON.stringify({
              documentId: snapshot.id, path: snapshot.path, sourceDigest: digestOf(snapshot.bytes),
              sourceVersion: snapshot.sourceVersion, contentVersion: snapshot.contentVersion,
              revision: snapshot.revision, chunks: [...chunks, { page: current, evidence }], candidates: [], revalidatedReference,
              coverage: { pagesScanned, noTextPages, actualChars: chars + window.text.length,
                actualBytes: bytes + nextBytes, truncated: true, nextCursor: 'x'.repeat(4096) },
            }), 'utf8')
            if (proposedOutputBytes <= MAX_CONTEXT_OUTPUT_BYTES) {
              accepted = { window, evidence, nextBytes }
              break
            }
          }
          if (limit === 2) break
          limit = Math.max(2, Math.floor(limit / 2))
        }
        if (!accepted) {
          if (!chunks.length) fail('pdf/output-too-large', 'A single evidence chunk exceeds the PDF output limit')
          break
        }
        await references.put(accepted.evidence.refId, { sessionId, evidence: accepted.evidence,
          pageTextDigest: hash(result.text), createdAt: Date.now() })
        chunks.push({ page: current, evidence: accepted.evidence })
        chars += accepted.window.text.length; bytes += accepted.nextBytes
        if (accepted.window.nextOffset !== null) {
          nextCursor = encodeCursor({ ...identity, page: current, offset: accepted.window.nextOffset }); break
        }
      }
      current++; offset = 0
    }
    if (!nextCursor && current <= snapshot.document.pageCount) {
      nextCursor = encodeCursor({ ...identity, page: current, offset })
    }
    return { status: nextCursor ? 'partial' as const : chunks.length ? 'ok' as const : 'no_text' as const,
      documentId: snapshot.id, path: snapshot.path, sourceDigest: digestOf(snapshot.bytes),
      sourceVersion: snapshot.sourceVersion, contentVersion: snapshot.contentVersion, revision: snapshot.revision,
      chunks, candidates: [], revalidatedReference,
      limitations: ['References remain session-scoped and require fresh file authorization and page-text validation.'],
      coverage: { pagesScanned, noTextPages, actualChars: chars, actualBytes: bytes,
        truncated: nextCursor !== null, nextCursor } }
  }

  return { status, locate, context, reference,
    forgetSession(sessionId: string) { return references.deleteSession(sessionId) },
    dispose() { references.clear?.() } }
}
