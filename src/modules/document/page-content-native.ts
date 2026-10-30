import type { PdfRect } from '../../core/pdf-types.js'
import type { NativeTextContent } from '../../shared/native.js'
import { joinPositionedText } from '../../shared/page-text.js'
import { createPageRepresentation, MAX_PAGE_CONTENT_SPANS, PageContentSchema, pageContentBlockId,
  pageContentDigest, type PageContent, type PageContentIdentity, type PageRepresentation } from './page-content.js'
import { nativePageContentText } from './page-content-text.js'

type NativeItem = NativeTextContent['items'][number]
type Span = NonNullable<PageRepresentation['spans']>[number]

/** Native positions aid retrieval/localization; annotation tools must still re-attest current glyphs. */
function nativeRunRect(item: NativeItem, styles: NativeTextContent['styles']): PdfRect | undefined {
  const [a, b, c, d, x, y] = item.transform
  const axisLength = Math.hypot(a, b), verticalLength = Math.hypot(c, d)
  if (item.transform.length < 6 || ![a, b, c, d, x, y].every(Number.isFinite)
    || axisLength <= 0 || verticalLength <= 0 || /[\r\n]/u.test(item.str)) return
  let characters = 0
  for (const _character of item.str) characters++
  const glyphs = item.glyphs?.length === characters ? item.glyphs : item.glyphs === undefined && characters === 1
    && Number.isFinite(item.width) && item.width > 0 ? [[x, y, item.width]] : undefined
  if (!glyphs?.length || glyphs.some(glyph => glyph.length !== 3 || !glyph.every(Number.isFinite) || glyph[2] <= 0)) return
  const style = styles[item.fontName]
  if (!Number.isFinite(style?.ascent) || !Number.isFinite(style?.descent) || style.ascent <= style.descent) return
  const ux = a / axisLength, uy = b / axisLength, vx = c / verticalLength, vy = d / verticalLength
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const glyph of glyphs) {
    for (const advance of [0, glyph[2]]) for (const height of [style.descent, style.ascent]) {
      const gx = glyph[0] + ux * advance + vx * height * verticalLength
      const gy = glyph[1] + uy * advance + vy * height * verticalLength
      minX = Math.min(minX, gx); minY = Math.min(minY, gy); maxX = Math.max(maxX, gx); maxY = Math.max(maxY, gy)
    }
  }
  return [minX, minY, maxX, maxY].every(Number.isFinite) && maxX > minX && maxY > minY
    ? [minX, minY, maxX, maxY] : undefined
}

function nativeSpans(content: NativeTextContent, warnings: string[]): Span[] | undefined {
  const starts: number[] = []
  joinPositionedText(content.items, starts)
  const spans: Span[] = []
  for (const [index, item] of content.items.entries()) {
    if (!item.str.length) continue
    const rectPdf = nativeRunRect(item, content.styles)
    if (!rectPdf) continue
    if (spans.length === MAX_PAGE_CONTENT_SPANS) {
      warnings.push('Native text geometry exceeded the page span budget and was omitted.')
      return
    }
    spans.push({ startUtf16: starts[index]!, endUtf16: starts[index]! + item.str.length, rectPdf })
  }
  return spans.length ? spans : undefined
}

export interface BuildNativePageContentInput extends PageContentIdentity {
  pageRect: PdfRect
  /** Null means extraction was unavailable; an empty content layer is a valid scanned/blank page. */
  content: NativeTextContent | null
}

/** Preserve joinPageText's exact extraction order and UTF-16 offsets. No figure segmentation is inferred. */
export function buildNativePageContent(input: BuildNativePageContentInput): PageContent {
  const { content } = input
  const warnings = [...(content?.warnings ?? [])].slice(0, 18).map(warning => warning.slice(0, 500))
  if (!content) warnings.push('Native text extraction is unavailable for this page.')
  if ((content?.quality?.unmappedCharacters ?? 0) > 0) warnings.push('Native text contains characters with an invalid PDF mapping.')
  const layer = nativePageContentText(content?.items ?? [])
  const recovered = content?.extraction === 'local-ocr'
  const nativeText = recovered ? { text: '', paragraphBreaks: [] } : layer
  const spans = content && !recovered ? nativeSpans(content, warnings) : undefined
  const textBlockId = pageContentBlockId(input, recovered ? 'recovered-text' : 'native-text')
  const representation = createPageRepresentation({ kind: recovered ? 'ocr-text' : 'native-text', text: layer.text,
    producer: { id: recovered ? 'local-ocr-recovery' : 'pdf-native', version: input.extractionIdentity },
    ...(spans ? { spans } : {}), status: !content || recovered || (content.quality?.unmappedCharacters ?? 0) > 0
      ? 'partial' : 'complete', warnings: [...warnings] })
  return PageContentSchema.parse({ version: 1, sourceDigest: input.sourceDigest, page: input.page,
    extractionIdentity: input.extractionIdentity, pageRect: [...input.pageRect],
    nativeText: { ...nativeText, digest: pageContentDigest(nativeText.text) }, warnings,
    blocks: [{ id: textBlockId, kind: 'text', rectPdf: [...input.pageRect],
      ...(recovered ? {} : { nativeRange: { startUtf16: 0, endUtf16: nativeText.text.length } }),
      representations: [representation] },
    { id: pageContentBlockId(input, 'full-page-visual'), kind: 'visual-region', rectPdf: [...input.pageRect], representations: [] }],
  })
}
