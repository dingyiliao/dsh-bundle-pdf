import type { PdfRect } from '../../core/pdf-types.js'
import type { FormControlMarker } from './index.js'

/** Keep complete IDs inside their widgets, without adding margins or covering printed labels. */
export function layoutFormInspection(viewport: { width: number; height: number },
  markers: FormControlMarker[], maxEdge: number): { width: number; height: number; pageRect: PdfRect } {
  const scale = maxEdge / Math.max(viewport.width, viewport.height)
  const width = Math.max(1, Math.round(viewport.width * scale))
  const height = Math.max(1, Math.round(viewport.height * scale))
  for (const marker of markers) {
    marker.rectImage = marker.rectImage.map((value, index) => value * (index % 2
      ? height / viewport.height : width / viewport.width)) as PdfRect
    const [left, top, right, bottom] = marker.rectImage
    // 5×7 glyphs with one column between characters; one pixel is the readable minimum.
    const columns = marker.label.length * 6 - 1
    const glyphScale = Math.min(1.5, (right - left - 2) / columns, (bottom - top - 2) / 7)
    if (glyphScale < 1) throw Object.assign(new Error(
      `${marker.label} is too small for a readable in-field ID at this rendering resolution`),
    { code: 'pdf/form-inspection-unavailable' })
    const labelWidth = columns * glyphScale, labelHeight = 7 * glyphScale
    const x = (left + right - labelWidth) / 2, y = (top + bottom - labelHeight) / 2
    marker.labelRect = [x, y, x + labelWidth, y + labelHeight]
  }
  // Do not return a misleading image if two controls would have indistinguishable IDs.
  for (const [index, marker] of markers.entries()) for (const other of markers.slice(index + 1)) {
    const a = marker.labelRect, b = other.labelRect
    if (Math.max(a[0], b[0]) < Math.min(a[2], b[2]) && Math.max(a[1], b[1]) < Math.min(a[3], b[3])) {
      throw Object.assign(new Error(`Overlapping controls ${marker.label} and ${other.label} cannot be numbered safely`),
        { code: 'pdf/form-inspection-unavailable' })
    }
  }
  return { width, height, pageRect: [0, 0, width, height] }
}
