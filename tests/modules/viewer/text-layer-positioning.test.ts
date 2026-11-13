import assert from 'node:assert/strict'
import test from 'node:test'
import { positionedTextSegments } from '../../../src/client/viewer/rendering/text-layer.ts'
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

test('text hit boxes come from native geometry instead of DOM measurement', async () => {
  const { computeTextLayerBoxes } = await import('../../../src/client/viewer/rendering/text-layer.ts')
  const { NativeViewport } = await import('../../../src/shared/geometry/native-viewport.ts')
  const geometry = { page: 1, cropBox: [0, 0, 300, 400] as [number, number, number, number], rotation: 0, userUnit: 1 }
  const viewport = new NativeViewport(geometry, 1, 0)
  const content = { items: [item], styles: { nativeSans: { fontFamily: 'sans-serif', ascent: 0.8, descent: 0.2, vertical: false } }, lang: null }
  const glyphs = computeTextLayerBoxes(content, viewport)
  assert.equal(glyphs.length, 3)
  const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 0.001, `${actual} != ${expected}`)
  close(glyphs[0]![0], 32); close(glyphs[0]![1], 284.8); close(glyphs[0]![2], 52); close(glyphs[0]![3], 308.8)
  close(glyphs[2]![2], 82)
  const runs = computeTextLayerBoxes(content, viewport, 'run')
  assert.equal(runs.length, 1)
  close(runs[0]![0], 32); close(runs[0]![2], 82)
})
