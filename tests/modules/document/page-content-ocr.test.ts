import assert from 'node:assert/strict'
import test from 'node:test'
import { ocrPageContentSpans } from '../../../src/modules/document/index.ts'
import { NativeViewport } from '../../../src/shared/geometry/native-viewport.ts'
import type { OcrOutput } from '../../../src/ocr/types.ts'

const output: OcrOutput = { text: 'North South', blocks: [], lines: [], words: [
  { id: 'a', text: 'North', parentId: 'line', box: { x0: 10, y0: 20, x1: 40, y1: 30 }, confidence: null },
  { id: 'b', text: 'South', parentId: 'line', box: { x0: 50, y0: 20, x1: 90, y1: 30 }, confidence: null },
], status: 'complete', confidence: null, coverage: [], warnings: [] }

test('positioned OCR retains exact recognized offsets across crop, rotation and user-unit transforms', () => {
  for (const rotation of [0, 90, 180, 270]) {
    const geometry = { page: 1, mediaBox: [0, 0, 200, 300] as [number, number, number, number],
      cropBox: [10, 20, 110, 220] as [number, number, number, number], rotation, userUnit: 2 }
    const viewport = new NativeViewport(geometry, 1)
    const spans = ocrPageContentSpans(output, geometry, 100, 200)
    assert.deepEqual(spans.map(span => [span.startUtf16, span.endUtf16]), [[0, 5], [6, 11]])
    for (const [index, span] of spans.entries()) {
      const bounds = viewport.convertToViewportRectangle(span.rectPdf)
      const actual = [Math.min(bounds[0], bounds[2]) / viewport.width * 100,
        Math.min(bounds[1], bounds[3]) / viewport.height * 200,
        Math.max(bounds[0], bounds[2]) / viewport.width * 100,
        Math.max(bounds[1], bounds[3]) / viewport.height * 200]
      const box = output.words[index].box!
      assert.ok(actual.every((value, i) => Math.abs(value - [box.x0, box.y0, box.x1, box.y1][i]) < 1e-8))
    }
  }
})

test('text-only OCR stays indexable without fabricated coordinates and invalid dimensions are rejected', () => {
  const geometry = { page: 1, mediaBox: [0, 0, 100, 200] as [number, number, number, number],
    cropBox: [0, 0, 100, 200] as [number, number, number, number], rotation: 0, userUnit: 1 }
  assert.deepEqual(ocrPageContentSpans({ ...output, words: [] }, geometry, 100, 200), [])
  assert.throws(() => ocrPageContentSpans(output, geometry, 0, 200), /positive integers/u)
})
