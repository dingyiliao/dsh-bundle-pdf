import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { createPdfPageContent } from '../src/adapters/host/dsh/page-content.ts'
import { createPdfRetrieval } from '../src/adapters/host/dsh/retrieval.ts'
import { createLocalTesseractOcrBackend } from '../src/adapters/host/ocr/local-backend.ts'
import { createLocalTextRecovery } from '../src/adapters/host/ocr/local-text-recovery.ts'
import { createPdfService } from '../src/adapters/host/pdfium/pdf-service.ts'
import { EmbeddingRegistry } from '../src/embedding/index.ts'
import { createMemoryEvidenceReferenceStore, evidenceSha256 } from '../src/modules/evidence/index.ts'
import { HostOcrService } from '../src/modules/ocr/index.ts'
import { defaultSettings } from '../src/shared/contracts.ts'
import { memoryWorkspace } from './native-fixture.ts'
import { NativeTestSubprocess } from './native-test-subprocess.ts'

const executable = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
const localAssets = ['text-recovery.mjs', 'core/tesseract-core-lstm.js', 'lang/eng.traineddata.gz', 'lang/chi_sim.traineddata.gz']
const available = existsSync(executable) && localAssets.every(path => existsSync(resolve('dist/assets/ocr', path)))
if (process.env.DSH_PDF_REQUIRE_NATIVE_TESTS === '1' && !available) {
  throw new Error('Native page-content tests require the built native helper and bundled local OCR assets')
}
const signal = new AbortController().signal

/** Only synthetic text is rasterized; the actual fixture PDF contains a PNG and no text objects. */
async function scannedFixture(): Promise<Uint8Array> {
  const source = await PDFDocument.create(), font = await source.embedFont(StandardFonts.HelveticaBold)
  const page = source.addPage([400, 200])
  page.drawText('SCANNED ORCHARD', { x: 32, y: 120, size: 28, font })
  page.drawText('Synthetic local OCR fixture', { x: 32, y: 70, size: 17, font })
  const state = memoryWorkspace(await source.save())
  const pdf = createPdfService(state.workspaces, { executable, subprocess: new NativeTestSubprocess() })
  const sessionId = 'rasterize-synthetic-page', agent = { session: { id: sessionId, header: {} } }
  try {
    const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
      address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal)
    assert.ok('bytes' in opened)
    const rendered = await pdf.renderOcrImage(sessionId, opened.id, 1, undefined, 1024, signal, false)
    const scanned = await PDFDocument.create(), image = await scanned.embedPng(rendered.png)
    scanned.addPage([400, 200]).drawImage(image, { x: 0, y: 0, width: 400, height: 200 })
    return scanned.save({ useObjectStreams: false })
  } finally { await pdf.dispose(); await state.workspaces.dispose() }
}

