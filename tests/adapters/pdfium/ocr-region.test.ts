import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import { createPdfService } from '../../../src/adapters/host/pdfium/index.ts'
import { nativeTestSubprocess } from '../../native-test-subprocess.ts'
import { memoryWorkspace, nativeFixture } from '../../native-fixture.ts'

const executable = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
if (process.env.DSH_PDF_REQUIRE_NATIVE_TESTS === '1' && !existsSync(executable)) throw new Error('Native tests require a built helper')

/** `encodePng` writes unfiltered RGBA scanlines; sample the actual native-rendered crop. */
function centerPixel(png: Uint8Array): number[] {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  const view = Buffer.from(png)
  let offset = 8, width = 0, height = 0
  const imageData: Buffer[] = []
  while (offset + 12 <= png.length) {
    const length = view.readUInt32BE(offset), kind = view.toString('ascii', offset + 4, offset + 8)
    if (kind === 'IHDR') { width = view.readUInt32BE(offset + 8); height = view.readUInt32BE(offset + 12) }
    if (kind === 'IDAT') imageData.push(view.subarray(offset + 8, offset + 8 + length))
    offset += length + 12
    if (kind === 'IEND') break
  }
  assert.ok(width > 0 && height > 0)
  const scanlines = inflateSync(Buffer.concat(imageData))
  const y = Math.floor(height / 2), x = Math.floor(width / 2)
  const rowStart = y * (width * 4 + 1)
  assert.equal(scanlines[rowStart], 0)
  return [...scanlines.subarray(rowStart + 1 + x * 4, rowStart + 1 + x * 4 + 3)]
}

test('native OCR region crops preserve PDF coordinates through crop, rotation, and UserUnit',
  { skip: !existsSync(executable) }, async () => {
    const state = memoryWorkspace(await nativeFixture())
    const pdf = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess })
    const sessionId = 'ocr-region'
    const signal = new AbortController().signal
    try {
      const opened = await pdf.dispatch(sessionId, { action: 'open', sessionId,
        address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` },
      { session: { id: sessionId, header: {} } }, signal) as { id: string }
      for (const page of [1, 2, 3, 4]) {
        const red = await pdf.renderOcrImage(sessionId, opened.id, page, [50, 70, 120, 120], 1024, signal)
        const blue = await pdf.renderOcrImage(sessionId, opened.id, page, [180, 240, 240, 300], 1024, signal)
        assert.deepEqual(red.pdfRegion, [50, 70, 120, 120])
        assert.deepEqual(blue.pdfRegion, [180, 240, 240, 300])
        assert.deepEqual(centerPixel(red.png), [255, 0, 0], `red page ${page}`)
        assert.deepEqual(centerPixel(blue.png), [0, 0, 255], `blue page ${page}`)
      }
    } finally { await pdf.dispose(); await state.workspaces.dispose() }
  })
