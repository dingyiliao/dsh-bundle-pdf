import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { PDFDocument, degrees } from 'pdf-lib'
import { applyPdfOperations, loadPdfDocument } from '../../../../src/adapters/host/pdf-lib/pdf-document.ts'
import { createRetrievalStore } from '../../../../src/adapters/host/filesystem/retrieval-store.ts'
import { createPdfPageContent } from '../../../../src/adapters/host/dsh/page-content.ts'
import { createPdfRetrieval } from '../../../../src/adapters/host/dsh/retrieval.ts'
import { EmbeddingRegistry } from '../../../../src/embedding/index.ts'
import { createMemoryEvidenceReferenceStore } from '../../../../src/modules/evidence/index.ts'
import { HostOcrService } from '../../../../src/modules/ocr/index.ts'
import { HostImageUnderstandingService } from '../../../../src/modules/image-understanding/index.ts'
import { createRetrievalService } from '../../../../src/modules/retrieval/service.ts'
import type { RetrievalPorts } from '../../../../src/modules/retrieval/types.ts'
import type { HostWorkspaceSnapshot } from '../../../../src/modules/working-copy/index.ts'
import type { PdfWorkingCopyOperation } from '../../../../src/core/pdf-types.ts'
import type { NativeTextContent } from '../../../../src/shared/native.ts'
import { defaultSettings } from '../../../../src/shared/contracts.ts'

const signal = new AbortController().signal
const hash = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const sentence = (page: number) => `A needle identifies the original content on page ${page}.`
const nativeText = (page: number): NativeTextContent => ({ items: [{ str: sentence(page),
  transform: [10, 0, 0, 10, 20, 200], width: 180, height: 10, dir: 'ltr', fontName: 'Fixture', hasEOL: false }],
styles: {}, lang: null })

async function source(mode: 'native' | 'ocr' | 'image') {
  const doc = await PDFDocument.create()
  for (let page = 1; page <= 2; page++) {
    const sheet = doc.addPage([240, 320])
    if (mode === 'native') sheet.drawText(sentence(page), { x: 20, y: 200, size: 8 })
    else sheet.drawRectangle({ x: 20, y: 100, width: 180, height: 100, borderWidth: 2 })
  }
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false })
}

/** Real parsed/saved PDFs and SQLite persistence; deterministic extraction and
 * inference ports measure reuse, rather than OCR or embedding model quality. */
