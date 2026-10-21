import assert from 'node:assert/strict'
import test from 'node:test'
import { clampPdfRectToBounds, movePdfNoteRectByMarker, noteMarkerViewportPosition, overlapFraction,
  pdfRectToViewport, translatePdfRectInViewport, unionRects, viewportRectToPdf } from '../../../src/modules/viewer/model/reader-selection.ts'
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

test('note movement follows viewport deltas and stays inside the page bounds', () => {
  const moved = translatePdfRectInViewport(viewport, [110, 160, 130, 180], 8, -6)
  assert.deepEqual(moved, [118, 166, 138, 186])
  assert.deepEqual(clampPdfRectToBounds([-10, 195, 10, 215], [0, 0, 200, 200]), [0, 180, 20, 200])
})

test('a fixed-size note marker reaches every page corner while its PDF rectangle stays inside', () => {
  const page = { ...viewport, width: 300, height: 200 } as PageViewport
  const rect: [number, number, number, number] = [100, 140, 160, 200]
  assert.deepEqual(noteMarkerViewportPosition(page, rect), { left: 0, top: 0 })
  const moved = movePdfNoteRectByMarker(page, rect, 278, 178)
  assert.deepEqual(noteMarkerViewportPosition(page, moved), { left: 278, top: 178 })
  assert.deepEqual(pdfRectToViewport(page, moved), [240, 140, 300, 200])
  assert.deepEqual(noteMarkerViewportPosition(page, movePdfNoteRectByMarker(page, moved, -500, -500)), { left: 0, top: 0 })
})
