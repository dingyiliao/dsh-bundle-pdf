import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { NativeWorker } from '../src/adapters/host/pdfium/native-worker.ts'
import { nativeTestSubprocess } from './native-test-subprocess.ts'
import type { NativeTextContent } from '../src/shared/native.ts'
import { prepareTextSelectionEvidence } from '../src/modules/evidence/selection.ts'
import { createMemoryEvidenceReferenceStore, evidenceSha256 } from '../src/modules/evidence/index.ts'
import type { HostWorkspaceSnapshot } from '../src/modules/working-copy/index.ts'

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

test('real PDFium text reaches Host selection evidence with both ordinary and single-character objects',
  { skip: !existsSync(executable) }, async () => {
    const pdf = await PDFDocument.create(), page = pdf.addPage([300, 180])
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    page.drawText('Hello', { x: 32, y: 96, size: 14, font })
    page.drawText('X', { x: 240, y: 24, size: 14, font })
    const bytes = await pdf.save(), signal = new AbortController().signal
    const snapshot = { id: 'selection-document', path: '/fixtures/selection.pdf', bytes,
      sourceVersion: 'source-1', contentVersion: 'content-1', revision: 0,
      document: { pageCount: 1, pages: [{ page: 1, cropBox: [0, 0, 300, 180], rotation: 0, userUnit: 1 }] },
    } as HostWorkspaceSnapshot
    const worker = new NativeWorker(executable, nativeTestSubprocess)
    try {
      await worker.request({ command: 'open', documentId: snapshot.id }, bytes)
      const content = (await worker.request({ command: 'text', documentId: snapshot.id, pageIndex: 0 })).value as NativeTextContent
      const single = content.items.find(item => item.str === 'X')!
      assert.ok(single, 'the page must contain the unrelated single-character text object')
      assert.equal(single.glyphs?.length, 1, 'single-character objects must expose the same glyph contract')
      const references = createMemoryEvidenceReferenceStore()
      for (const [quote, x, y] of [['Hello', 32, 96], ['X', 240, 24]] as const) {
        const right = x + font.widthOfTextAtSize(quote, 14)
        const rect: [number, number, number, number] = [x - 1, y - 3, right + 1, y + 12]
        const result = await prepareTextSelectionEvidence({ readSnapshot: () => snapshot },
          { async readPageText() { return { snapshot, content } } }, references,
          { sessionId: 'session-1', documentId: snapshot.id, expectedRevision: 0,
            expectedContentVersion: snapshot.contentVersion, quote,
            fragments: [{ page: 1, rect, quadPoints: [rect[0], rect[3], rect[2], rect[3], rect[0], rect[1], rect[2], rect[1]] }] },
          signal, async () => ({ path: snapshot.path, digest: evidenceSha256(bytes) }))
        assert.equal(result.text, quote)
        const saved = references.get(result.excerpts[0]!.refId)?.evidence
        assert.ok(saved?.source === 'pdf-text')
        assert.equal(saved.snapshot.text, quote)
      }
    } finally { await worker.dispose() }
  })
