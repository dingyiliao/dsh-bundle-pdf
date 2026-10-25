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
    readSource?: FreshSourceRead): Promise<ResolvedTextReference>
}

function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }

function identity(snapshot: HostWorkspaceSnapshot) {
  return { id: snapshot.id, path: snapshot.path, revision: snapshot.revision,
    contentVersion: snapshot.contentVersion, sourceVersion: snapshot.sourceVersion,
    sourceDigest: evidenceSha256(snapshot.bytes) }
}

/** A ref is evidence, not a file-access grant. Reauthorize the live document and all text before use. */
export function createTextReferenceResolver(workspaces: WorkingCopyReadPort, pages: AgentPageReadPort,
  references: EvidenceReferenceStore): TextReferenceResolverPort {
  return {
    async resolve(sessionId, documentId, refId, signal, readSource) {
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
      const geometry = locateTextOffsetRange(read.content, startUtf16, endUtf16)
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
        pageTextDigest: saved.pageTextDigest, page: evidence.page, refId, startUtf16, endUtf16,
        rectPdf: geometry.rect, quadPoints: geometry.quadPoints,
        textSha256: evidence.snapshot.sha256, text: geometry.text }
    },
  }
}
