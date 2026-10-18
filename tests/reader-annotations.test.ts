import assert from 'node:assert/strict'
import test from 'node:test'
import type { PdfAnnotation } from '../src/core/pdf-types.ts'
import {
  annotationAtPoint, createAnnotationHitTester, createRectHitIndex, visibleAnnotation,
} from '../src/client/reader-annotations.ts'
import type { PageViewport } from '../src/client/reader-selection.ts'

const viewport = {
  width: 300, height: 300,
  convertToViewportPoint(x: number, y: number) { return [x, y] },
} as unknown as PageViewport

function mark(id: string, overrides: Partial<PdfAnnotation> = {}): PdfAnnotation {
  return {
    id, page: 1, subtype: 'Highlight', rect: [0, 0, 20, 20],
    flags: 0, supported: true, editable: true, ...overrides,
  }
}

test('rectangle hit index merges local and broad shapes without losing source order', () => {
  const index = createRectHitIndex([
    { rect: [0, 0, 20, 20], value: 'first' },
    { rect: [0, 0, 2000, 2000], value: 'broad' },
    { rect: [10, 10, 15, 15], value: 'last' },
    { rect: [NaN, 0, 20, 20], value: 'invalid' },
  ])
  assert.deepEqual(index.at(12, 12), ['first', 'broad', 'last'])
  assert.deepEqual(index.at(1000, 1000), ['broad'])
  assert.deepEqual(index.at(3000, 3000), [])
  assert.deepEqual(new Set(index.intersect([12, 12, 10, 10])), new Set(['first', 'broad', 'last']))
  assert.deepEqual(index.intersect([0, 0, 2000, 2000]), ['first', 'broad', 'last'])
  assert.deepEqual(index.intersect([0, NaN, 1, 1]), [])
  assert.throws(() => createRectHitIndex([], 0), RangeError)
})

test('annotation hit testing skips hidden and navigation marks and selects the newest visible mark', () => {
  const older = mark('older')
  const newer = mark('newer')
  const hidden = mark('hidden', { flags: 2 })
  const link = mark('link', { subtype: 'Link' })
  const invalid = mark('no-geometry', { rect: undefined, quadPoints: undefined })
  const annotations = [older, newer, hidden, link, invalid]
  assert.equal(visibleAnnotation(hidden), false)
  assert.equal(visibleAnnotation(older), true)
  assert.equal(annotationAtPoint(annotations, viewport, [10, 10])?.id, 'newer')
  assert.equal(annotationAtPoint(annotations, viewport, [100, 100]), undefined)

  const hit = createAnnotationHitTester(annotations, viewport)
  assert.equal(hit([10, 10])?.id, 'newer')
  assert.equal(hit([100, 100]), undefined)
  assert.equal(hit([-5, -5]), undefined)
})