async function fixture(t: TestContext, mode: 'native' | 'ocr' | 'image') {
  const directory = await mkdtemp(join(tmpdir(), 'pdf-content-reuse-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let bytes: Uint8Array = await source(mode), document = await loadPdfDocument(bytes)
  let session = 'first-session', id = 'first-document', path = '/synthetic/reuse.pdf', revision = 0
  const counts = { native: 0, renders: 0, ocr: 0, image: 0, documentEmbeddings: 0 }
  const snapshot = (caller: string, documentId: string): HostWorkspaceSnapshot => {
    if (caller !== session || documentId !== id) throw Object.assign(new Error('No current caller authority'), { code: 'pdf/unknown-document' })
    return { id, path, bytes, document, revision, sourceVersion: hash(bytes), contentVersion: `open-${id}`,
      dirty: false, conflict: false, canUndo: false, canRedo: false }
  }
  const pages: Parameters<typeof createPdfPageContent>[1] = {
    async readPageText(caller, documentId, page) {
      counts.native++
      return { snapshot: snapshot(caller, documentId), content: mode === 'native' ? nativeText(page) : { items: [], styles: {}, lang: null } }
    },
    async renderOcrImage(caller, documentId, page, _region, _edge, _signal, includeWidgets) {
      counts.renders++
      assert.equal(includeWidgets, false, 'indexing uses the clean body without annotation/widget overlays')
      const png = Buffer.alloc(25)
      png.set([137, 80, 78, 71, 13, 10, 26, 10]); png.write('IHDR', 12)
      png.writeUInt32BE(240, 16); png.writeUInt32BE(320, 20); png[24] = page
      return { snapshot: snapshot(caller, documentId), png, width: 240, height: 320, pdfRegion: [0, 0, 240, 320] }
    },
  }
  const settings = { ...defaultSettings, embeddingEngine: 'fixture', ocrEngine: 'fixture-ocr', imageEngine: 'fixture-image',
    indexScanPages: mode === 'ocr', indexImageDescriptions: mode === 'image' }
  let store: ReturnType<typeof createRetrievalStore>, embeddings: EmbeddingRegistry,
    ocr: HostOcrService, image: HostImageUnderstandingService, retrieval: ReturnType<typeof createPdfRetrieval>
  function start() {
    store = createRetrievalStore({ directory, maxMemoryBytes: 4096 })
    embeddings = new EmbeddingRegistry()
    embeddings.register({ descriptor: { id: 'fixture', name: 'Fixture', version: '1', execution: 'local' },
      describe: () => ({ engineId: 'fixture', engineVersion: '1', model: 'fixture', modelRevision: '1', dimensions: 2,
        maxBatchSize: 16, maxInputCharacters: 1200, encoding: 'fixture', fingerprint: 'stable-embedding-v1' }),
      async embed(request) { if (request.purpose === 'document') counts.documentEmbeddings += request.texts.length
        return request.texts.map(() => [1, 0]) } })
    ocr = new HostOcrService(() => 'fixture-ocr')
    ocr.register({ descriptor: { id: 'fixture-ocr', name: 'Fixture OCR', version: '1', execution: 'local',
      capabilities: ['ocr-text'], geometry: [], confidence: false },
      async cacheIdentity() { return 'stable-ocr-v1' }, async availability() { return { status: 'available' } },
      async recognize(request) { counts.ocr++; const page = new Uint8Array(request.image as Uint8Array)[24]!
        return { text: sentence(page), blocks: [], lines: [], words: [], confidence: null, status: 'complete', coverage: [], warnings: [] } } })
    image = new HostImageUnderstandingService(() => 'fixture-image')
    image.register({ descriptor: { id: 'fixture-image', name: 'Fixture image', version: '1', execution: 'local' },
      async cacheIdentity() { return 'stable-vision-v1' }, async availability() { return { available: true } },
      async understand(request) { counts.image++; return { text: sentence(request.image.data[24]!), model: 'fixture-vision-v1' } } })
    const workspaces = { readSnapshot: snapshot }
    const content = createPdfPageContent(workspaces, pages, { settings: () => settings, ocr: () => ocr, image: () => image, cache: store })
    retrieval = createPdfRetrieval(workspaces, pages, createMemoryEvidenceReferenceStore(), {
      settings: () => settings, embeddings, content, cache: store,
      async freshSource(caller, documentId) { snapshot(caller, documentId) },
    })
  }
  async function close() { await retrieval.dispose(); ocr.dispose(); image.dispose(); embeddings.dispose(); await store.dispose() }
  start()
  return {
    counts, get bytes() { return bytes }, get document() { return document }, get session() { return session }, get id() { return id },
    get retrieval() { return retrieval }, snapshot: () => snapshot(session, id),
    async reopen() { await close(); session = `session-${++revision}`; id = `document-${revision}`; start() },
    async save(operations: PdfWorkingCopyOperation[]) {
      const oldHash = hash(bytes), oldContent = document.indexContentDigest
      bytes = (await applyPdfOperations(bytes, operations)).bytes
      document = await loadPdfDocument(bytes)
      assert.notEqual(hash(bytes), oldHash, 'the test must actually serialize different PDF bytes')
      assert.ok(oldContent, 'real inspection must expose a stable body identity')
      assert.equal(document.indexContentDigest, oldContent, 'annotation/outline saves preserve the real body')
    },
    async replace(next: Uint8Array) { bytes = next; document = await loadPdfDocument(bytes) },
    changePath(next: string) { path = next }, close,
  }
}

const edits: PdfWorkingCopyOperation[][] = [
  [{ type: 'add', annotation: { id: 'highlight', page: 1, subtype: 'Highlight', rect: [20, 190, 200, 210],
    quadPoints: [20, 210, 200, 210, 20, 190, 200, 190], color: [1, 1, 0] } }],
  [{ type: 'update', id: 'highlight', patch: { color: [0, 1, 0], contents: 'A comment attached to the mark' } }],
  [{ type: 'add', annotation: { id: 'reply', replyToId: 'highlight', page: 1, subtype: 'Text', rect: [20, 190, 21, 191],
    contents: 'Another reader reply', author: 'Fixture' } }],
  [{ type: 'add', annotation: { id: 'note', page: 2, subtype: 'Text', rect: [40, 40, 100, 100],
    contents: 'A movable note', color: [1, 0.8, 0] } }],
  [{ type: 'update', id: 'note', patch: { rect: [60, 60, 120, 120], color: [0.4, 0.8, 1], contents: 'Updated note' } }],
  [{ type: 'outline-add', id: 'chapter', title: 'Reading bookmark', page: 1 },
    { type: 'outline-add', id: 'section', parentId: 'chapter', title: 'Nested bookmark', page: 2 }],
  [{ type: 'outline-update', id: 'section', patch: { title: 'Renamed bookmark', page: 1 } }],
  [{ type: 'delete', id: 'reply' }, { type: 'delete', id: 'note' }, { type: 'outline-delete', id: 'chapter' }],
  [{ type: 'delete', id: 'highlight' }],
]

for (const mode of ['native', 'ocr', 'image'] as const) test(`${mode} index survives real annotation saves, new sessions and closed/reopened SQLite stores without repeating completed work`, async t => {
  const f = await fixture(t, mode)
  try {
    await f.retrieval.prepare(f.session, { documentId: f.id }, signal)
    const initial = await f.retrieval.search(f.session, { documentId: f.id, query: 'needle', mode: 'semantic' }, signal)
    assert.equal(initial.status, 'complete'); assert.ok(initial.candidates.length)
    const generation = initial.indexGeneration
    for (const operation of edits) {
      await f.save(operation)
      await f.reopen()
      const before = { ...f.counts }
      await f.retrieval.prepare(f.session, { documentId: f.id }, signal)
      assert.deepEqual(f.counts, before, 'restoring a ready index must not extract, render, OCR, describe or recompute document vectors')
      const found = await f.retrieval.search(f.session, { documentId: f.id, query: 'needle', mode: 'semantic' }, signal)
      assert.equal(found.indexGeneration, generation)
      assert.equal(found.sourceDigest, hash(f.bytes), 'search returns current bytes, never the cached old file digest')
      assert.equal(found.documentId, f.id)
      assert.ok(found.candidates.every(candidate => candidate.evidence.sourceDigest === hash(f.bytes)))
      assert.equal(f.counts.ocr, before.ocr); assert.equal(f.counts.image, before.image)
      assert.equal(f.counts.documentEmbeddings, before.documentEmbeddings)
    }
    const parsed = await PDFDocument.load(f.bytes)
    parsed.getPage(0).setRotation(degrees(90))
    await f.replace(await parsed.save({ useObjectStreams: false, updateFieldAppearances: false }))
    await f.reopen()
    const reads = f.counts.native
    await f.retrieval.prepare(f.session, { documentId: f.id }, signal)
    const changed = await f.retrieval.search(f.session, { documentId: f.id, query: 'needle', mode: 'semantic' }, signal)
    assert.notEqual(changed.indexGeneration, generation)
    assert.ok(f.counts.native > reads, 'actual page geometry changes invalidate cached extraction')
    f.changePath('/synthetic/another.pdf')
    await f.reopen()
    const movedReads = f.counts.native
    await f.retrieval.prepare(f.session, { documentId: f.id }, signal)
    assert.ok(f.counts.native > movedReads, 'a new canonical path gets its own document index namespace')
  } finally { await f.close() }
})

test('body-index reuse does not make pre-save results and continuation cursors valid for new source bytes', async t => {
  const f = await fixture(t, 'native')
  const document = () => { const current = f.snapshot(); return { id: current.id, path: current.path,
    sourceDigest: hash(current.bytes), contentVersion: current.contentVersion, pageCount: current.document.pageCount,
    indexContentDigest: current.document.indexContentDigest } }
  const ports: RetrievalPorts = { documents: { snapshot: document },
    pages: { async read(_session, _id, page) { return { text: sentence(page), source: 'pdf-text' } } },
    limits: { pagesPerStep: 1, embeddingBatchesPerStep: 1 } }
  const core = createRetrievalService(ports)
  try {
    const before = await core.search(f.session, { documentId: f.id, query: 'needle', mode: 'lexical' })
    assert.ok(before.nextCursor, 'this scenario must retain an incomplete continuation cursor')
    await f.save(edits[0]!)
    assert.throws(() => core.validate(f.session, before), { code: 'pdf/stale-reader' })
    await assert.rejects(core.search(f.session, { documentId: f.id, query: 'needle', mode: 'lexical', cursor: before.nextCursor }),
      { code: 'pdf/stale-reader' })
    const current = await core.search(f.session, { documentId: f.id, query: 'needle', mode: 'lexical' })
    assert.equal(current.indexGeneration, before.indexGeneration, 'the index is still reusable while caller-bound cursors expire')
    assert.equal(current.document.sourceDigest, hash(f.bytes))
  } finally { await core.dispose(); await f.close() }
})
