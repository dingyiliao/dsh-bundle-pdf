import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { decodeFormFields, encodeFormEdits } from '../../../src/adapters/host/pdfium/document-forms.ts'
import { NativeWorker } from '../../../src/engine/host/native-worker.ts'
import { classicPdf } from '../../fixtures/plain-pdf.ts'
import { nativeTestSubprocess } from '../../native-test-subprocess.ts'

const executable = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
const skip = !existsSync(executable)
if (skip && process.env.DSH_PDF_REQUIRE_NATIVE_EXTENSIONS === '1') throw new Error('Native form tests require the PDFium helper')

function unicodeForm() {
  return classicPdf([
    '<< /Type /Catalog /Pages 2 0 R /AcroForm 5 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 160] /Annots [6 0 R 7 0 R 8 0 R] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Fields [6 0 R 7 0 R 8 0 R] /DR << /Font << /Helv 4 0 R >> >> /DA (/Helv 18 Tf 0 g) >>',
    '<< /Type /Annot /Subtype /Widget /FT /Tx /T (Name) /F 4 /Rect [12 108 228 147] /P 3 0 R >>',
    '<< /Type /Annot /Subtype /Widget /FT /Ch /Ff 131072 /T (Choice) /F 4 /Rect [12 59 228 98] /P 3 0 R /Opt [(First) [(city) <FEFF57CE5E02>]] >>',
    '<< /Type /Annot /Subtype /Widget /FT /Ch /T (List) /F 4 /Rect [12 10 228 49] /P 3 0 R /Opt [<FEFF5B6653F7> (First)] >>',
  ])
}

test('native form writes embed portable Unicode appearances for text and choices', { skip }, async t => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    await worker.ready()
    if (!worker.documentExtensions && process.env.DSH_PDF_REQUIRE_NATIVE_EXTENSIONS !== '1') {
      return t.skip('Native helper does not expose PDFium extensions')
    }
    assert.equal(worker.documentExtensions, true)
    const documentId = 'native-form-unicode'
    await worker.request({ command: 'open', documentId }, unicodeForm())
    const read = async () => decodeFormFields((await worker.request({ command: 'formFields', documentId })).value.fields)
    const render = async (forms: boolean) => (await worker.request({ command: 'render', documentId,
      pageIndex: 0, rotation: 0, rasterWidth: 240, rasterHeight: 160, x: 0, y: 0, width: 240, height: 160,
      annotations: false, forms,
    })).bytes
    const fields = await read()
    const edits = encodeFormEdits(fields, [
      { type: 'set-field', name: 'Name', value: 'A中文BéZ𠮷R' },
      { type: 'set-field', name: 'Choice', value: '城市' },
      { type: 'set-field', name: 'List', value: ['学号'] },
    ])
    await assert.rejects(worker.request({ command: 'applyFormFields', documentId, edits }), { code: 'pdf/native-form' })
    assert.deepEqual(await read(), fields)

    const font = await readFile(new URL('../../../assets/fonts/NotoSansCJKsc-Regular.otf', import.meta.url))
    await worker.request({ command: 'applyFormFields', documentId, edits }, font)
    const { size } = (await worker.request({ command: 'saveCopy', documentId })).value
    const { bytes } = await worker.request({ command: 'saveChunk', documentId, offset: 0, length: size })
    assert.match(Buffer.from(bytes).toString('latin1'), /\/Subtype\s*\/CIDFontType0C/)
    assert.ok(bytes.length < font.length / 10, 'The PDF embeds a subset of the font')
    await worker.request({ command: 'close', documentId })
    await worker.request({ command: 'open', documentId }, bytes)
    assert.deepEqual(Object.fromEntries((await read()).map(field => [field.name, field.value])), {
      Name: 'A中文BéZ𠮷R', Choice: ['城市'], List: ['学号'],
    })

    const withForms = await render(true)
    const withoutForms = await render(false)
    const visibleChanges = (left: number, top: number, right: number, bottom: number) => {
      let changes = 0
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const offset = (y * 240 + x) * 4
          if (withForms[offset] !== withoutForms[offset]) changes++
        }
      }
      return changes
    }
    assert.ok(visibleChanges(26, 23, 60, 47) > 100, 'Chinese glyphs are visible after reopening')
    assert.ok(visibleChanges(61, 23, 96, 47) > 80, 'ASCII and accented glyphs following Chinese are visible')
    assert.ok(visibleChanges(96, 23, 124, 47) > 80, 'A supplementary CJK glyph is visible')
    assert.ok(visibleChanges(14, 72, 50, 96) > 90, 'The dropdown label is visible')
    let light = 0
    let dark = 0
    for (let y = 117; y < 133; y++) {
      for (let x = 14; x < 47; x++) {
        const red = withForms[(y * 240 + x) * 4]!
        if (red > 240) light++
        if (red < 100) dark++
      }
    }
    assert.ok(light > 20 && dark > 100, 'The list label is visible on its selected background')
  } finally {
    await worker.dispose()
  }
})
