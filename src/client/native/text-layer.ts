import type { NativeTextContent } from '../../shared/native.ts'
import type { NativeViewport } from './viewport.ts'

/** Build selectable spans directly from PDFium's positioned text runs. */
export function renderNativeTextLayer(host: HTMLElement, content: NativeTextContent, viewport: NativeViewport): HTMLSpanElement[] {
  const spans: HTMLSpanElement[] = []
  const fragment = document.createDocumentFragment()
  const measure = document.createElement('canvas').getContext('2d')
  const [va, vb, vc, vd, ve, vf] = viewport.transform
  const fontSize = 100
  for (const item of content.items) {
    if (!item.str) continue
    const [a, b, c, d, e, f] = item.transform
    const xAxis = va * a + vc * b, yAxis = vb * a + vd * b
    // CSS glyphs grow downward; PDF glyph-space Y grows upward.
    const crossX = -(va * c + vc * d), crossY = -(vb * c + vd * d)
    const x = va * e + vc * f + ve, y = vb * e + vd * f + vf
    if (![xAxis, yAxis, crossX, crossY, x, y].every(Number.isFinite)) continue
    const style = content.styles[item.fontName]
    const family = style?.fontFamily || 'sans-serif'
    const span = document.createElement('span')
    span.textContent = item.str
    span.style.position = 'absolute'
    span.style.left = `${x}px`
    span.style.top = `${y}px`
    span.style.fontFamily = family
    span.style.fontSize = `${fontSize}px`
    span.style.lineHeight = '1'
    span.style.whiteSpace = 'pre'
    if (measure) measure.font = `${fontSize}px ${family}`
    const naturalWidth = measure?.measureText(item.str).width ?? 0
    const projectedWidth = naturalWidth * Math.hypot(xAxis, yAxis) / fontSize
    const targetWidth = item.width * viewport.scale * viewport.userUnit
    const stretch = projectedWidth > 0 && targetWidth > 0 ? targetWidth / projectedWidth : 1
    span.style.transform = `matrix(${xAxis * stretch / fontSize},${yAxis * stretch / fontSize},${crossX / fontSize},${crossY / fontSize},0,0) translateY(${-fontSize * (style?.ascent ?? 0.8)}px)`
    fragment.append(span)
    spans.push(span)
    if (item.hasEOL) fragment.append(document.createElement('br'))
  }
  host.replaceChildren(fragment)
  return spans
}
