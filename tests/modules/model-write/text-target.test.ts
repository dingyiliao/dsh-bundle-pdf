import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { locateTextTarget } from '../../../src/modules/model-write/text-target.ts'
import type { NativeTextContent } from '../../../src/shared/native.ts'
import { NativeWorker } from '../../../src/adapters/host/pdfium/native-worker.ts'
import { nativeTestSubprocess } from '../../native-test-subprocess.ts'

function page(items: NativeTextContent['items']): NativeTextContent {
  return { items, styles: { test: { fontFamily: 'sans-serif', ascent: 0.8, descent: -0.2, vertical: false } }, lang: null }
}

function run(str: string, x: number, y: number, hasEOL = false): NativeTextContent['items'][number] {
  return { str, transform: [12, 0, 0, 12, x, y], width: Array.from(str).length * 6,
    height: 12, dir: 'ltr', fontName: 'test', hasEOL,
    glyphs: Array.from(str, (_, index) => [x + index * 6, y, 6]) }
}

test('quoted text resolves to title glyphs, not the preceding row with a plausible guessed rectangle', () => {
  const content = page([run('Bit[0] Reserved.', 130, 420, true),
    run('B3.2.17 ', 72, 380), run('MemManage Fault Address Register, MMFAR', 126, 380)])
  const result = locateTextTarget(content, 'B3.2.17 MemManage Fault Address Register, MMFAR')
  assert.deepEqual(result.rect, [72, 377.6, 360, 389.6])
  assert.equal(result.quadPoints.length, 16)
  assert.ok(result.rect[3] < 400, 'the preceding Bit[0] row is not covered')
})

test('text targeting fails closed on an absent or ambiguous quote and missing glyph positions', () => {
  const duplicate = page([run('MMFAR', 72, 380, true), run('MMFAR', 72, 300)])
  assert.throws(() => locateTextTarget(duplicate, 'missing'), { code: 'pdf/text-not-found' })
  assert.throws(() => locateTextTarget(duplicate, 'MMFAR'), { code: 'pdf/ambiguous-text-target' })
  const unpositioned = page([{ ...run('MMFAR', 72, 380), glyphs: undefined }])
  assert.throws(() => locateTextTarget(unpositioned, 'MMFAR'), { code: 'pdf/text-geometry-unavailable' })
  const zeroTextAxis = page([{ ...run('MMFAR', 72, 380), transform: [0, 0, 0, 12, 72, 380] }])
  assert.throws(() => locateTextTarget(zeroTextAxis, 'MMFAR'), { code: 'pdf/text-geometry-unavailable' })
  const invalidGlyph = page([{ ...run('MMFAR', 72, 380), glyphs: [[72, 380, 0],
    [78, 380, 6], [84, 380, 6], [90, 380, 6], [96, 380, 6]] }])
  assert.throws(() => locateTextTarget(invalidGlyph, 'MMFAR'), { code: 'pdf/text-geometry-unavailable' })
})

test('a supplementary Unicode character remains one positioned glyph', () => {
  const content = page([run('A𝑅B', 72, 380)])
  const result = locateTextTarget(content, '𝑅B')
  assert.deepEqual(result.rect, [78, 377.6, 90, 389.6])
})

const executable = resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
test('real PDFium glyph positions select the title and not the nearby row', { skip: !existsSync(executable) }, async () => {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([400, 300]), font = await pdf.embedFont(StandardFonts.Helvetica)
  page.drawText('Bit[0] Reserved.', { x: 50, y: 140, size: 12, font })
  page.drawText('MMFAR title', { x: 50, y: 100, size: 12, font })
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    await worker.request({ command: 'open', documentId: 'text-target-test' }, await pdf.save())
    const content = (await worker.request({ command: 'text', documentId: 'text-target-test', pageIndex: 0 })).value as NativeTextContent
    const { rect, quadPoints } = locateTextTarget(content, 'MMFAR title')
    assert.ok(rect[1] < 100 && rect[3] > 100)
    assert.ok(rect[3] < 125, 'the mark must not cover the nearby Bit[0] row')
    assert.ok(rect[3] - rect[1] > 8, 'the height comes from the text matrix, not PDFium height=1')
    assert.equal(quadPoints.length, 8)
  } finally { await worker.dispose() }
})
