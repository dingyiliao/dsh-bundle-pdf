import type { PdfRect } from '../../core/pdf-types.js'

export type SelectionQuad = readonly [number, number, number, number, number, number, number, number]
type Point = readonly [number, number]

export function quadBounds([tx, ty, ux, uy, bx, by, vx, vy]: SelectionQuad): PdfRect {
  return [Math.min(tx, ux, bx, vx), Math.min(ty, uy, by, vy), Math.max(tx, ux, bx, vx), Math.max(ty, uy, by, vy)]
}

export function quadFrame(quad: SelectionQuad) {
  const [x, y, rightX, rightY, bottomX, bottomY] = quad
  const width = Math.hypot(rightX - x, rightY - y), height = Math.hypot(bottomX - x, bottomY - y)
  if (!Number.isFinite(width) || !Number.isFinite(height) || !width || !height) return undefined
  const ux = (rightX - x) / width, uy = (rightY - y) / width
  const vx = (bottomX - x) / height, vy = (bottomY - y) / height
  const det = ux * vy - uy * vx
  if (Math.abs(det) < 0.01) return undefined
  return {
    width, height, ux, uy, vx, vy,
    project(px: number, py: number): Point {
      const dx = px - x, dy = py - y
      return [(dx * vy - dy * vx) / det, (ux * dy - uy * dx) / det]
    },
    point(along: number, across: number): Point {
      return [x + ux * along + vx * across, y + uy * along + vy * across]
    },
  }
}

export function positionedQuad(points: readonly number[] | null): SelectionQuad | null {
  if (points?.length !== 8 || !points.every(Number.isFinite)) return null
  const quad = points as SelectionQuad
  return quadFrame(quad) ? quad : null
}

/** The overlay and saved fragment should describe only the visible page. */
export function clipQuad(quad: SelectionQuad, crop: readonly number[]): SelectionQuad | null {
  const bounds = quadBounds(quad)
  if (bounds[0] >= crop[0] && bounds[1] >= crop[1] && bounds[2] <= crop[2] && bounds[3] <= crop[3]) return quad
  const clipped = quad.map((value, index) => Math.max(crop[index % 2], Math.min(value, crop[2 + index % 2])))
  return positionedQuad(clipped)
}

type Frame = NonNullable<ReturnType<typeof quadFrame>>

/** Combine nearby glyphs on the same visual line while preserving its orientation. */
export function mergeLineQuads(items: Iterable<{ line: number; quad: SelectionQuad }>): SelectionQuad[] {
  const result: SelectionQuad[] = []
  let line = -1
  let frame: Frame | undefined
  let minX = 0, minY = 0, maxX = 0, maxY = 0
  const flush = () => {
    if (!frame) return
    result.push([...frame.point(minX, minY), ...frame.point(maxX, minY),
      ...frame.point(minX, maxY), ...frame.point(maxX, maxY)])
  }
  for (const item of items) {
    const next = quadFrame(item.quad)
    if (!next) continue
    if (frame && item.line === line && frame.ux * next.ux + frame.uy * next.uy > 0.995
      && frame.vx * next.vx + frame.vy * next.vy > 0.995) {
      const [a, b, c, d] = [0, 2, 4, 6].map(i => frame!.project(item.quad[i], item.quad[i + 1]))
      const left = Math.min(a[0], b[0], c[0], d[0]), right = Math.max(a[0], b[0], c[0], d[0])
      const top = Math.min(a[1], b[1], c[1], d[1]), bottom = Math.max(a[1], b[1], c[1], d[1])
      const height = Math.min(frame.height, next.height)
      // Separate widely spaced text on the same baseline, such as table cells.
      const gap = Math.max(0, left - maxX, minX - right)
      const overlap = Math.min(maxY, bottom) - Math.max(minY, top)
      if (overlap >= height * 0.5 && gap <= Math.max(1, height * 0.7)) {
        minX = Math.min(minX, left); maxX = Math.max(maxX, right)
        minY = Math.min(minY, top); maxY = Math.max(maxY, bottom)
        continue
      }
    }
    flush()
    line = item.line
    frame = next
    minX = minY = 0
    maxX = next.width; maxY = next.height
  }
  flush()
  return result
}
