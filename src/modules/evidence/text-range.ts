import { randomUUID } from 'node:crypto'
import { locateTextRange } from '../../shared/geometry/text-target.js'
import { joinPageText } from '../../shared/page-text.js'
import type { HostWorkspaceSnapshot, WorkingCopyReadPort } from '../working-copy/index.js'
import type { AgentPageReadPort } from './agent-page-read.js'
import { evidenceSha256 } from './provenance.js'
import { savedTextReferenceSchema, savedTextRangeReferenceSchema,
  type EvidenceReferenceStore, type PdfTextEvidence } from './reference-store.js'
import { createTextEvidence } from './text-evidence.js'
import { assertFreshSource, type FreshSourceRead } from './source-freshness.js'

export interface TextRangeInput { start: { page: number; quote: string }; end: { page: number; quote: string } }
export interface ReadTextEvidence { refId: string; documentId: string; revision: number; contentVersion: string;
  pages: PdfTextEvidence[]; revalidated: boolean }

function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }
function assertRangeBudget(pageCount: number, chars: number): void {
  if (pageCount < 1 || pageCount > 10 || chars > 8000) {
    fail('pdf/text-range-too-large', 'A text reference must contain at most ten pages and 8000 characters')
  }
}
function identity(snapshot: HostWorkspaceSnapshot) {
  return { documentId: snapshot.id, sourcePath: snapshot.path, sourceVersion: snapshot.sourceVersion,
    contentVersion: snapshot.contentVersion, revision: snapshot.revision, sourceDigest: evidenceSha256(snapshot.bytes) }
}
function same(left: ReturnType<typeof identity>, right: ReturnType<typeof identity>): boolean {
  return left.documentId === right.documentId && left.sourcePath === right.sourcePath
    && left.sourceDigest === right.sourceDigest && left.sourceVersion === right.sourceVersion
    && left.contentVersion === right.contentVersion && left.revision === right.revision
}
function splitsScalar(text: string, offset: number): boolean {
  return text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff
    && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff
}

