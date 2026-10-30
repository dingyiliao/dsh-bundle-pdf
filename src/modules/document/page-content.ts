import { createHash } from 'node:crypto'
import { z } from 'zod'

export const PAGE_CONTENT_VERSION = 1
export const NATIVE_PAGE_CONTENT_EXTRACTION_VERSION = 'joined-page-text-v2-native-quality'
export const MAX_PAGE_CONTENT_TEXT = 500_000
export const MAX_PAGE_CONTENT_SPANS = 10_000
const MAX_PAGE_REPRESENTATIONS = 128
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const identity = z.string().min(1).max(512)
const warnings = z.array(z.string().max(500)).max(20)
const offset = z.number().int().nonnegative().max(MAX_PAGE_CONTENT_TEXT)

/** All content coordinates use unrotated PDF user space. Missing geometry stays absent. */
export const pageContentRectSchema = z.tuple([
  z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite(),
]).refine(rect => rect[2] > rect[0] && rect[3] > rect[1], 'Empty or reversed PDF rectangle')

const rangeSchema = z.object({ startUtf16: offset, endUtf16: offset }).strict()
  .refine(range => range.endUtf16 >= range.startUtf16, 'Reversed native text range')
const spanSchema = z.object({ startUtf16: offset, endUtf16: offset, rectPdf: pageContentRectSchema }).strict()
  .refine(span => span.endUtf16 > span.startUtf16, 'Empty or reversed representation span')
const producerSchema = z.object({ id: identity, version: identity.optional(), model: identity.optional(),
  configurationIdentity: identity.optional() }).strict()

export const PageRepresentationSchema = z.object({
  id: z.string().regex(/^pdfrep_[a-f0-9]{64}$/),
  kind: z.enum(['native-text', 'ocr-text', 'image-description']),
  text: z.string().max(MAX_PAGE_CONTENT_TEXT), digest: sha256,
  producer: producerSchema,
  /** Digest of clean rendered input bytes, never a PNG/base64 payload or attachment handle. */
  inputDigest: sha256.optional(),
  spans: z.array(spanSchema).max(MAX_PAGE_CONTENT_SPANS).optional(),
  status: z.enum(['complete', 'partial']), warnings,
}).strict().superRefine((representation, ctx) => {
  if (pageContentDigest(representation.text) !== representation.digest) {
    ctx.addIssue({ code: 'custom', path: ['digest'], message: 'Representation text digest does not match' })
  }
  let previousEnd = 0
  for (const [index, span] of (representation.spans ?? []).entries()) {
    if (!validRange(representation.text, span.startUtf16, span.endUtf16)) {
      ctx.addIssue({ code: 'custom', path: ['spans', index], message: 'Span is outside whole Unicode characters in representation text' })
    }
    if (span.startUtf16 < previousEnd) {
      ctx.addIssue({ code: 'custom', path: ['spans', index], message: 'Representation spans must follow non-overlapping text order' })
    }
    previousEnd = span.endUtf16
  }
})
export type PageRepresentation = z.infer<typeof PageRepresentationSchema>
export type PageRepresentationProducer = z.infer<typeof producerSchema>

export const PageContentBlockSchema = z.object({
  id: z.string().regex(/^pdfblock_[a-f0-9]{64}$/),
  kind: z.enum(['text', 'visual-region', 'table', 'formula', 'unknown']),
  rectPdf: pageContentRectSchema.optional(), nativeRange: rangeSchema.optional(),
  representations: z.array(PageRepresentationSchema).max(32),
}).strict()
export type PageContentBlock = z.infer<typeof PageContentBlockSchema>