test('real image-only PDF becomes local OCR page content, searchable evidence and a reusable persistent cache',
  { skip: !available, timeout: 120_000 }, async () => {
    const bytes = await scannedFixture(), persisted = new Map<string, unknown>()
    const cache = { async get(key: string) { return structuredClone(persisted.get(key)) },
      async set(key: string, value: unknown) { persisted.set(key, structuredClone(value)) } }
    let recognitions = 0
    async function openAndSearch(reopened: boolean) {
      const state = memoryWorkspace(bytes), local = createLocalTextRecovery()
      const pdf = createPdfService(state.workspaces, { executable, subprocess: new NativeTestSubprocess() })
      const sessionId = reopened ? 'scanned-page-reopened' : 'scanned-page-first-open'
      const agent = { session: { id: sessionId, header: {} } }
      const settings = { ...defaultSettings, ocrEngine: 'local-tesseract', embeddingEngine: 'fixture-embedding',
        indexScanPages: true, indexImageDescriptions: false }
      const ocr = new HostOcrService(() => settings.ocrEngine), backend = createLocalTesseractOcrBackend(local)
      const unregister = ocr.register({ ...backend, async recognize(request, config) {
        recognitions++
        assert.equal(reopened, false, 'a stable local producer must reuse persisted content after service restart')
        return backend.recognize(request, config)
      } })
      let renders = 0
      const pages = { ...pdf, async renderOcrImage(...args: Parameters<typeof pdf.renderOcrImage>) {
        renders++; return pdf.renderOcrImage(...args)
      } }
      const content = createPdfPageContent(state.workspaces, pages, { cache, settings: () => settings,
        ocr: () => ocr, image: () => undefined })
      const references = createMemoryEvidenceReferenceStore(), embeddings = new EmbeddingRegistry()
      let queryVectors = 0
      embeddings.register({ descriptor: { id: 'fixture-embedding', name: 'Synthetic test vectors', version: '1', execution: 'local' },
        describe: () => ({ engineId: 'fixture-embedding', engineVersion: '1', model: 'synthetic-fixture', modelRevision: '1',
          dimensions: 2, maxBatchSize: 16, maxInputCharacters: 1200, encoding: 'fixture', fingerprint: 'synthetic-page-content-v1' }),
        async availability() { return { status: 'available' } },
        async embed(request) { request.signal?.throwIfAborted(); if (request.purpose === 'query') queryVectors++
          return request.texts.map(() => [1, 0]) },
      })
      const retrieval = createPdfRetrieval(state.workspaces, pages, references, { cache, embeddings, content,
        settings: () => settings,
        retain: (session, id, active) => state.workspaces.acquire(session, id, agent, active) })
      try {
        const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
          address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal)
        assert.ok('bytes' in opened)
        const native = await pdf.readPageText(sessionId, opened.id, 1, signal, { recover: false })
        assert.deepEqual(native.content.items, [], 'the source has no hidden native text for retrieval to exploit')
        await content.prepare(sessionId, signal)
        const page = await content.read(sessionId, opened.id, 1, signal)
        assert.equal(page.nativeText.text, '')
        const recognized = page.blocks.flatMap(block => block.representations).find(rep => rep.kind === 'ocr-text')
        assert.ok(recognized)
        assert.match(recognized.text, /SCANNED\s+ORCHARD/iu)
        assert.equal(recognized.producer.id, 'local-tesseract')
        assert.equal(recognized.digest, evidenceSha256(recognized.text))
        assert.match(recognized.inputDigest!, /^sha256:[a-f0-9]{64}$/)
        assert.ok(recognized.spans?.length, 'real Tesseract words retain PDF-space source geometry')
        for (const span of recognized.spans) {
          assert.ok(span.rectPdf[0] >= 0 && span.rectPdf[1] >= 0 && span.rectPdf[2] <= 400 && span.rectPdf[3] <= 200)
          assert.ok(span.endUtf16 > span.startUtf16)
        }
        for (const mode of ['lexical', 'semantic'] as const) {
          const result = await retrieval.search(sessionId, { documentId: opened.id, query: 'orchard', mode }, signal)
          assert.equal(result.status, 'complete')
          assert.equal(result.effectiveMode, mode)
          assert.deepEqual(result.coverage.failedPages, [])
          assert.deepEqual(result.coverage.ocrPages, [1])
          const hit = result.candidates.find(candidate => /orchard/iu.test(candidate.quote))
          assert.ok(hit, `${mode} retrieval finds real recognized text`)
          assert.equal(hit.source, 'ocr-text')
          assert.equal(hit.annotationStatus, 'unavailable')
          assert.equal(hit.evidence.source, 'ocr-text')
          assert.equal(hit.evidence.precision, 'approximate-geometry')
          assert.equal(hit.evidence.locator.kind, 'pdf-region')
          assert.equal(hit.evidence.snapshot.text, hit.quote)
          assert.equal(hit.evidence.snapshot.sha256, evidenceSha256(hit.quote))
          assert.equal(references.get(hit.evidence.refId)?.sessionId, sessionId)
        }
        assert.ok(queryVectors > 0, 'semantic search really traverses the fake embedding registry')
        assert.equal(renders, reopened ? 0 : 1)
        assert.equal(state.writes(), 0)
        assert.deepEqual(state.current(), bytes)
        return recognized
      } finally {
        await retrieval.dispose()
        unregister(); ocr.dispose(); embeddings.dispose()
        await local.dispose(); await pdf.dispose(); await state.workspaces.dispose()
      }
    }
    const first = await openAndSearch(false)
    assert.equal(recognitions, 1)
    assert.ok([...persisted.keys()].some(key => key.startsWith('pagecontent_')))
    const reopened = await openAndSearch(true)
    assert.deepEqual(reopened, first, 'a fresh service and Session reuse the identical validated representation')
    assert.equal(recognitions, 1, 'cache rehydration must not run recognition again')
  })
