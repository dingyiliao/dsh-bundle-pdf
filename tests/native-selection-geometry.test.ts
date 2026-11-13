import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { classicPdf } from './fixtures/plain-pdf.ts'
import type { SelectionGeometryChunk } from '../src/engine/protocol/selection.ts'
import { NativeWorker } from '../src/engine/host/native-worker.ts'
import { brokenTextMappingFixture } from './fixtures/broken-text-mapping.ts'
import { hyphenatedTextPdf, supplementaryTextPdf } from './native-fixture.ts'
import { nativeTestSubprocess } from './native-test-subprocess.ts'

const executable = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
if (process.env.DSH_PDF_REQUIRE_NATIVE_TESTS === '1' && !existsSync(executable)) throw new Error('Native selection tests require a built helper')
const skip = !existsSync(executable)

test('selection geometry streams the same clipped, oriented glyphs regardless of chunk boundaries', { skip }, async () => {
  const program = [
    'BT /F1 24 Tf 32 128 Td (WiWi selection) Tj ET',
    'BT /F1 18 Tf 32 90 Td (Hello world) Tj ET',
    'BT /F1 8 Tf 10 2 Td (Outside crop) Tj ET',
    'BT /F1 15 Tf 0 1 -1 0 241 20 Tm (Turn) Tj ET',
    'BT /F1 13 Tf .848048 .529919 -.529919 .848048 170 32 Tm (Tilt) Tj ET',
    '',
  ].join('\n')
  const bytes = classicPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 240] /CropBox [20 10 270 225] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${program.length} >>\nstream\n${program}endstream`,
  ])
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    const documentId = 'selection-geometry'
    await worker.request({ command: 'open', documentId }, bytes)
    assert.equal(worker.selectionGeometry, true)
    const geometry = { command: 'selectionGeometry', documentId, pageIndex: 0 } as const
    const complete = (await worker.request(geometry)).value
    assert.equal(complete.nextOffset, null)
    assert.equal(complete.unmapped, 0)
    const glyphs: SelectionGeometryChunk['glyphs'] = []
    let offset: number | null = 0
    while (offset !== null) {
      const chunk: SelectionGeometryChunk = (await worker.request({ ...geometry, offset, limit: 3 })).value
      assert.equal(chunk.offset, offset)
      assert.equal(chunk.charCount, complete.charCount)
      glyphs.push(...chunk.glyphs)
      offset = chunk.nextOffset
    }
    assert.deepEqual(glyphs, complete.glyphs)
    const text = glyphs.map(glyph => glyph.text).join('')
    assert.match(text, /^WiWi selection\nHello world/)
    assert.doesNotMatch(text, /Outside crop/)
    const wide = glyphs[0]?.quad, narrow = glyphs[1]?.quad
    assert.ok(wide && narrow && wide[2] - wide[0] > narrow[2] - narrow[0])
    assert.ok(glyphs.every(glyph => !glyph.quad || glyph.quad.every((coordinate, index) =>
      index % 2 ? coordinate >= 10 && coordinate <= 225 : coordinate >= 20 && coordinate <= 270)))
    const [turn, tilt] = glyphs.filter(glyph => glyph.text === 'T')
    assert.ok(turn?.quad && turn.quad[0] === turn.quad[2] && turn.quad[1] < turn.quad[3])
    assert.equal(tilt?.quad, null, 'axis-aligned public bounds cannot certify a skewed or arbitrarily rotated quad')
    const firstLineBreak = glyphs.find(glyph => glyph.text === '\n')!
    assert.equal(firstLineBreak.end, firstLineBreak.index + 2)
    await assert.rejects(worker.request({ ...geometry, offset: firstLineBreak.index + 1 }), { code: 'pdf/native-request' })
    await worker.request({ command: 'close', documentId })
    await assert.rejects(worker.request(geometry), { code: 'pdf/native-document' })
  } finally { await worker.dispose() }
})

test('selection chunk cursors keep supplementary characters intact', { skip }, async () => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    const documentId = 'supplementary-selection'
    await worker.request({ command: 'open', documentId }, supplementaryTextPdf())
    const geometry = { command: 'selectionGeometry', documentId, pageIndex: 0, limit: 1 } as const
    const first = (await worker.request(geometry)).value
    assert.equal(first.glyphs[0]?.text, '\u{1D445}')
    assert.equal(first.nextOffset, 2)
    assert.equal(first.glyphs[0]?.end, 2)
    await assert.rejects(worker.request({ ...geometry, offset: 1 }), { code: 'pdf/native-request' })
    const second = (await worker.request({ ...geometry, offset: 2 })).value
    assert.equal(second.glyphs[0]?.text, '\u{1D45D}')
    assert.equal(second.nextOffset, null)
  } finally { await worker.dispose() }
})

test('selection geometry distinguishes undecodable glyphs from removed layout hyphens', { skip }, async () => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    const documentId = 'selection-text-quality'
    const request = { command: 'selectionGeometry', documentId, pageIndex: 0 } as const
    await worker.request({ command: 'open', documentId }, await hyphenatedTextPdf())
    const hyphenated = (await worker.request(request)).value
    assert.equal(hyphenated.unmapped, 0)
    assert.equal(hyphenated.glyphs.map(glyph => glyph.text).join(''), 'understanding the model')
    await worker.request({ command: 'open', documentId }, await brokenTextMappingFixture())
    const malformed = (await worker.request(request)).value
    assert.ok(malformed.unmapped > 0)
    assert.equal(malformed.glyphs.filter(glyph => glyph.text === '\ufffd').length, malformed.unmapped)
  } finally { await worker.dispose() }
})

test('native selection cannot expose copy-restricted encrypted text', { skip }, async () => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    const documentId = 'copy-restricted-selection'
    const bytes = await readFile(new URL('./fixtures/encrypted-restricted-text.pdf', import.meta.url))
    await worker.request({ command: 'open', documentId, password: 'fixture-password' }, bytes)
    await assert.rejects(worker.request({ command: 'selectionGeometry', documentId, pageIndex: 0 }),
      { code: 'pdf/protected-document' })
    await worker.request({ command: 'open', documentId, password: 'fixture-owner' }, bytes)
    const owner = (await worker.request({ command: 'selectionGeometry', documentId, pageIndex: 0 })).value
    assert.ok(owner.glyphs.length > 0)
  } finally { await worker.dispose() }
})
