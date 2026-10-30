import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { locateTextRange, locateTextOffsetRange } from '../../../src/shared/geometry/text-target.ts'
import { joinPageText } from '../../../src/shared/page-text.ts'
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
  const result = locateTextRange(content, 'B3.2.17 MemManage Fault Address Register, MMFAR', 'B3.2.17 MemManage Fault Address Register, MMFAR', true)
  assert.deepEqual(result.rect, [72, 377.6, 360, 389.6])
  assert.equal(result.quadPoints.length, 16)
  assert.ok(result.rect[3] < 400, 'the preceding Bit[0] row is not covered')
})

test('start/end anchors cover every intervening visual line and return its exact joined text', () => {
  const content = page([run('Before', 60, 260, true), run('Start here', 60, 240, true),
    run('Middle paragraph', 60, 220, true), run('Finish here', 60, 200, true),
    run('After', 60, 180)])
  const selected = locateTextRange(content, 'Start here', 'Finish here', true)
  assert.equal(selected.text, 'Start here\nMiddle paragraph\nFinish here')
  assert.equal(selected.quadPoints.length, 24)
  assert.equal(selected.startUtf16, 'Before\n'.length)
  assert.equal(selected.endUtf16, 'Before\nStart here\nMiddle paragraph\nFinish here'.length)
})

test('range targeting rejects an end before its start and a possible second-column restart', () => {
  const content = page([run('Start here', 60, 260, true), run('Middle', 60, 240, true),
    run('End here', 60, 220)])
  assert.throws(() => locateTextRange(content, 'End here', 'Start here', true),
    { code: 'pdf/invalid-text-range' })
  const columns = page([run('Start here', 60, 260, true), run('First column', 60, 90, true),
    run('Second column', 180, 260, true), run('End here', 180, 240)])
  assert.throws(() => locateTextRange(columns, 'Start here', 'End here', true),
    { code: 'pdf/ambiguous-reading-order' })
})

test('strict offset targets reject line-interleaved columns but preserve ordinary paragraphs and split runs', () => {
  const columns = page([run('Left first', 60, 300), run('Right unrelated', 300, 300), run('Left second', 60, 280)])
  assert.throws(() => locateTextOffsetRange(columns, 0, joinPageText(columns.items).length),
    { code: 'pdf/ambiguous-reading-order' })
  const quote = joinPageText(columns.items)
  assert.throws(() => locateTextRange(columns, quote, quote), { code: 'pdf/ambiguous-reading-order' })
  const cases = [
    page([run('Normal long paragraph', 60, 300), run(' continues', 186, 300, true), run('Next line', 60, 280)]),
    page([run('Normal', 60, 300), run(' words', 102, 300, true), run('Next line', 60, 280)]),
    page([run('A', 60, 300), run('B', 66, 300), run('C', 72, 300, true), run('D', 60, 280)]),
    page([run('Indented paragraph', 120, 300, true), run('Continued below', 60, 280)]),
  ]
  for (const content of cases) {
    const text = joinPageText(content.items)
    assert.equal(locateTextOffsetRange(content, 0, text.length).text, text)
    assert.equal(locateTextRange(content, text, text).text, text)
  }
})

test('text targeting fails closed on an absent or ambiguous quote and missing glyph positions', () => {
  const duplicate = page([run('MMFAR', 72, 380, true), run('MMFAR', 72, 300)])
  assert.throws(() => locateTextRange(duplicate, 'missing', 'missing', true), { code: 'pdf/text-not-found' })
  assert.throws(() => locateTextRange(duplicate, 'MMFAR', 'MMFAR', true), { code: 'pdf/ambiguous-text-target' })
  const unpositioned = page([{ ...run('MMFAR', 72, 380), glyphs: undefined }])
  assert.throws(() => locateTextRange(unpositioned, 'MMFAR', 'MMFAR', true), { code: 'pdf/text-geometry-unavailable' })
  const zeroTextAxis = page([{ ...run('MMFAR', 72, 380), transform: [0, 0, 0, 12, 72, 380] }])
  assert.throws(() => locateTextRange(zeroTextAxis, 'MMFAR', 'MMFAR', true), { code: 'pdf/text-geometry-unavailable' })
  const invalidGlyph = page([{ ...run('MMFAR', 72, 380), glyphs: [[72, 380, 0],
    [78, 380, 6], [84, 380, 6], [90, 380, 6], [96, 380, 6]] }])
  assert.throws(() => locateTextRange(invalidGlyph, 'MMFAR', 'MMFAR', true), { code: 'pdf/text-geometry-unavailable' })
})

