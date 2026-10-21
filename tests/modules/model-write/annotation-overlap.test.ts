import assert from 'node:assert/strict'
import test from 'node:test'
import { annotationOverlaps } from '../../../src/modules/model-write/annotation-overlap.ts'
import type { PdfAnnotation } from '../../../src/core/pdf-types.ts'

function mark(id: string, page: number, left: number, right: number,
  subtype = 'Highlight'): PdfAnnotation {
  return { id, page, subtype, rect: [left, 80, right, 100],
    quadPoints: [left, 100, right, 100, left, 80, right, 80],
    flags: 4, supported: true, editable: true }
}

test('overlap classification uses positioned geometry, not repeated text or neighboring marks', () => {
  const requested = mark('new', 1, 50, 100)
  const existing = [mark('same', 1, 50, 100), mark('part', 1, 90, 120),
    mark('neighbor', 1, 100, 130), mark('other-page', 2, 50, 100),
    mark('underline', 1, 50, 100, 'Underline')]
  assert.deepEqual(annotationOverlaps(requested, existing).map(item => [item.annotationId, item.kind]),
    [['same', 'exact'], ['part', 'partial']])
})

test('rotated neighbors with overlapping bounding boxes do not count as the same mark', () => {
  const first = mark('first', 1, -1, 1)
  first.quadPoints = [-1, 0, 0, 1, 0, -1, 1, 0]
  const second = mark('second', 1, 0.5, 2.5)
  second.quadPoints = [0.5, 1.5, 1.5, 2.5, 1.5, 0.5, 2.5, 1.5]
  assert.deepEqual(annotationOverlaps(first, [second]), [])
})
