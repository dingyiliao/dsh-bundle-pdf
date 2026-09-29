import type { PdfAnnotation } from '../core/pdf-types.js'
import type { PageViewport } from './reader-selection.js'

export type AnnotationPoint = [number, number]
const markupTypes = new Set(['Highlight', 'Underline', 'StrikeOut'])
const hiddenFlags = 1 | 2 | 32 // Invisible, Hidden, NoView.

export function visibleAnnotation(annotation: PdfAnnotation): boolean {
  return !(annotation.flags & hiddenFlags)
}

/** Quads retain individual lines and skew; a union rectangle includes unrelated whitespace. */
export function annotationPolygons(annotation: PdfAnnotation, viewport: PageViewport): AnnotationPoint[][] {
  const quads = annotation.quadPoints
  const result: AnnotationPoint[][] = []
  if (quads?.length && quads.length % 8 === 0 && quads.every(Number.isFinite)) {
    for (let offset = 0; offset < quads.length; offset += 8) {
      result.push([0, 2, 6, 4].map((index) => viewport.convertToViewportPoint(quads[offset + index], quads[offset + index + 1]) as AnnotationPoint))
    }
  } else if (annotation.rect?.every(Number.isFinite)) {
    const [left, bottom, right, top] = annotation.rect
    result.push([[left, top], [right, top], [right, bottom], [left, bottom]].map(([x, y]) => viewport.convertToViewportPoint(x, y) as AnnotationPoint))
  }
  return result
}

function nearPolygon(point: AnnotationPoint, polygon: AnnotationPoint[], padding: number): boolean {
  let inside = false
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const [x1, y1] = polygon[previous], [x2, y2] = polygon[index]
    if ((y1 > point[1]) !== (y2 > point[1]) && point[0] < (x2 - x1) * (point[1] - y1) / (y2 - y1) + x1) inside = !inside
    const dx = x2 - x1, dy = y2 - y1
    const fraction = Math.max(0, Math.min(1, ((point[0] - x1) * dx + (point[1] - y1) * dy) / (dx * dx + dy * dy || 1)))
    if (Math.hypot(point[0] - x1 - fraction * dx, point[1] - y1 - fraction * dy) <= padding) return true
  }
  return inside
}

export function annotationAtPoint(annotations: readonly PdfAnnotation[], viewport: PageViewport, point: AnnotationPoint): PdfAnnotation | undefined {
  // Newer annotations render last and win when marks overlap.
  for (let index = annotations.length - 1; index >= 0; index--) {
    const annotation = annotations[index]
    if (!visibleAnnotation(annotation) || ['Link', 'Popup', 'Widget'].includes(annotation.subtype)) continue
    if (annotationPolygons(annotation, viewport).some((polygon) => nearPolygon(point, polygon, 2))) return annotation
  }
  return undefined
}

function sameNumbers(left: readonly number[] | undefined, right: readonly number[] | undefined): boolean {
  return left === right || (!!left && !!right && left.length === right.length && left.every((value, index) => value === right[index]))
}

/** Compare Host models, so native CMYK conversion and custom appearances remain untouched. */
export function pendingMarkupAnnotations(current: readonly PdfAnnotation[], painted: readonly PdfAnnotation[]): PdfAnnotation[] {
  const previous = new Map(painted.map((annotation) => [annotation.id, annotation]))
  return current.filter((annotation) => {
    if (!markupTypes.has(annotation.subtype) || !visibleAnnotation(annotation)) return false
    const prior = previous.get(annotation.id)
    return !prior || prior.subtype !== annotation.subtype || prior.opacity !== annotation.opacity
      || !sameNumbers(prior.rect, annotation.rect) || !sameNumbers(prior.quadPoints, annotation.quadPoints)
      || !sameNumbers(prior.color, annotation.color)
  })
}
