import type { PdfRect } from '../../core/pdf-types.js'
import { locateTextOffsetRange } from '../../shared/geometry/text-target.js'
import { joinPageText } from '../../shared/page-text.js'
import type { HostWorkspaceSnapshot, WorkingCopyReadPort } from '../working-copy/index.js'
import { readEvidencePageText, type AgentPageReadPort } from './agent-page-read.js'
import { evidenceSha256 } from './provenance.js'
import { savedTextReferenceSchema, savedTextRangeReferenceSchema, type EvidenceReferenceStore } from './reference-store.js'
import { assertFreshSource, type FreshSourceRead } from './source-freshness.js'
import { matchEvidenceQuote, type QuoteMatchMode } from './quote-match.js'
import { createTextRangeReferences } from './text-range.js'
import { describeEvidenceCapabilities, type EvidenceCapabilities } from './capabilities.js'

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
    readSource?: FreshSourceRead, quote?: string, quoteMatch?: QuoteMatchMode): Promise<ResolvedTextReference>
  resolveRange(sessionId: string, documentId: string, refId: string, signal: AbortSignal,
    readSource?: FreshSourceRead): Promise<{ refId: string; pages: ResolvedTextReference[] }>
}

export interface ResolvedEvidencePage {
  documentId: string
  contentVersion: string
  revision: number
  sourceVersion: string
  sourceDigest: string
  page: number
  refId: string
  precision: 'page-only'
  locator: { kind: 'page-only' }
  capabilities: EvidenceCapabilities
  limitations: string[]
}

export interface EvidencePageResolverPort {
  resolvePage(sessionId: string, documentId: string, refId: string, signal: AbortSignal,
    readSource: FreshSourceRead): Promise<ResolvedEvidencePage>
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
function quotedRange(text: string, start: number, end: number, quote?: string,
  mode: QuoteMatchMode = 'exact', refId?: string): [number, number] {
  if (quote === undefined) return [start, end]
  const match = matchEvidenceQuote(text.slice(start, end), quote, mode, refId)
  return [start + match.startUtf16, start + match.endUtf16]
}

/** A ref is evidence, not a file-access grant. Reauthorize the live document and all text before use. */
export function createTextReferenceResolver(workspaces: WorkingCopyReadPort, pages: AgentPageReadPort,
  references: EvidenceReferenceStore): TextReferenceResolverPort & EvidencePageResolverPort {
  const resolver: TextReferenceResolverPort & EvidencePageResolverPort = {
    async resolvePage(sessionId, documentId, refId, signal, readSource) {
      if (!readSource) fail('pdf/source-unavailable', 'OCR page navigation requires a fresh-source adapter')
      // The read primitive reauthorizes the session and verifies every stored
      // page. OCR requires the attested source bytes, not just similar wording.
      const read = await createTextRangeReferences(workspaces, pages, references)
        .readEvidence(sessionId, documentId, refId, signal, readSource)
      const capabilities = read.pages.some(page => page.extraction)
        ? { ...describeEvidenceCapabilities(read.pages.find(page => page.extraction)!),
          source: read.pages.every(page => page.extraction) ? 'local-ocr' as const : 'mixed-text' as const }
        : describeEvidenceCapabilities(read.pages[0]!)
      if (capabilities.navigation !== 'page') {
        fail('pdf/invalid-evidence', 'Page-only text navigation requires derived OCR evidence')
      }
      signal.throwIfAborted()
      const current = workspaces.readSnapshot(sessionId, documentId), first = read.pages[0]!
      if (current.conflict || current.path !== first.sourcePath || current.contentVersion !== read.contentVersion
        || current.revision !== read.revision || current.sourceVersion !== first.sourceVersion
        || evidenceSha256(current.bytes) !== first.sourceDigest) {
        fail('pdf/stale-reader', 'PDF changed after checking the OCR reference; locate it again')
      }
      return { documentId, contentVersion: current.contentVersion, revision: current.revision,
        sourceVersion: current.sourceVersion, sourceDigest: first.sourceDigest,
        page: first.page, refId: read.refId, precision: 'page-only', locator: { kind: 'page-only' },
        capabilities, limitations: [capabilities.reason] }
    },
    async resolveRange(sessionId, documentId, refId, signal, readSource) {
      const raw = references.get(refId)
      const range = savedTextRangeReferenceSchema.safeParse(raw)
      if (!range.success) return { refId, pages: [await resolver.resolve(sessionId, documentId, refId, signal, readSource)] }
      if (range.data.sessionId !== sessionId || range.data.evidence.refId !== refId) {
        fail('pdf/reference-unavailable', 'PDF text range is unavailable in this session')
      }
      const saved = range.data.evidence
      const initial = workspaces.readSnapshot(sessionId, documentId)
      const initialIdentity = identity(initial)
      if (saved.sourcePath !== initial.path || saved.pages.reduce((n, p) => n + p.evidence.snapshot.text.length,
        saved.pages.length - 1) > 8000) fail('pdf/invalid-evidence', 'Stored text range has an invalid source or size')
      const resolved: ResolvedTextReference[] = []
      for (const [index, entry] of saved.pages.entries()) {
        if (entry.evidence.sourcePath !== saved.sourcePath || entry.evidence.documentId !== saved.documentId
          || entry.evidence.sourceDigest !== saved.sourceDigest || entry.evidence.contentVersion !== saved.contentVersion
          || entry.evidence.revision !== saved.revision || entry.evidence.sourceVersion !== saved.sourceVersion
          || index > 0 && entry.evidence.page !== saved.pages[index - 1]!.evidence.page + 1) {
          fail('pdf/invalid-evidence', 'Stored text range has inconsistent page identities')
        }
        // Embedded page records survive bounded eviction of standalone child refs.
        const embedded: EvidenceReferenceStore = { ...references,
          get(key) { return key === entry.evidence.refId
            ? { sessionId, ...entry, createdAt: range.data.createdAt } : references.get(key) } }
        resolved.push(await createTextReferenceResolver(workspaces, pages, embedded)
          .resolve(sessionId, documentId, entry.evidence.refId, signal, readSource))
        signal.throwIfAborted()
        if (JSON.stringify(identity(workspaces.readSnapshot(sessionId, documentId))) !== JSON.stringify(initialIdentity)) {
          fail('pdf/stale-reader', 'PDF changed while resolving the continuous text range')
        }
      }
      return { refId, pages: resolved }
    },
    async resolve(sessionId, documentId, refId, signal, readSource, quote, quoteMatch) {
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
      const read = await readEvidencePageText(pages, sessionId, documentId, evidence.page, signal)
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
      const [start, end] = quotedRange(text, startUtf16, endUtf16, quote, quoteMatch, refId)
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
  return resolver
}
