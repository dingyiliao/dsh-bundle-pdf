import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { NativeWorker } from '../src/engine/native-worker.ts'
import { nativeTestSubprocess } from './native-test-subprocess.ts'
import type { NativeTextContent } from '../src/shared/native.ts'

const executable = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
if (process.env.DSH_PDF_REQUIRE_NATIVE_TESTS === '1' && !existsSync(executable)) throw new Error('Native text tests require a built helper')

test('PDFium supplies each character origin and advance for precise text selection', { skip: !existsSync(executable) }, async () => {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([300, 180])
  const font = await pdf.embedFont(StandardFonts.TimesRoman)
  page.drawText('WiWi selection', { x: 32, y: 96, size: 24, font })
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    await worker.request({ command: 'open', documentId: 'positioned-text' }, await pdf.save())
    const content = (await worker.request({ command: 'text', documentId: 'positioned-text', pageIndex: 0 })).value as NativeTextContent
    const run = content.items.find(item => item.str.includes('WiWi'))
    assert.ok(run, 'PDFium must return the visible text run')
    const glyphs = run.glyphs
    assert.ok(glyphs, 'The selectable layer needs native character positions')
    assert.equal(glyphs.length, Array.from(run.str).length)
    for (const [x, y, advance] of glyphs) {
      assert.ok(Number.isFinite(x) && Number.isFinite(y) && advance > 0)
    }
    assert.ok(glyphs[0][0] < glyphs[1][0])
    assert.ok(glyphs[0][2] > glyphs[1][2], 'Wide and narrow letters retain different native advances')
    assert.ok(Math.abs(glyphs[0][0] + glyphs[0][2] - glyphs[1][0]) < 0.05)
  } finally { await worker.dispose() }
})
