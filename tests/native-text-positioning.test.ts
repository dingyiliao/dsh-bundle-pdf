import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { classicPdf, plainPdf } from './fixtures/plain-pdf.ts'
import { NativeWorker } from '../src/engine/host/native-worker.ts'
import { nativeTestSubprocess } from './native-test-subprocess.ts'
import type { NativeTextContent } from '../src/shared/native.ts'
import { prepareTextSelectionEvidence } from '../src/modules/evidence/selection.ts'
import { createMemoryEvidenceReferenceStore, evidenceSha256 } from '../src/modules/evidence/index.ts'
import type { HostWorkspaceSnapshot } from '../src/modules/working-copy/index.ts'

const executable = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
if (process.env.DSH_PDF_REQUIRE_NATIVE_TESTS === '1' && !existsSync(executable)) throw new Error('Native text tests require a built helper')

test('PDFium supplies each character origin and advance for precise text selection', { skip: !existsSync(executable) }, async () => {
  const drawing = 'BT /F1 24 Tf 32 96 Td (WiWi selection) Tj ET\n'
  const bytes = classicPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>',
    `<< /Length ${drawing.length} >>\nstream\n${drawing}endstream`,
  ])
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    await worker.request({ command: 'open', documentId: 'positioned-text' }, bytes)
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
    const bytes = plainPdf([{ size: [300, 180], lines: [
      { text: 'Hello', x: 32, y: 96, size: 14 },
      { text: 'X', x: 240, y: 24, size: 14 },
    ] }])
    const signal = new AbortController().signal
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
      for (const [quote, x, y, width] of [['Hello', 32, 96, 31.892], ['X', 240, 24, 9.338]] as const) {
        const right = x + width
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
