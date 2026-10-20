import assert from 'node:assert/strict'
import test from 'node:test'
import { overlapFraction, pdfRectToViewport, unionRects, viewportRectToPdf } from '../../../src/modules/viewer/model/reader-selection.ts'
import type { PageViewport } from '../../../src/modules/viewer/model/reader-selection.ts'

const viewport = {
  convertToPdfPoint(x: number, y: number) { return [x + 100, 200 - y] },
  convertToViewportPoint(x: number, y: number) { return [x - 100, 200 - y] },
} as unknown as PageViewport

test('reader geometry preserves all four corners across the viewport/PDF transform', () => {
  assert.deepEqual(unionRects([[10, 20, 20, 40], [5, 25, 25, 35]]), [5, 20, 25, 40])
  const converted = viewportRectToPdf(viewport, [10, 20, 30, 40])
  assert.deepEqual(converted.rect, [110, 160, 130, 180])
  assert.deepEqual(converted.quadPoints, [110, 180, 130, 180, 110, 160, 130, 160])
  assert.deepEqual(pdfRectToViewport(viewport, converted.rect), [10, 20, 30, 40])
  assert.equal(overlapFraction([0, 0, 20, 20], [10, 0, 30, 20]), 0.5)
  assert.equal(overlapFraction([0, 0, 20, 20], [30, 30, 40, 40]), 0)
})
