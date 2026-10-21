import type { PdfAnnotation } from '../../core/pdf-types.js'

export interface AnnotationOverlap {
  page: number
  annotationId: string
  kind: 'exact' | 'partial'
  requestedCoverage: number
  existingCoverage: number
}

type Point = readonly [number, number]
type Polygon = Point[]

function signedArea(polygon: readonly Point[]): number {
  let twice = 0
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index]!, b = polygon[(index + 1) % polygon.length]!
    twice += a[0] * b[1] - b[0] * a[1]
  }
  return twice / 2
}

function quadPolygons(points: readonly number[]): Polygon[] {
  if (!points.length || points.length % 8 !== 0) return []
  const result: Polygon[] = []
  for (let index = 0; index < points.length; index += 8) {
    // PDF QuadPoints are TL, TR, BL, BR; polygon clipping needs perimeter order.
    const polygon: Polygon = [0, 2, 6, 4].map(offset =>
      [points[index + offset]!, points[index + offset + 1]!] as Point)
    if (polygon.flat().every(Number.isFinite) && Math.abs(signedArea(polygon)) > 0.00001) result.push(polygon)
  }
  return result
}

function cross(a: Point, b: Point, p: Point): number {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
}

/** Convex quad intersection; axis-aligned bounding boxes misidentify rotated neighboring text. */
function intersectionArea(subject: readonly Point[], clipper: readonly Point[]): number {
  const orientation = Math.sign(signedArea(clipper))
  let polygon = [...subject]
  for (let index = 0; index < clipper.length && polygon.length; index++) {
    const a = clipper[index]!, b = clipper[(index + 1) % clipper.length]!
    const input = polygon
    polygon = []
    let previous = input.at(-1)!
    let previousSide = orientation * cross(a, b, previous)
    for (const point of input) {
      const side = orientation * cross(a, b, point)
      const wasInside = previousSide >= -0.000001, isInside = side >= -0.000001
      if (wasInside !== isInside) {
        const fraction = previousSide / (previousSide - side)
        polygon.push([previous[0] + fraction * (point[0] - previous[0]),
          previous[1] + fraction * (point[1] - previous[1])])
      }
      if (isInside) polygon.push(point)
      previous = point
      previousSide = side
    }
  }
  return polygon.length < 3 ? 0 : Math.abs(signedArea(polygon))
}

function bounds(polygon: readonly Point[]): readonly [number, number, number, number] {
  return [Math.min(...polygon.map(point => point[0])), Math.min(...polygon.map(point => point[1])),
    Math.max(...polygon.map(point => point[0])), Math.max(...polygon.map(point => point[1]))]
}

function sharedArea(left: readonly Polygon[], right: readonly Polygon[]): number {
  let total = 0
  const rightBoxes = right.map(bounds)
  for (const a of left) {
    const box = bounds(a)
    for (let index = 0; index < right.length; index++) {
      const other = rightBoxes[index]!
      if (box[2] <= other[0] || other[2] <= box[0] || box[3] <= other[1] || other[3] <= box[1]) continue
      total += intersectionArea(a, right[index]!)
    }
  }
  return total
}

/** Compare positioned text marks, not their excerpts: the same words may occur more than once. */
export function annotationOverlaps(proposed: Pick<PdfAnnotation, 'page' | 'subtype' | 'quadPoints'>,
  existing: readonly PdfAnnotation[]): AnnotationOverlap[] {
  const requested = quadPolygons(proposed.quadPoints ?? [])
  if (!requested.length) return []
  const requestedArea = requested.reduce((total, polygon) => total + Math.abs(signedArea(polygon)), 0)
  const overlaps: AnnotationOverlap[] = []
  for (const annotation of existing) {
    if (annotation.page !== proposed.page || annotation.subtype !== proposed.subtype || annotation.replyToId) continue
    const current = quadPolygons(annotation.quadPoints ?? [])
    if (!current.length) continue
    const intersection = sharedArea(requested, current)
    if (!intersection) continue
    const requestedCoverage = Math.min(1, intersection / requestedArea)
    const existingCoverage = Math.min(1, intersection / current.reduce((total, polygon) =>
      total + Math.abs(signedArea(polygon)), 0))
    if (Math.max(requestedCoverage, existingCoverage) < 0.15) continue
    overlaps.push({ page: proposed.page, annotationId: annotation.id,
      kind: requestedCoverage >= 0.92 && existingCoverage >= 0.92 ? 'exact' : 'partial',
      requestedCoverage: Math.round(requestedCoverage * 1000) / 1000,
      existingCoverage: Math.round(existingCoverage * 1000) / 1000 })
  }
  return overlaps
}