/** Pure evidence primitives: read existing evidence or resolve a specifically bounded passage. */
export function createTextRangeReferences(workspaces: WorkingCopyReadPort, pages: AgentPageReadPort,
  references: EvidenceReferenceStore) {
  async function check(sessionId: string, initial: HostWorkspaceSnapshot, signal: AbortSignal,
    readSource?: FreshSourceRead) {
    signal.throwIfAborted()
    const current = workspaces.readSnapshot(sessionId, initial.id)
    if (current.conflict || !same(identity(initial), identity(current))) {
      fail('pdf/stale-reader', 'PDF changed while reading text evidence; retry from the current version')
    }
    if (readSource) await assertFreshSource(sessionId, current, readSource, signal)
    signal.throwIfAborted()
    const after = workspaces.readSnapshot(sessionId, initial.id)
    if (after.conflict || !same(identity(initial), identity(after))) {
      fail('pdf/stale-reader', 'PDF changed while checking text evidence')
    }
  }

  async function publish(sessionId: string, initial: HostWorkspaceSnapshot, evidence: PdfTextEvidence[],
    signal: AbortSignal, readSource?: FreshSourceRead): Promise<ReadTextEvidence> {
    const total = evidence.reduce((count, page) => count + page.snapshot.text.length, evidence.length - 1)
    assertRangeBudget(evidence.length, total)
    await check(sessionId, initial, signal, readSource)
    const refId = evidence.length === 1 ? evidence[0]!.refId : `pdfref_${randomUUID()}`
    // A storage adapter may persist a value and then reject while flushing or
    // evicting another record. Register every candidate before awaiting writes.
    const candidates = new Set([...evidence.map(page => page.refId), refId])
    try {
      for (const page of evidence) {
        signal.throwIfAborted()
        await references.put(page.refId, { sessionId, evidence: page, pageTextDigest: page.pageTextDigest!, createdAt: Date.now() })
      }
      signal.throwIfAborted()
      if (evidence.length > 1) {
        await references.put(refId, { sessionId, createdAt: Date.now(), evidence: {
          ...identity(initial), refId, source: 'pdf-text-range',
          pages: evidence.map(page => ({ evidence: page, pageTextDigest: page.pageTextDigest! })),
        } })
      }
      await check(sessionId, initial, signal, readSource)
      return { refId, documentId: initial.id, revision: initial.revision, contentVersion: initial.contentVersion,
        pages: evidence, revalidated: false }
    } catch (error) {
      // Attempt every rollback even if one delete fails; never replace the
      // original write failure or AbortError with a cleanup rejection.
      await Promise.allSettled([...candidates].map(refId => references.delete(refId)))
      throw error
    }
  }

  function savedPages(sessionId: string, refId: string) {
    const raw = references.get(refId)
    const single = savedTextReferenceSchema.safeParse(raw)
    if (single.success && single.data.sessionId === sessionId && single.data.evidence.refId === refId) {
      return { identity: single.data.evidence,
        pages: [{ evidence: single.data.evidence, pageTextDigest: single.data.pageTextDigest }] }
    }
    const range = savedTextRangeReferenceSchema.safeParse(raw)
    if (!range.success || range.data.sessionId !== sessionId || range.data.evidence.refId !== refId) {
      fail('pdf/reference-unavailable', 'PDF text evidence is unavailable in this session')
    }
    const { evidence } = range.data
    if (evidence.pages.reduce((count, page) => count + page.evidence.snapshot.text.length, evidence.pages.length - 1) > 8000
      || evidence.pages.some((entry, index) => {
        const child = entry.evidence
        return child.sourcePath !== evidence.sourcePath || child.documentId !== evidence.documentId
          || child.sourceDigest !== evidence.sourceDigest || child.revision !== evidence.revision
          || child.sourceVersion !== evidence.sourceVersion || child.contentVersion !== evidence.contentVersion
          || index > 0 && child.page !== evidence.pages[index - 1]!.evidence.page + 1
      })) fail('pdf/invalid-evidence', 'Stored text range has inconsistent pages or identity')
    return { identity: evidence, pages: evidence.pages }
  }

  async function readEvidence(sessionId: string, documentId: string, refId: string, signal: AbortSignal,
    readSource?: FreshSourceRead): Promise<ReadTextEvidence> {
    const saved = savedPages(sessionId, refId)
    const initial = workspaces.readSnapshot(sessionId, documentId)
    if (saved.identity.sourcePath !== initial.path) fail('pdf/reference-unavailable', 'Text evidence belongs to another source path')
    await check(sessionId, initial, signal, readSource)
    const rebound: PdfTextEvidence[] = []
    for (const { evidence, pageTextDigest } of saved.pages) {
      if (evidence.page > initial.document.pageCount) fail('pdf/stale-reader', 'Referenced page no longer exists')
      const read = await pages.readPageText(sessionId, documentId, evidence.page, signal)
      await check(sessionId, initial, signal)
      if (!same(identity(initial), identity(read.snapshot))) fail('pdf/stale-reader', 'Page text came from another PDF version')
      const text = joinPageText(read.content.items)
      const { startUtf16, endUtf16 } = evidence.locator
      if (!evidence.snapshot.text.trim() || endUtf16 - startUtf16 !== evidence.snapshot.text.length
        || evidenceSha256(evidence.snapshot.text) !== evidence.snapshot.sha256
        || evidenceSha256(text) !== pageTextDigest || text.slice(startUtf16, endUtf16) !== evidence.snapshot.text
        || evidence.pageTextDigest !== undefined && evidence.pageTextDigest !== pageTextDigest) {
        fail('pdf/stale-reader', 'Referenced page text or exact range changed; locate it again')
      }
      if (splitsScalar(text, startUtf16) || splitsScalar(text, endUtf16)) {
        fail('pdf/invalid-text-range', 'A text reference must span whole Unicode characters')
      }
      rebound.push(createTextEvidence(initial, evidence.page, text, startUtf16, endUtf16, read.content))
    }
    await check(sessionId, initial, signal, readSource)
    if (same(identity(initial), saved.identity)) {
      return { refId, documentId, revision: initial.revision, contentVersion: initial.contentVersion,
        pages: saved.pages.map(entry => entry.evidence), revalidated: false }
    }
    return { ...await publish(sessionId, initial, rebound, signal, readSource), revalidated: true }
  }

  async function capture(sessionId: string, documentId: string, range: TextRangeInput, signal: AbortSignal,
    readSource?: FreshSourceRead): Promise<ReadTextEvidence> {
    const initial = workspaces.readSnapshot(sessionId, documentId)
    const { start, end } = range
    if (!Number.isSafeInteger(start.page) || !Number.isSafeInteger(end.page)
      || start.page < 1 || end.page < start.page || end.page > initial.document.pageCount || end.page - start.page >= 10
      || !start.quote.trim() || !end.quote.trim()) fail('pdf/invalid-text-range', 'Use ordered exact text anchors spanning at most ten pages')
    await check(sessionId, initial, signal, readSource)
    const evidence: PdfTextEvidence[] = []
    let totalChars = 0
    for (let page = start.page; page <= end.page; page++) {
      const read = await pages.readPageText(sessionId, documentId, page, signal)
      await check(sessionId, initial, signal)
      if (!same(identity(initial), identity(read.snapshot))) fail('pdf/stale-reader', 'PDF changed while resolving a continuous range')
      const geometry = locateTextRange(read.content, page === start.page ? start.quote : undefined,
        page === end.page ? end.quote : undefined, true)
      totalChars += geometry.text.length + (evidence.length ? 1 : 0)
      assertRangeBudget(evidence.length + 1, totalChars)
      evidence.push(createTextEvidence(initial, page, joinPageText(read.content.items),
        geometry.startUtf16, geometry.endUtf16, read.content))
    }
    return publish(sessionId, initial, evidence, signal, readSource)
  }

  async function derive(sessionId: string, documentId: string, refId: string, quote: string, signal: AbortSignal,
    readSource?: FreshSourceRead): Promise<ReadTextEvidence> {
    if (!quote.trim()) fail('pdf/invalid-text-range', 'A subquote must contain text')
    const parent = await readEvidence(sessionId, documentId, refId, signal, readSource)
    const text = parent.pages.map(page => page.snapshot.text).join('\n')
    const offset = text.indexOf(quote)
    if (offset < 0) fail('pdf/text-not-found', 'The exact subquote is outside this reference')
    if (text.indexOf(quote, offset + 1) >= 0) fail('pdf/ambiguous-text-target', 'The subquote is not unique inside this reference')
    const initial = workspaces.readSnapshot(sessionId, documentId)
    if (!same(identity(initial), parent.pages[0]!)) fail('pdf/stale-reader', 'PDF changed after reading the parent reference')
    let cursor = 0
    const children: PdfTextEvidence[] = []
    for (const page of parent.pages) {
      const start = Math.max(0, offset - cursor)
      const end = Math.min(page.snapshot.text.length, offset + quote.length - cursor)
      if (start < end) {
        const read = await pages.readPageText(sessionId, documentId, page.page, signal)
        if (!same(identity(initial), identity(read.snapshot))) fail('pdf/stale-reader', 'PDF changed while narrowing evidence')
        const fullText = joinPageText(read.content.items)
        if (evidenceSha256(fullText) !== page.pageTextDigest) fail('pdf/stale-reader', 'Page text changed while narrowing evidence')
        const from = page.locator.startUtf16 + start, through = page.locator.startUtf16 + end
        if (splitsScalar(fullText, from) || splitsScalar(fullText, through)) {
          fail('pdf/invalid-text-range', 'A subquote must span whole Unicode characters')
        }
        children.push(createTextEvidence(initial, page.page, fullText, from, through, read.content))
      }
      cursor += page.snapshot.text.length + 1
    }
    return publish(sessionId, initial, children, signal, readSource)
  }

  return { capture, derive, readEvidence }
}