export const PageContentSchema = z.object({
  version: z.literal(PAGE_CONTENT_VERSION), sourceDigest: sha256,
  page: z.number().int().min(1).max(100_000), extractionIdentity: identity,
  pageRect: pageContentRectSchema,
  nativeText: z.object({ text: z.string().max(MAX_PAGE_CONTENT_TEXT), digest: sha256,
    paragraphBreaks: z.array(offset).max(MAX_PAGE_CONTENT_SPANS) }).strict(),
  blocks: z.array(PageContentBlockSchema).max(256), warnings,
  /** An optional enrichment failed; available representations remain usable, but coverage is incomplete. */
  failure: z.object({ code: z.string().min(1).max(100) }).strict().optional(),
}).strict().superRefine((page, ctx) => {
  const text = page.nativeText.text
  if (pageContentDigest(text) !== page.nativeText.digest) {
    ctx.addIssue({ code: 'custom', path: ['nativeText', 'digest'], message: 'Native text digest does not match' })
  }
  let previous = 0
  for (const [index, boundary] of page.nativeText.paragraphBreaks.entries()) {
    if (boundary <= previous || boundary >= text.length || splitsScalar(text, boundary)) {
      ctx.addIssue({ code: 'custom', path: ['nativeText', 'paragraphBreaks', index], message: 'Invalid native paragraph boundary' })
    }
    previous = boundary
  }
  const blockIds = new Set<string>(), representationIds = new Set<string>()
  let representationCount = 0, representationText = 0, spanCount = 0
  for (const [index, block] of page.blocks.entries()) {
    if (blockIds.has(block.id)) ctx.addIssue({ code: 'custom', path: ['blocks', index, 'id'], message: 'Duplicate block identity' })
    blockIds.add(block.id)
    if (block.nativeRange && !validRange(text, block.nativeRange.startUtf16, block.nativeRange.endUtf16)) {
      ctx.addIssue({ code: 'custom', path: ['blocks', index, 'nativeRange'], message: 'Native range is outside whole Unicode characters in native text' })
    }
    for (const [representationIndex, representation] of block.representations.entries()) {
      representationCount++; representationText += representation.text.length; spanCount += representation.spans?.length ?? 0
      if (representationIds.has(representation.id)) {
        ctx.addIssue({ code: 'custom', path: ['blocks', index, 'representations', representationIndex, 'id'], message: 'Duplicate representation identity' })
      }
      representationIds.add(representation.id)
      if (representation.kind === 'native-text' && (!block.nativeRange
        || representation.text !== text.slice(block.nativeRange.startUtf16, block.nativeRange.endUtf16))) {
        ctx.addIssue({ code: 'custom', path: ['blocks', index, 'representations', representationIndex], message: 'Native representation must match its native text range' })
      }
    }
  }
  if (representationCount > MAX_PAGE_REPRESENTATIONS || representationText > MAX_PAGE_CONTENT_TEXT || spanCount > MAX_PAGE_CONTENT_SPANS) {
    ctx.addIssue({ code: 'custom', path: ['blocks'], message: 'Page representation budget exceeded' })
  }
})
export type PageContent = z.infer<typeof PageContentSchema>
export type PageContentIdentity = Pick<PageContent, 'sourceDigest' | 'page' | 'extractionIdentity'>

function splitsScalar(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1), after = text.charCodeAt(offset)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}
function validRange(text: string, start: number, end: number): boolean {
  return start <= end && end <= text.length && !splitsScalar(text, start) && !splitsScalar(text, end)
}

/** A content digest is independent of document session, evidence and embedding identity. */
export function pageContentDigest(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

/** A caller-owned structural key may name a future detected table/figure, without pretending it is evidence. */
export function pageContentBlockId(page: PageContentIdentity, structuralKey: string): string {
  return `pdfblock_${pageContentDigest(JSON.stringify([PAGE_CONTENT_VERSION, page.sourceDigest,
    page.page, page.extractionIdentity, structuralKey])).slice(7)}`
}

type RepresentationInput = Omit<PageRepresentation, 'id' | 'digest'>
/** Provenance and input pixels participate in identity even when two engines emit identical text. */
export function pageRepresentationId(input: RepresentationInput): string {
  return `pdfrep_${pageContentDigest(JSON.stringify([input.kind, pageContentDigest(input.text), input.producer.id,
    input.producer.version ?? null, input.producer.model ?? null, input.producer.configurationIdentity ?? null,
    input.inputDigest ?? null, input.spans ?? null, input.status, input.warnings])).slice(7)}`
}

export function createPageRepresentation(input: RepresentationInput): PageRepresentation {
  return PageRepresentationSchema.parse({ ...input, id: pageRepresentationId(input), digest: pageContentDigest(input.text) })
}

/** Immutable upsert. Every new snapshot crosses the same boundary as a persisted cache record. */
export function appendPageRepresentation(page: PageContent, blockId: string, representation: PageRepresentation): PageContent {
  if (!page.blocks.some(block => block.id === blockId)) throw new Error('Page content block does not exist')
  return PageContentSchema.parse({ ...page, blocks: page.blocks.map(block => block.id !== blockId ? block : {
    ...block, representations: [...block.representations.filter(item => item.id !== representation.id), representation],
  }) })
}

/** Derived cache records are disposable; invalid data is a cache miss. */
export function parsePageContent(value: unknown): PageContent | undefined {
  const result = PageContentSchema.safeParse(value)
  return result.success ? result.data : undefined
}
