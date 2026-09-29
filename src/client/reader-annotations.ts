import type { PdfAnnotation } from '../core/pdf-types.js'
import type { PageViewport } from './reader-selection.js'

export type AnnotationPoint = [number, number]
const markupTypes = new Set(['Highlight', 'Underline', 'StrikeOut'])
const hiddenFlags = 1 | 2 | 32 // Invisible, Hidden, NoView.
const excludedHitTypes = new Set(['Link', 'Popup', 'Widget'])

/** Fixed cell/reference limits keep broad marks from multiplying index memory. */
export function createRectHitIndex<T>(items: readonly { rect: readonly number[]; value: T }[], cellSize = 128) {
  if (!Number.isFinite(cellSize) || cellSize <= 0) throw new RangeError('Hit index cell size must be positive.')
  const records: { rect: [number, number, number, number]; value: T }[] = []
  const cells = new Map<string, number[]>()
  const broad: number[] = []
  const extent = (rect: readonly number[]) => [Math.floor(rect[0] / cellSize), Math.floor(rect[1] / cellSize),
    Math.floor(rect[2] / cellSize), Math.floor(rect[3] / cellSize)] as const
  for (const item of items) {
    if (item.rect.length !== 4 || !item.rect.every(Number.isFinite)) continue
    const rect: [number, number, number, number] = [Math.min(item.rect[0], item.rect[2]), Math.min(item.rect[1], item.rect[3]),
      Math.max(item.rect[0], item.rect[2]), Math.max(item.rect[1], item.rect[3])]
    const index = records.push({ rect, value: item.value }) - 1
    const [left, top, right, bottom] = extent(rect)
    if (![left, top, right, bottom].every(Number.isSafeInteger)
      || (right - left + 1) * (bottom - top + 1) > 16) { broad.push(index); continue }
    for (let x = left; x <= right; x++) for (let y = top; y <= bottom; y++) {
      const key = `${x}:${y}`
      const bucket = cells.get(key)
      if (bucket) bucket.push(index)
      else cells.set(key, [index])
    }
  }
  const overlaps = (rect: readonly number[], other: readonly number[]) => rect[0] <= other[2] && rect[2] >= other[0]
    && rect[1] <= other[3] && rect[3] >= other[1]
  return {
    at(x: number, y: number): T[] {
      const bucket = cells.get(`${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}`) ?? []
      // Both lists retain source order and are disjoint. Merge without sorting.
      const result: T[] = []
      for (let local = 0, large = 0; local < bucket.length || large < broad.length;) {
        const index = large === broad.length || (local < bucket.length && bucket[local] < broad[large])
          ? bucket[local++] : broad[large++]
        const record = records[index]
        if (x >= record.rect[0] && x <= record.rect[2] && y >= record.rect[1] && y <= record.rect[3]) result.push(record.value)
      }
      return result
    },
    intersect(query: readonly number[]): T[] {
      if (query.length !== 4 || !query.every(Number.isFinite)) return []
      const rect = [Math.min(query[0], query[2]), Math.min(query[1], query[3]),
        Math.max(query[0], query[2]), Math.max(query[1], query[3])]
      const [left, top, right, bottom] = extent(rect)
      const result: T[] = []
      if (![left, top, right, bottom].every(Number.isSafeInteger)
        || (right - left + 1) * (bottom - top + 1) > 64) {
        for (const record of records) if (overlaps(record.rect, rect)) result.push(record.value)
        return result
      }
      const indices = new Set(broad)
      for (let x = left; x <= right; x++) for (let y = top; y <= bottom; y++) {
        for (const index of cells.get(`${x}:${y}`) ?? []) indices.add(index)
      }
      // Rectangle queries only ask about overlap; source order is unnecessary.
      for (const index of indices) if (overlaps(records[index].rect, rect)) result.push(records[index].value)
      return result
    },
  }
}

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
    if (!visibleAnnotation(annotation) || excludedHitTypes.has(annotation.subtype)) continue
    if (annotationPolygons(annotation, viewport).some((polygon) => nearPolygon(point, polygon, 2))) return annotation
  }
  return undefined
}

/** Build once for one immutable annotation snapshot and viewport, then reuse on pointer events. */
export function createAnnotationHitTester(annotations: readonly PdfAnnotation[], viewport: PageViewport) {
  const records: { rect: [number, number, number, number]; value: { annotation: PdfAnnotation; polygons: AnnotationPoint[][] } }[] = []
  for (const annotation of annotations) {
    if (!visibleAnnotation(annotation) || excludedHitTypes.has(annotation.subtype)) continue
    const polygons = annotationPolygons(annotation, viewport)
    if (!polygons.length) continue
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
    for (const polygon of polygons) for (const [x, y] of polygon) {
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y)
    }
    records.push({ rect: [left - 2, top - 2, right + 2, bottom + 2], value: { annotation, polygons } })
  }
  const index = createRectHitIndex(records)
  return (point: AnnotationPoint): PdfAnnotation | undefined => {
    const candidates = index.at(point[0], point[1])
    for (let order = candidates.length - 1; order >= 0; order--) {
      const candidate = candidates[order]
      if (candidate.polygons.some(polygon => nearPolygon(point, polygon, 2))) return candidate.annotation
    }
    return undefined
  }
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
