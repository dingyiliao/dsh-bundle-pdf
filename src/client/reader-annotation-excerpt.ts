import type { PdfAnnotation, PdfRect } from '../core/pdf-types.js'
import type { NativeTextContent } from '../shared/native.js'
import { joinPageText } from '../shared/page-text.js'

function annotationBoxes(annotation: PdfAnnotation): PdfRect[] {
  const points = annotation.quadPoints
  if (points?.length && points.length % 8 === 0) {
    const boxes: PdfRect[] = []
    for (let index = 0; index < points.length; index += 8) {
      const xs = [points[index], points[index + 2], points[index + 4], points[index + 6]]
      const ys = [points[index + 1], points[index + 3], points[index + 5], points[index + 7]]
      if ([...xs, ...ys].every(Number.isFinite)) boxes.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)])
    }
    if (boxes.length) return boxes
  }
  return annotation.rect ? [annotation.rect] : []
}

function textBox(item: NativeTextContent['items'][number]): PdfRect | undefined {
  const [a, b, , , x, y] = item.transform
  const axis = Math.hypot(a, b)
  if (!axis || !Number.isFinite(axis) || !Number.isFinite(item.width) || !Number.isFinite(item.height)) return
  const dx = a / axis, dy = b / axis
  const corners = [0, item.width].flatMap(along => [-0.2, 0.8].map(above => ({
    x: x + dx * along - dy * item.height * above,
    y: y + dy * along + dx * item.height * above,
  })))
  const xs = corners.map(point => point.x), ys = corners.map(point => point.y)
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

function overlaps(a: PdfRect, b: PdfRect): boolean {
  return Math.min(a[2], b[2]) > Math.max(a[0], b[0]) && Math.min(a[3], b[3]) > Math.max(a[1], b[1])
}

/** A nearby text-line preview, not an exact character-level selection. */
export function annotationExcerpt(annotation: PdfAnnotation, content: NativeTextContent): string | undefined {
  if (!['Highlight', 'Underline', 'StrikeOut'].includes(annotation.subtype)) return
  const boxes = annotationBoxes(annotation)
  if (!boxes.length) return
  const matches: NativeTextContent['items'] = []
  let length = 0
  for (const item of content.items) {
    const bounds = textBox(item)
    if (bounds && boxes.some(box => overlaps(box, bounds))) { matches.push(item); length += item.str.length }
    if (length >= 160) break
  }
  const preview = joinPageText(matches).replace(/\s+/g, ' ').trim()
  return preview ? `${preview.slice(0, 140)}${preview.length > 140 ? '…' : ''}` : undefined
}
