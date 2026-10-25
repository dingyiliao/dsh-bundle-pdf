import { randomUUID } from 'node:crypto'
import type { AgentPageReadPort } from '../evidence/index.js'
import { evidenceSha256, type FreshSourceRead, type TextReferenceResolverPort } from '../evidence/index.js'
import type { PdfAnnotationOperation, PdfColor, PdfRect } from '../../core/pdf-types.js'
import type { HostWorkspaceSnapshot } from '../working-copy/index.js'
import type { ModelAnnotationInput } from './index.js'
import { locateTextRange } from '../../shared/geometry/text-target.js'

type AddOperation = Extract<PdfAnnotationOperation, { type: 'add' }>
export type CoveredPage = { page: number; startUtf16: number; endUtf16: number; text: string; refId?: string }
export type AnnotationPlan = { operation: AddOperation; covered?: CoveredPage }

function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }

function assertPageRect(snapshot: HostWorkspaceSnapshot, page: number, rectPdf: PdfRect): void {
  const bounds = snapshot.document.pages[page - 1]?.cropBox
  if (!bounds) fail('pdf/invalid-page', 'Annotation page is outside this document')
  const [left, bottom, right, top] = rectPdf
  if (!(right > left && top > bottom) || left < bounds[0] || bottom < bounds[1]
    || right > bounds[2] || top > bounds[3]) {
    fail('pdf/invalid-region', 'Annotation rectangle must lie inside the PDF page crop box')
  }
}

function textGeometryPages(pages: AgentPageReadPort | undefined): AgentPageReadPort {
  if (!pages) fail('pdf/text-geometry-unavailable', 'The PDF text geometry reader is unavailable')
  return pages
}

async function singleAnnotation(snapshot: HostWorkspaceSnapshot, input: ModelAnnotationInput,
  sessionId: string, pages: AgentPageReadPort | undefined, signal: AbortSignal,
  references?: TextReferenceResolverPort, readSource?: FreshSourceRead): Promise<AnnotationPlan> {
  if (input.subtype === 'Text' && !input.comment?.trim()) fail('pdf/invalid-comment', 'A text note requires a non-empty comment')
  if (input.target.kind === 'reference') {
    if (input.subtype === 'Text') fail('pdf/invalid-target', 'A standalone note requires a PDF position, not a text reference')
    if (!references) fail('pdf/reference-unavailable', 'PDF text reference verification is unavailable')
    const resolved = await references.resolve(sessionId, snapshot.id, input.target.refId, signal, readSource)
    signal.throwIfAborted()
    if (resolved.documentId !== snapshot.id || resolved.revision !== snapshot.revision
      || resolved.contentVersion !== snapshot.contentVersion || resolved.sourceDigest !== evidenceSha256(snapshot.bytes)) {
      fail('pdf/stale-revision', 'The PDF changed while locating the referenced text; read its status again')
    }
    assertPageRect(snapshot, resolved.page, resolved.rectPdf)
    return { operation: { type: 'add', annotation: {
      id: `ai_${randomUUID()}`, page: resolved.page, subtype: input.subtype,
      rect: [...resolved.rectPdf] as PdfRect, quadPoints: [...resolved.quadPoints],
      ...(input.color ? { color: [...input.color] as PdfColor } : {}),
      ...(input.comment !== undefined ? { contents: input.comment } : {}), author: 'AI suggestion',
    } }, covered: { page: resolved.page, startUtf16: resolved.startUtf16, endUtf16: resolved.endUtf16,
      text: resolved.text, refId: resolved.refId } }
  }
  if (input.target.kind === 'pdf-text-range') fail('pdf/invalid-target', 'A text range must use the range annotation path')
  const { page } = input.target
  if (!snapshot.document.pages[page - 1]) fail('pdf/invalid-page', 'Annotation page is outside this document')
  if (input.target.kind === 'pdf-region' && input.subtype !== 'Text') {
    fail('pdf/unverified-region', 'Text markup requires an exact pdf-text quote; guessed rectangles are not safe annotation targets')
  }
  if (input.target.kind === 'pdf-text' && input.subtype === 'Text') {
    fail('pdf/invalid-target', 'A standalone text note requires a PDF position, not a quoted text span')
  }
  let rectPdf: PdfRect
  let quadPoints: number[] | undefined
  let covered: CoveredPage | undefined
  if (input.target.kind === 'pdf-text') {
    const read = await textGeometryPages(pages).readPageText(sessionId, snapshot.id, page, signal)
    if (read.snapshot.contentVersion !== snapshot.contentVersion || read.snapshot.revision !== snapshot.revision) {
      fail('pdf/stale-revision', 'The PDF changed while locating the quoted text; read its status again')
    }
    const geometry = locateTextRange(read.content, input.target.quote, input.target.quote, true)
    rectPdf = geometry.rect
    quadPoints = geometry.quadPoints
    covered = { page, startUtf16: geometry.startUtf16, endUtf16: geometry.endUtf16, text: geometry.text }
  } else rectPdf = input.target.rectPdf
  assertPageRect(snapshot, page, rectPdf)
  return { operation: { type: 'add', annotation: {
    id: `ai_${randomUUID()}`, page, subtype: input.subtype, rect: [...rectPdf] as PdfRect,
    ...(quadPoints ? { quadPoints } : {}),
    ...(input.color ? { color: [...input.color] as PdfColor } : {}),
    ...(input.comment !== undefined ? { contents: input.comment } : {}), author: 'AI suggestion',
  } }, ...(covered ? { covered } : {}) }
}

