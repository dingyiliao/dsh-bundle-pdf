import { randomUUID } from 'node:crypto'
import type { PdfRect } from '../../core/pdf-types.js'
import type { NativeTextContent } from '../../shared/native.js'
import { joinPositionedText } from '../../shared/page-text.js'
import type { HostWorkspaceSnapshot, WorkingCopyReadPort } from '../working-copy/index.js'
import { approximateTextRects } from './geometry.js'
import { evidenceSha256 } from './provenance.js'
import type { EvidenceReferenceStore, PdfTextEvidence } from './reference-store.js'
import { assertFreshSource, type FreshSourceRead } from './source-freshness.js'

export interface SelectionFragment {
  page: number
  rect: PdfRect
  quadPoints: readonly number[]
}

export interface SelectionTextReader {
  readPageText(sessionId: string, documentId: string, page: number, signal: AbortSignal): Promise<{
    snapshot: HostWorkspaceSnapshot
    content: NativeTextContent
  }>
}

export interface SelectionEvidenceRequest {
  sessionId: string
  documentId: string
  expectedRevision: number
  expectedContentVersion: string
  quote: string
  fragments: readonly SelectionFragment[]
}

function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }

function sameSource(left: HostWorkspaceSnapshot, right: HostWorkspaceSnapshot): boolean {
  return left.id === right.id && left.path === right.path && left.sourceVersion === right.sourceVersion
    && left.contentVersion === right.contentVersion && left.revision === right.revision
    && evidenceSha256(left.bytes) === evidenceSha256(right.bytes)
}

function checkGeometry(fragment: SelectionFragment, crop: PdfRect): PdfRect[] {
  const [left, bottom, right, top] = fragment.rect
  if (![left, bottom, right, top].every(Number.isFinite) || right <= left || top <= bottom
    || left < crop[0] - 2 || right > crop[2] + 2 || bottom < crop[1] - 2 || top > crop[3] + 2
    || fragment.quadPoints.length < 8 || fragment.quadPoints.length > 8 * 128
    || fragment.quadPoints.length % 8 !== 0) fail('pdf/invalid-selection', 'Invalid PDF text selection geometry')
  const boxes: PdfRect[] = []
  for (let index = 0; index < fragment.quadPoints.length; index += 8) {
    const points = fragment.quadPoints.slice(index, index + 8)
    if (points.some(value => !Number.isFinite(value))) fail('pdf/invalid-selection', 'Invalid PDF selection quad')
    const xs = [points[0]!, points[2]!, points[4]!, points[6]!]
    const ys = [points[1]!, points[3]!, points[5]!, points[7]!]
    const box: PdfRect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
    if (box[2] <= box[0] || box[3] <= box[1]
      || box[0] < crop[0] - 2 || box[2] > crop[2] + 2
      || box[1] < crop[1] - 2 || box[3] > crop[3] + 2
      || box[0] < left - 2 || box[1] < bottom - 2 || box[2] > right + 2 || box[3] > top + 2) {
      fail('pdf/invalid-selection', 'PDF text selection quad is outside its page or bounding rectangle')
    }
    boxes.push(box)
  }
  return boxes
}

function selectedGlyphText(content: NativeTextContent, fragment: SelectionFragment, crop: PdfRect) {
  const boxes = checkGeometry(fragment, crop)
  const starts: number[] = []
  const pageText = joinPositionedText(content.items, starts)
  const selected: { start: number; end: number }[] = []
  for (const [index, item] of content.items.entries()) {
    if (!item.str) continue
    const scalars = Array.from(item.str)
    if (item.glyphs?.length !== scalars.length || item.transform.length < 4
      || !Number.isFinite(item.height) || item.height <= 0) {
      fail('pdf/selection-unverifiable', 'This PDF page does not expose verifiable glyph positions')
    }
    const [a, b, c, d] = item.transform
    const baseline = Math.hypot(a!, b!), vertical = Math.hypot(c!, d!)
    if (!Number.isFinite(baseline) || baseline <= 0 || !Number.isFinite(vertical) || vertical <= 0) {
      fail('pdf/selection-unverifiable', 'This PDF page has unusable glyph axes')
    }
    const ux = a! / baseline, uy = b! / baseline, vx = c! / vertical, vy = d! / vertical
    let offset = starts[index]!
    for (const [glyphIndex, scalar] of scalars.entries()) {
      const end = offset + scalar.length
      const [x, y, advance] = item.glyphs[glyphIndex]!
      if (![x, y, advance].every(Number.isFinite) || advance <= 0) {
        fail('pdf/selection-unverifiable', 'This PDF page has unusable glyph positions')
      }
      // The point is within the glyph's approximate painted area, not merely
      // the text run. Browser text spans and native glyphs share these origins.
      const cx = x + ux * advance / 2 + vx * item.height * 0.3
      const cy = y + uy * advance / 2 + vy * item.height * 0.3
      const inside = boxes.some(box => cx >= box[0] - 1 && cx <= box[2] + 1
        && cy >= box[1] - 1 && cy <= box[3] + 1)
      if (inside && !/^\s+$/u.test(scalar)) selected.push({ start: offset, end })
      offset = end
    }
  }
  if (!selected.length) fail('pdf/selection-unverifiable', 'No PDF text lies inside the selected geometry')
  const startUtf16 = selected[0]!.start, endUtf16 = selected[selected.length - 1]!.end
  if (endUtf16 - startUtf16 > 8000) fail('pdf/selection-too-large', 'Selected PDF text exceeds the evidence limit')
  // A selection is one contiguous text range. A boxed-in second column or an
  // unrelated run would otherwise let Client-supplied geometry certify it.
  let cursor = startUtf16
  for (const glyph of selected) {
    if (pageText.slice(cursor, glyph.start).replace(/\s/gu, '') !== '') {
      fail('pdf/selection-unverifiable', 'PDF selection skips text between selected glyphs')
    }
    cursor = glyph.end
  }
  return { text: pageText.slice(startUtf16, endUtf16), pageText, startUtf16, endUtf16 }
}

