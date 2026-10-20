import assert from 'node:assert/strict'
import test from 'node:test'
import { positionedTextSegments } from '../../../src/modules/viewer/rendering/text-layer.ts'
import type { NativeTextContent } from '../../../src/shared/native.ts'

const item: NativeTextContent['items'][number] = {
  str: 'Wi\u{1D445}', transform: [24, 0, 0, 24, 32, 96], width: 50, height: 24,
  dir: 'ltr', fontName: 'nativeSans', hasEOL: false,
  glyphs: [[32, 96, 20], [52, 96, 8], [60, 96, 22]],
}

test('selectable spans use PDF character positions, including a supplementary character', () => {
  assert.deepEqual(positionedTextSegments(item), [
    ['W', 32, 96, 20], ['i', 52, 96, 8], ['\u{1D445}', 60, 96, 22],
  ])
})

test('old or oversized native text replies retain the run-level fallback', () => {
  assert.deepEqual(positionedTextSegments({ ...item, glyphs: undefined }), [['Wi\u{1D445}', 32, 96, 50]])
  assert.deepEqual(positionedTextSegments({ ...item, glyphs: [[32, 96, 50]] }), [['Wi\u{1D445}', 32, 96, 50]])
})
