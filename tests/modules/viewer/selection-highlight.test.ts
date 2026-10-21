import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeSelectionRects } from '../../../src/modules/viewer/model/selection-highlight.ts'

test('adjacent glyph selection boxes become one uninterrupted line', () => {
  assert.deepEqual(mergeSelectionRects([
    [0, 10, 8, 30], [7, 11, 16, 31], [20, 10, 28, 30], [27, 9, 35, 31],
  ]), [[0, 9, 35, 31]])
})

test('selection boxes remain separate across columns and lines', () => {
  assert.deepEqual(mergeSelectionRects([
    [100, 40, 108, 60], [0, 10, 8, 30], [8, 10, 16, 30],
    [0, 40, 8, 60], [8, 40, 16, 60],
  ]), [[0, 10, 16, 30], [0, 40, 16, 60], [100, 40, 108, 60]])
})

test('zero-size rectangles do not create visible highlight boxes', () => {
  assert.deepEqual(mergeSelectionRects([[0, 0, 0, 10], [2, 2, 8, 2], [3, 3, 9, 13]]), [[3, 3, 9, 13]])
})

test('sub-pixel glyph seams from device pixel rounding close inside one word', () => {
  // "2008, 2010, 2014" measured in the reader: every box is one glyph advance wide
  // (digits 9.625, comma 5.466, space 4.333) and neighbours overlap or leave under
  // one CSS pixel, so the whole selected run must come back as one region.
  const boxes: [number, number, number, number][] = [
    [0, 100, 9.625, 118.672], [9.766, 100, 19.391, 118.672], [20.391, 100, 30.016, 118.672],
    [30.766, 100, 40.391, 118.672], [40.391, 100, 46.124, 118.672], [46.391, 100, 50.724, 118.672],
    [50.724, 100, 60.349, 118.672], [61.099, 100, 70.724, 118.672], [71.474, 100, 85.874, 118.672],
    [81.891, 100, 91.516, 118.672],
  ]
  const merged = mergeSelectionRects(boxes)
  assert.deepEqual(merged, [[0, 100, 91.516, 118.672]])
  for (let index = 0; index + 1 < merged.length; index++) {
    assert.ok(merged[index + 1]![0] >= merged[index]![2], 'merged regions must not overlap')
  }
})

test('a glyph advance wide before a comma keeps the highlight continuous', () => {
  // A "1" whose bounding box overlaps the next advance must not split the region.
  const merged = mergeSelectionRects([
    [0, 100, 9.625, 118.672], [9.625, 100, 24.026, 118.672], [20.016, 100, 29.641, 118.672],
    [30.391, 100, 35.857, 118.672],
  ])
  assert.deepEqual(merged, [[0, 100, 35.857, 118.672]])
})

test('a gutter wider than the glyph advance still separates columns', () => {
  const merged = mergeSelectionRects([
    [0, 100, 9.625, 118.672], [9.625, 100, 19.25, 118.672],
    [48, 100, 57.625, 118.672], [57.625, 100, 67.25, 118.672],
  ])
  assert.deepEqual(merged, [[0, 100, 19.25, 118.672], [48, 100, 67.25, 118.672]])
})

test('a smaller glyph beside larger text does not grow the highlight', () => {
  assert.deepEqual(mergeSelectionRects([
    [0, 100, 40, 130], [40, 108, 46, 118],
  ]), [[0, 100, 40, 130], [40, 108, 46, 118]])
})

test('consecutive selected lines remain separate annotation quadrilaterals', () => {
  assert.deepEqual(mergeSelectionRects([
    [10, 100, 60, 114], [10, 116, 60, 130],
  ]), [[10, 100, 60, 114], [10, 116, 60, 130]])
})

test('a paragraph followed by a distant line keeps every text line separate', () => {
  assert.deepEqual(mergeSelectionRects([
    [10, 100, 60, 114], [10, 116, 60, 130], [10, 160, 60, 174],
  ]), [[10, 100, 60, 114], [10, 116, 60, 130], [10, 160, 60, 174]])
})

test('a long selection cannot turn into the page-spanning quad of a saved underline', () => {
  const lines = Array.from({ length: 30 }, (_, index) => {
    const top = 100 + index * 16
    return [[100, top, 150, top + 14], [150, top, 500, top + 14]] as [number, number, number, number][]
  }).flat()
  const regions = mergeSelectionRects(lines)
  assert.equal(regions.length, 30)
  assert.ok(regions.every(rect => rect[3] - rect[1] === 14))
  assert.deepEqual(regions[0], [100, 100, 500, 114])
  assert.deepEqual(regions.at(-1), [100, 564, 500, 578])
})

test('per-glyph boxes become one quad per line for the saved annotation', () => {
  // captureTextSelection converts one box per merged region, so "2008, 2010" must
  // reach PDFium as a single quad instead of ten adjacent glyph quads.
  const regions = mergeSelectionRects([
    [0, 100, 9.625, 118.672], [9.625, 100, 19.25, 118.672], [19.25, 100, 28.875, 118.672],
    [28.875, 100, 38.5, 118.672], [38.5, 100, 43.966, 118.672], [44.233, 100, 48.566, 118.672],
    [48.566, 100, 58.191, 118.672], [58.941, 100, 68.566, 118.672], [69.316, 100, 78.941, 118.672],
    [79.691, 100, 89.316, 118.672],
  ])
  assert.deepEqual(regions, [[0, 100, 89.316, 118.672]])
  assert.equal(regions.length * 8, 8, 'one merged region produces exactly one quad')
})