test('a supplementary Unicode character remains one positioned glyph', () => {
  const content = page([run('A𝑅B', 72, 380)])
  const result = locateTextRange(content, '𝑅B', '𝑅B', true)
  assert.deepEqual(result.rect, [78, 377.6, 90, 389.6])
})

test('one-scalar native runs use their exact origin and width without guessing multi-character geometry', () => {
  const single = (str: string, x: number) => ({ ...run(str, x, 180), glyphs: undefined })
  const content = page([single('A', 60), single('𝑅', 66), single('B', 72)])
  const result = locateTextRange(content, 'A𝑅B', 'A𝑅B', true)
  assert.deepEqual(result.rect, [60, 177.6, 78, 189.6])
  assert.equal(result.quadPoints.length, 24)
  for (const item of [
    { ...single('A', 60), width: 0 },
    { ...single('A', 60), width: Number.NaN },
    { ...single('A', 60), transform: [12, 0, 0, 12, Number.POSITIVE_INFINITY, 180] },
    { ...single('A', 60), glyphs: [] },
    single('AB', 60),
  ]) assert.throws(() => locateTextRange(page([item]), item.str, item.str, true), { code: 'pdf/text-geometry-unavailable' })
  assert.throws(() => locateTextRange({ ...page([single('A', 60)]), extraction: 'local-ocr' }, 'A', 'A', true),
    { code: 'pdf/text-geometry-unavailable' })
})

const executable = resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
test('real PDFium one-character text objects expose glyph positions and remain exactly targetable',
  { skip: !existsSync(executable) }, async () => {
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica)
    const pdfPage = pdf.addPage([400, 300])
    pdfPage.drawText('A', { x: 60, y: 180, size: 12, font })
    pdfPage.drawText('B', { x: 60 + font.widthOfTextAtSize('A', 12), y: 180, size: 12, font })
    const worker = new NativeWorker(executable, nativeTestSubprocess)
    try {
      await worker.request({ command: 'open', documentId: 'single-glyph-target' }, await pdf.save())
      const content = (await worker.request({ command: 'text', documentId: 'single-glyph-target', pageIndex: 0 })).value as NativeTextContent
      assert.deepEqual(content.items.map(item => item.str), ['A', 'B'])
      assert.ok(content.items.every(item => item.glyphs?.length === 1))
      const result = locateTextRange(content, 'AB', 'AB', true)
      assert.equal(result.quadPoints.length, 16)
      assert.ok(result.rect[0] >= 59 && result.rect[2] <= 80)
      assert.ok(result.rect[1] < 180 && result.rect[3] > 180)
    } finally { await worker.dispose() }
  })
test('real PDFium glyph positions select the title and not the nearby row', { skip: !existsSync(executable) }, async () => {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([400, 300]), font = await pdf.embedFont(StandardFonts.Helvetica)
  page.drawText('Bit[0] Reserved.', { x: 50, y: 140, size: 12, font })
  page.drawText('MMFAR title', { x: 50, y: 100, size: 12, font })
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    await worker.request({ command: 'open', documentId: 'text-target-test' }, await pdf.save())
    const content = (await worker.request({ command: 'text', documentId: 'text-target-test', pageIndex: 0 })).value as NativeTextContent
    const { rect, quadPoints } = locateTextRange(content, 'MMFAR title', 'MMFAR title', true)
    assert.ok(rect[1] < 100 && rect[3] > 100)
    assert.ok(rect[3] < 125, 'the mark must not cover the nearby Bit[0] row')
    assert.ok(rect[3] - rect[1] > 8, 'the height comes from the text matrix, not PDFium height=1')
    assert.equal(quadPoints.length, 8)
  } finally { await worker.dispose() }
})