function comparable(text: string): string { return text.replace(/\s/gu, '') }

/** Re-extract a bounded Client selection from the same authorized Host working copy. */
export async function prepareTextSelectionEvidence(workspaces: WorkingCopyReadPort, reader: SelectionTextReader,
  references: EvidenceReferenceStore, input: SelectionEvidenceRequest, signal: AbortSignal,
  readSource: FreshSourceRead) {
  signal.throwIfAborted()
  const initial = workspaces.readSnapshot(input.sessionId, input.documentId)
  if (initial.revision !== input.expectedRevision || initial.contentVersion !== input.expectedContentVersion) {
    fail('pdf/stale-reader', 'PDF changed before text selection was verified')
  }
  await assertFreshSource(input.sessionId, initial, readSource, signal)
  if (!input.fragments.length || input.fragments.length > 10 || input.quote.length > 12_000
    || !input.quote.trim()) fail('pdf/invalid-selection', 'PDF selection is empty or too large')
  const prepared: { page: number; text: string; pageText: string; startUtf16: number; endUtf16: number;
    content: NativeTextContent }[] = []
  let previous = 0
  for (const fragment of input.fragments) {
    signal.throwIfAborted()
    if (!Number.isSafeInteger(fragment.page) || fragment.page <= previous
      || fragment.page > initial.document.pageCount) fail('pdf/invalid-selection', 'PDF selection pages must be ordered')
    previous = fragment.page
    const page = initial.document.pages[fragment.page - 1]
    if (!page) fail('pdf/invalid-page', 'PDF page has no verified geometry')
    const read = await reader.readPageText(input.sessionId, input.documentId, fragment.page, signal)
    signal.throwIfAborted()
    if (!sameSource(initial, read.snapshot)
      || !sameSource(initial, workspaces.readSnapshot(input.sessionId, input.documentId))) {
      fail('pdf/stale-reader', 'PDF changed while text selection was verified')
    }
    prepared.push({ page: fragment.page,
      ...selectedGlyphText(read.content, fragment, page.cropBox), content: read.content })
  }
  const canonicalText = prepared.map(item => item.text).join('\n')
  if (canonicalText.length > 8000) fail('pdf/selection-too-large', 'Selected PDF text exceeds the evidence limit')
  if (comparable(input.quote) !== comparable(canonicalText)) {
    fail('pdf/selection-mismatch', 'Selected words do not match the Host PDF text at these coordinates')
  }
  const sourceDigest = evidenceSha256(initial.bytes)
  const evidence: PdfTextEvidence[] = []
  try {
    for (const item of prepared) {
      signal.throwIfAborted()
      const rects = approximateTextRects(item.content, initial.document.pages[item.page - 1],
        item.startUtf16, item.endUtf16)
      const excerpt: PdfTextEvidence = { refId: `pdfref_${randomUUID()}`, documentId: initial.id,
        sourcePath: initial.path, sourceDigest, sourceVersion: initial.sourceVersion,
        contentVersion: initial.contentVersion, revision: initial.revision, page: item.page,
        source: 'pdf-text', pageTextDigest: evidenceSha256(item.pageText),
        snapshot: { text: item.text, sha256: evidenceSha256(item.text) },
        locator: { kind: 'text-window', startUtf16: item.startUtf16, endUtf16: item.endUtf16,
          ...(rects ? { rectsPdf: rects } : {}) },
        precision: rects ? 'approximate-geometry' : 'exact-text',
        limitations: ['Host PDFium glyph positions approximate the selected painted area; whitespace is canonicalized from the PDF text stream.'],
      }
      await references.put(excerpt.refId, { sessionId: input.sessionId, evidence: excerpt,
        pageTextDigest: evidenceSha256(item.pageText), createdAt: Date.now() })
      evidence.push(excerpt)
    }
    signal.throwIfAborted()
    if (!sameSource(initial, workspaces.readSnapshot(input.sessionId, input.documentId))) {
      fail('pdf/stale-reader', 'PDF changed while text selection evidence was recorded')
    }
    await assertFreshSource(input.sessionId, initial, readSource, signal)
  } catch (error) {
    await Promise.allSettled(evidence.map(item => references.delete(item.refId)))
    throw error
  }
  return { text: canonicalText, documentId: initial.id, sourcePath: initial.path, sourceDigest,
    sourceVersion: initial.sourceVersion, contentVersion: initial.contentVersion, revision: initial.revision,
    excerpts: evidence.map(item => ({ page: item.page, text: item.snapshot.text, refId: item.refId,
      startUtf16: item.locator.startUtf16, endUtf16: item.locator.endUtf16 })) }
}
