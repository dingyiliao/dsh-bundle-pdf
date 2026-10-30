import type { NativeTextContent } from '../../../shared/native.ts'
import type { NativeViewport } from '../../../shared/geometry/native-viewport.ts'

export function positionedTextSegments(item: NativeTextContent['items'][number]): [text: string, x: number, y: number, width: number][] {
  const characters = Array.from(item.str)
  if (item.glyphs?.length === characters.length) {
    return characters.map((character, index) => [character, ...item.glyphs![index]])
  }
  return [[item.str, item.transform[4], item.transform[5], item.width]]
}

/** Build selectable spans directly from PDFium's positioned text runs. */
export function renderNativeTextLayer(host: HTMLElement, content: NativeTextContent, viewport: NativeViewport): HTMLSpanElement[] {
  const spans: HTMLSpanElement[] = []
  const fragment = document.createDocumentFragment()
  const measure = document.createElement('canvas').getContext('2d')
  const [va, vb, vc, vd, ve, vf] = viewport.transform
  const fontSize = 100
  for (const [runIndex, item] of content.items.entries()) {
    if (!item.str) continue
    const [a, b, c, d] = item.transform
    const xAxis = va * a + vc * b, yAxis = vb * a + vd * b
    // CSS glyphs grow downward; PDF glyph-space Y grows upward.
    const crossX = -(va * c + vc * d), crossY = -(vb * c + vd * d)
    if (![xAxis, yAxis, crossX, crossY].every(Number.isFinite)) continue
    const style = content.styles[item.fontName]
    const family = style?.fontFamily || 'sans-serif'
    if (measure) measure.font = `${fontSize}px ${family}`
    const addSpan = (value: string, originX: number, originY: number, width: number) => {
      const x = va * originX + vc * originY + ve, y = vb * originX + vd * originY + vf
      if (!Number.isFinite(x) || !Number.isFinite(y)) return
      const span = document.createElement('span')
      span.textContent = value
      // Keep the original PDFium run identifiable after positioning each glyph
      // separately, so selections can recover only genuine neighboring text.
      span.dataset.pdfRun = String(runIndex)
      span.style.position = 'absolute'
      span.style.left = `${x}px`
      span.style.top = `${y}px`
      span.style.fontFamily = family
      span.style.fontSize = `${fontSize}px`
      span.style.lineHeight = '1'
      span.style.whiteSpace = 'pre'
      const naturalWidth = measure?.measureText(value).width ?? 0
      const projectedWidth = naturalWidth * Math.hypot(xAxis, yAxis) / fontSize
      const targetWidth = width * viewport.scale * viewport.userUnit
      const stretch = projectedWidth > 0 && targetWidth > 0 ? targetWidth / projectedWidth : 1
      span.style.transform = `matrix(${xAxis * stretch / fontSize},${yAxis * stretch / fontSize},${crossX / fontSize},${crossY / fontSize},0,0) translateY(${-fontSize * (style?.ascent ?? 0.8)}px)`
      fragment.append(span)
      spans.push(span)
    }
    // A run-wide scale matches the end of a line but drifts inside it when
    // the PDF font and the browser's substitute have different glyph widths.
    for (const [text, x, y, width] of positionedTextSegments(item)) addSpan(text, x, y, width)
    if (item.hasEOL) fragment.append(document.createElement('br'))
  }
  host.replaceChildren(fragment)
  return spans
}