async function rangeAnnotations(snapshot: HostWorkspaceSnapshot, input: ModelAnnotationInput,
  sessionId: string, pages: AgentPageReadPort | undefined, signal: AbortSignal): Promise<AnnotationPlan[]> {
  if (input.target.kind !== 'pdf-text-range') fail('pdf/invalid-target', 'A text range target is required')
  if (input.subtype === 'Text') fail('pdf/invalid-target', 'A text range can only be highlighted, underlined or struck out')
  const { start, end } = input.target
  if (start.page > end.page || end.page - start.page >= 10) {
    fail('pdf/invalid-text-range', 'Text range pages must be ordered and span no more than ten pages')
  }
  if (end.page > snapshot.document.pageCount) fail('pdf/invalid-page', 'Annotation page is outside this document')
  const reader = textGeometryPages(pages)
  const plans: AnnotationPlan[] = []
  let totalChars = 0
  for (let page = start.page; page <= end.page; page++) {
    signal.throwIfAborted()
    const read = await reader.readPageText(sessionId, snapshot.id, page, signal)
    if (read.snapshot.contentVersion !== snapshot.contentVersion || read.snapshot.revision !== snapshot.revision) {
      fail('pdf/stale-revision', 'The PDF changed while locating the text range; read its status again')
    }
    const geometry = locateTextRange(read.content, page === start.page ? start.quote : undefined,
      page === end.page ? end.quote : undefined, true)
    totalChars += geometry.text.length
    if (totalChars > 8000) fail('pdf/text-range-too-large', 'Text range exceeds 8000 characters; mark it in smaller ranges')
    assertPageRect(snapshot, page, geometry.rect)
    plans.push({ operation: { type: 'add', annotation: {
      id: `ai_${randomUUID()}`, page, subtype: input.subtype, rect: geometry.rect,
      quadPoints: geometry.quadPoints,
      ...(input.color ? { color: [...input.color] as PdfColor } : {}),
      ...(page === start.page && input.comment !== undefined ? { contents: input.comment } : {}),
      author: 'AI suggestion',
    } }, covered: { page, startUtf16: geometry.startUtf16,
      endUtf16: geometry.endUtf16, text: geometry.text } })
  }
  return plans
}

/** Turn a model target into verified page operations before the working-copy transaction. */
export async function buildAnnotationPlans(snapshot: HostWorkspaceSnapshot, input: ModelAnnotationInput,
  sessionId: string, pages: AgentPageReadPort | undefined, signal: AbortSignal,
  references?: TextReferenceResolverPort, readSource?: FreshSourceRead): Promise<AnnotationPlan[]> {
  return input.target.kind === 'pdf-text-range'
    ? rangeAnnotations(snapshot, input, sessionId, pages, signal)
    : [await singleAnnotation(snapshot, input, sessionId, pages, signal, references, readSource)]
}
