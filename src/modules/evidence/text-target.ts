import type { PdfRect } from '../../core/pdf-types.js'
import { locateTextOffsetRange } from '../../shared/geometry/text-target.js'
import { joinPageText } from '../../shared/page-text.js'
import type { HostWorkspaceSnapshot, WorkingCopyReadPort } from '../working-copy/index.js'
import type { AgentPageReadPort } from './agent-page-read.js'
import { evidenceSha256 } from './provenance.js'
import { savedTextReferenceSchema, type EvidenceReferenceStore } from './reference-store.js'
import { assertFreshSource, type FreshSourceRead } from './source-freshness.js'

/** Reusable, current native geometry; stored approximate boxes never authorize a mark or jump. */
export interface ResolvedTextReference {
  documentId: string
  contentVersion: string
  revision: number
  sourceVersion: string
  sourceDigest: string
  pageTextDigest: string
  page: number
  refId: string
  startUtf16: number
  endUtf16: number
  rectPdf: PdfRect
  quadPoints: number[]
  textSha256: string
  text: string
}

export interface TextReferenceResolverPort {
  resolve(sessionId: string, documentId: string, refId: string, signal: AbortSignal,
    readSource?: FreshSourceRead, quote?: string): Promise<ResolvedTextReference>
}

function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }

function identity(snapshot: HostWorkspaceSnapshot) {
  return { id: snapshot.id, path: snapshot.path, revision: snapshot.revision,
    contentVersion: snapshot.contentVersion, sourceVersion: snapshot.sourceVersion,
    sourceDigest: evidenceSha256(snapshot.bytes) }
}

function splitsScalar(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1), after = text.charCodeAt(offset)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}

/** A subquote is scoped to the attested occurrence, never searched across the page. */
function quotedRange(text: string, start: number, end: number, quote?: string): [number, number] {
  if (quote === undefined) return [start, end]
  if (!quote.trim()) fail('pdf/invalid-text-range', 'A reference subquote must contain text')
  const excerpt = text.slice(start, end), offset = excerpt.indexOf(quote)
  if (offset < 0) {
    fail('pdf/text-not-found', 'The exact quote is outside this reference; copy a passage from its snapshot or locate another reference')
  }
  if (excerpt.indexOf(quote, offset + 1) >= 0) {
    fail('pdf/ambiguous-text-target', 'The quote occurs more than once inside this reference; provide a longer unique quote')
  }
  return [start + offset, start + offset + quote.length]
}

/** A ref is evidence, not a file-access grant. Reauthorize the live document and all text before use. */
export function createTextReferenceResolver(workspaces: WorkingCopyReadPort, pages: AgentPageReadPort,
  references: EvidenceReferenceStore): TextReferenceResolverPort {
  return {
    async resolve(sessionId, documentId, refId, signal, readSource, quote) {
      signal.throwIfAborted()
      const parsed = savedTextReferenceSchema.safeParse(references.get(refId))
      if (!parsed.success || parsed.data.sessionId !== sessionId || parsed.data.evidence.refId !== refId) {
        fail('pdf/reference-unavailable', 'PDF text reference is unavailable in this session')
      }
      const saved = parsed.data, evidence = saved.evidence
      const before = workspaces.readSnapshot(sessionId, documentId)
      const initial = identity(before)
      const assertCurrent = (candidate: HostWorkspaceSnapshot) => {
        if (candidate.conflict || JSON.stringify(identity(candidate)) !== JSON.stringify(initial)) {
          fail('pdf/stale-reader', 'PDF changed while resolving the text reference; locate it again')
        }
      }
      if (before.path !== evidence.sourcePath) {
        fail('pdf/reference-unavailable', 'PDF text reference belongs to a different source path')
      }
      if (before.conflict || evidence.page > before.document.pageCount) {
        fail('pdf/stale-reader', 'The referenced PDF source or page is no longer current')
      }
      if (evidence.extraction) {
        fail('pdf/text-geometry-unavailable', 'OCR-derived evidence cannot certify native text geometry')
      }
      const { startUtf16, endUtf16 } = evidence.locator
      if (!evidence.snapshot.text.trim() || endUtf16 - startUtf16 !== evidence.snapshot.text.length
        || evidenceSha256(evidence.snapshot.text) !== evidence.snapshot.sha256
        || evidence.pageTextDigest !== undefined && evidence.pageTextDigest !== saved.pageTextDigest) {
        fail('pdf/invalid-evidence', 'The stored text reference has inconsistent text, range or digest')
      }
      if (readSource) await assertFreshSource(sessionId, before, readSource, signal)
      signal.throwIfAborted()
      assertCurrent(workspaces.readSnapshot(sessionId, documentId))
      const read = await pages.readPageText(sessionId, documentId, evidence.page, signal)
      signal.throwIfAborted()
      assertCurrent(read.snapshot)
      assertCurrent(workspaces.readSnapshot(sessionId, documentId))
      const text = joinPageText(read.content.items)
      if (evidenceSha256(text) !== saved.pageTextDigest
        || text.slice(startUtf16, endUtf16) !== evidence.snapshot.text) {
        fail('pdf/stale-reader', 'Referenced page text changed; locate the quote again')
      }
      if (endUtf16 > text.length || splitsScalar(text, startUtf16) || splitsScalar(text, endUtf16)) {
        fail('pdf/invalid-text-range', 'The stored reference range must span whole Unicode characters inside the page')
      }
      const [start, end] = quotedRange(text, startUtf16, endUtf16, quote)
      // Validate geometry only for the requested passage. A broad context window
      // can cross columns even when its selected subquote is unambiguous.
      const geometry = locateTextOffsetRange(read.content, start, end)
      const bounds = before.document.pages[evidence.page - 1]?.cropBox
      if (!bounds || geometry.rect[0] < bounds[0] || geometry.rect[1] < bounds[1]
        || geometry.rect[2] > bounds[2] || geometry.rect[3] > bounds[3]) {
        fail('pdf/text-geometry-unavailable', 'Referenced native text geometry lies outside its PDF page')
      }
      // A later revision or annotation-only save is acceptable only after the
      // whole original page text and exact stored offsets have been reverified.
      if (readSource) await assertFreshSource(sessionId, before, readSource, signal)
      signal.throwIfAborted()
      assertCurrent(workspaces.readSnapshot(sessionId, documentId))
      return { documentId, contentVersion: initial.contentVersion, revision: initial.revision,
        sourceVersion: initial.sourceVersion, sourceDigest: initial.sourceDigest,
        pageTextDigest: saved.pageTextDigest, page: evidence.page, refId, startUtf16: start, endUtf16: end,
        rectPdf: geometry.rect, quadPoints: geometry.quadPoints,
        textSha256: evidenceSha256(geometry.text), text: geometry.text }
    },
  }
}
