import assert from 'node:assert/strict'
import test from 'node:test'
import { recoveredPageText } from '../../../src/modules/document/text-recovery.ts'
import { NativeViewport } from '../../../src/shared/geometry/native-viewport.ts'
import { joinPageText } from '../../../src/shared/page-text.ts'
import type { PdfPageInfo } from '../../../src/core/pdf-types.ts'
import type { OcrOutput } from '../../../src/ocr/types.ts'

const output: OcrOutput = { text: 'Full name\nEnglish', blocks: [], lines: [], confidence: null, status: 'complete', coverage: [], warnings: [],
  words: [
    { id: 'one', parentId: 'line-one', text: 'Full', box: { x0: 20, y0: 30, x1: 80, y1: 50 }, confidence: null },
    { id: 'two', parentId: 'line-one', text: 'name', box: { x0: 90, y0: 30, x1: 160, y1: 50 }, confidence: null },
    { id: 'three', parentId: 'line-two', text: 'English', box: { x0: 20, y0: 60, x1: 160, y1: 80 }, confidence: null },
  ] }

test('positioned recovery preserves text, spaces, line breaks and crop/rotation/UserUnit geometry', () => {
  for (const rotation of [0, 90, 180, 270]) {
    const geometry = { page: 1, cropBox: [10, 20, 210, 320], userUnit: 2, rotation } as PdfPageInfo
    const viewport = new NativeViewport(geometry, 1)
    const content = recoveredPageText(output, geometry, 400, 600)
    assert.equal(joinPageText(content.items), 'Full name\nEnglish')
    assert.equal(content.extraction, 'local-ocr'); assert.match(content.warnings![0], /approximate/)
    const item = content.items[0]
    const baseline = viewport.convertToViewportPoint(item.transform[4], item.transform[5])
    assert.ok(Math.abs(baseline[0] - 20 * viewport.width / 400) < 0.00001)
    assert.ok(Math.abs(baseline[1] - 50 * viewport.height / 600) < 0.00001)
    assert.equal(item.glyphs, undefined, 'Do not fabricate exact per-character positions from an OCR word box')
  }
})

test('recovery refuses transcripts without usable word boxes and drops invalid/outside boxes', () => {
  const geometry = { page: 1, cropBox: [0, 0, 200, 300], userUnit: 1, rotation: 0 } as PdfPageInfo
  for (const words of [[], [{ ...output.words[0], box: null }], [{ ...output.words[0], box: { x0: -1, y0: 0, x1: 50, y1: 20 } }]]) {
    assert.throws(() => recoveredPageText({ ...output, words }, geometry, 400, 600), { code: 'pdf/text-recovery-failed' })
  }
  assert.throws(() => recoveredPageText(output, geometry, 0, 600), /dimensions/)
  assert.match(recoveredPageText({ ...output, status: 'partial' }, geometry, 400, 600).warnings![1], /partial/)
})
