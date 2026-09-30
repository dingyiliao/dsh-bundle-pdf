import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { NativeWorker } from '../src/engine/native-worker.ts'
import { searchResultExcerpt } from '../src/client/reader-search.ts'

const executable = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
if (process.env.DSH_PDF_REQUIRE_NATIVE_TESTS === '1' && !existsSync(executable)) throw new Error('Native text tests require a built helper')

/** A Type 1 glyph can map to a two-unit UTF-16 value through ToUnicode. */
function supplementaryTextPdf(): Uint8Array {
  const cmap = [
    '/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def', '/CMapType 2 def',
    '1 begincodespacerange', '<00> <FF>', 'endcodespacerange',
    '2 beginbfchar', '<41> <D835DC45>', '<42> <D835DC5D>', 'endbfchar',
    'endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end', '',
  ].join('\n')
  const drawing = 'BT /F1 24 Tf 72 720 Td (AB) Tj ET\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 5 0 R >>',
    `<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}endstream`,
    `<< /Length ${Buffer.byteLength(drawing)} >>\nstream\n${drawing}endstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(pdf, 'ascii'))
}

test('PDFium text decodes supplementary Unicode without replacement characters', { skip: !existsSync(executable) }, async () => {
  const worker = new NativeWorker(executable)
  try {
    await worker.request({ command: 'open', documentId: 'supplementary-text' }, supplementaryTextPdf())
    const content = (await worker.request({ command: 'text', documentId: 'supplementary-text', pageIndex: 0 })).value as {
      items: { str: string; width: number }[]
    }
    assert.equal(content.items.map(item => item.str).join(''), '\u{1D445}\u{1D45D}')
    assert.ok(content.items.some(item => item.width > 0))
  } finally { worker.dispose() }
})

test('search excerpts keep astral characters intact and hide invalid text markers', () => {
  const text = `${'x'.repeat(29)}\u{1D445}${'y'.repeat(29)}target\uFFFD\uFFFDend`
  assert.equal(searchResultExcerpt(text, text.indexOf('target'), 6), `\u{1D445}${'y'.repeat(29)}target…end`)
  assert.equal(searchResultExcerpt(`target${'z'.repeat(64)}\u{1D45D}`, 0, 1).endsWith('\u{1D45D}'), true)
  assert.equal(searchResultExcerpt('a\ud835b\udc45c', 1, 1), 'a…b…c')
})
