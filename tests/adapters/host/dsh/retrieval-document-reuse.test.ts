import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { materializeFixturePdf, inspectFixturePdf } from '../../../fixtures/native-document.ts'
import { createRetrievalStore } from '../../../../src/adapters/host/filesystem/retrieval-store.ts'
import { createPdfPageContent } from '../../../../src/adapters/host/dsh/page-content.ts'
import { createPdfRetrieval } from '../../../../src/adapters/host/dsh/retrieval.ts'
import { EmbeddingRegistry } from '../../../../src/embedding/index.ts'
import { createMemoryEvidenceReferenceStore, createTextRangeReferences } from '../../../../src/modules/evidence/index.ts'
import { HostOcrService } from '../../../../src/modules/ocr/index.ts'
import { HostImageUnderstandingService } from '../../../../src/modules/image-understanding/index.ts'
import { createRetrievalService } from '../../../../src/modules/retrieval/service.ts'
import type { RetrievalPorts } from '../../../../src/modules/retrieval/types.ts'
import type { HostWorkspaceSnapshot } from '../../../../src/modules/working-copy/index.ts'
import type { PdfWorkingCopyOperation } from '../../../../src/core/pdf-types.ts'
import type { NativeTextContent } from '../../../../src/shared/native.ts'
import { defaultSettings } from '../../../../src/shared/contracts.ts'
import { plainPdf } from '../../../fixtures/plain-pdf.ts'

const signal = new AbortController().signal
const hash = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const sentence = (page: number) => `A needle identifies the original content on page ${page}.`
const nativeText = (text: string): NativeTextContent => ({ items: [{ str: text,
  transform: [10, 0, 0, 10, 20, 200], width: 180, height: 10, dir: 'ltr', fontName: 'Fixture', hasEOL: false }],
styles: {}, lang: null })

async function source(mode: 'native' | 'ocr' | 'image', pageCount: number) {
  return plainPdf(Array.from({ length: pageCount }, (_, index) => ({
    size: [240, 320] as const,
    lines: mode === 'native' ? [{ text: sentence(index + 1), x: 20, y: 200, size: 8 }] : [],
    operators: mode === 'native' ? '' : '20 100 180 100 re S\n',
  })))
}

/** Decode the ASCII text operators emitted by this fixture's Helvetica pages. */
async function fixturePageText(bytes: Uint8Array): Promise<string[]> {
  const source = Buffer.from(bytes).toString('latin1')
  return Array.from(source.matchAll(/\(([^()\r\n]*)\) Tj/g), match => match[1]!)
}

/** Real parsed/saved PDFs and SQLite persistence; deterministic extraction and
 * inference ports measure reuse, rather than OCR or embedding model quality. */
async function fixture(t: TestContext, mode: 'native' | 'ocr' | 'image',
  { pageCount = 2, pagesPerStep }: { pageCount?: number; pagesPerStep?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pdf-content-reuse-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let bytes: Uint8Array = await source(mode, pageCount), document = await inspectFixturePdf(bytes)
  let pageText = mode === 'native' ? await fixturePageText(bytes) : []
  let session = 'first-session', id = 'first-document', path = '/synthetic/reuse.pdf', revision = 0
  const calls = { native: [] as number[], renders: [] as number[], ocr: [] as number[], image: [] as number[],
    documentEmbeddings: [] as string[] }
  const snapshot = (caller: string, documentId: string): HostWorkspaceSnapshot => {
    if (caller !== session || documentId !== id) throw Object.assign(new Error('No current caller authority'), { code: 'pdf/unknown-document' })
    return { id, path, bytes, document, revision, sourceVersion: hash(bytes), contentVersion: `open-${id}`,
      dirty: false, conflict: false, canUndo: false, canRedo: false }
  }
  const pages: Parameters<typeof createPdfPageContent>[1] = {
    async readPageText(caller, documentId, page) {
      calls.native.push(page)
      return { snapshot: snapshot(caller, documentId), content: mode === 'native' ? nativeText(pageText[page - 1]!) : { items: [], styles: {}, lang: null } }
    },
    async renderOcrImage(caller, documentId, page, _region, _edge, _signal, includeWidgets) {
      calls.renders.push(page)
      assert.equal(includeWidgets, false, 'indexing uses the clean body without annotation/widget overlays')
      const current = snapshot(caller, documentId)
      const png = Buffer.alloc(26)
      png.set([137, 80, 78, 71, 13, 10, 26, 10]); png.write('IHDR', 12)
      png.writeUInt32BE(240, 16); png.writeUInt32BE(320, 20)
      png[24] = page; png[25] = current.document.pages[page - 1]!.rotation / 90
      return { snapshot: current, png, width: 240, height: 320, pdfRegion: [0, 0, 240, 320] }
    },
  }
  const settings = { ...defaultSettings, embeddingEngine: 'fixture', ocrEngine: 'fixture-ocr', imageEngine: 'fixture-image',
    indexScanPages: mode === 'ocr', indexImageDescriptions: mode === 'image' }
  let store: ReturnType<typeof createRetrievalStore>, embeddings: EmbeddingRegistry,
    ocr: HostOcrService, image: HostImageUnderstandingService, retrieval: ReturnType<typeof createPdfRetrieval>
  const workspaces = { readSnapshot: snapshot }
  const references = createMemoryEvidenceReferenceStore()
  const evidence = createTextRangeReferences(workspaces, pages, references)
  function start() {
    store = createRetrievalStore({ directory, maxMemoryBytes: 4096 })
    embeddings = new EmbeddingRegistry()
    embeddings.register({ descriptor: { id: 'fixture', name: 'Fixture', version: '1', execution: 'local' },
      describe: () => ({ engineId: 'fixture', engineVersion: '1', model: 'fixture', modelRevision: '1', dimensions: 2,
        maxBatchSize: 16, maxInputCharacters: 1200, encoding: 'fixture', fingerprint: 'stable-embedding-v1' }),
      async embed(request) { if (request.purpose === 'document') calls.documentEmbeddings.push(...request.texts)
        return request.texts.map(() => [1, 0]) } })
    ocr = new HostOcrService(() => 'fixture-ocr')
    ocr.register({ descriptor: { id: 'fixture-ocr', name: 'Fixture OCR', version: '1', execution: 'local',
      capabilities: ['ocr-text'], geometry: [], confidence: false },
      async cacheIdentity() { return 'stable-ocr-v1' }, async availability() { return { status: 'available' } },
      async recognize(request) { const page = new Uint8Array(request.image as Uint8Array)[24]!; calls.ocr.push(page)
        return { text: sentence(page), blocks: [], lines: [], words: [], confidence: null, status: 'complete', coverage: [], warnings: [] } } })
    image = new HostImageUnderstandingService(() => 'fixture-image')
    image.register({ descriptor: { id: 'fixture-image', name: 'Fixture image', version: '1', execution: 'local' },
      async cacheIdentity() { return 'stable-vision-v1' }, async availability() { return { available: true } },
      async understand(request) { const page = request.image.data[24]!; calls.image.push(page)
        return { text: sentence(page), model: 'fixture-vision-v1' } } })
    const content = createPdfPageContent(workspaces, pages, { settings: () => settings, ocr: () => ocr, image: () => image, cache: store })
    retrieval = createPdfRetrieval(workspaces, pages, references, {
      settings: () => settings, embeddings, content, cache: store,
      ...(pagesPerStep !== undefined ? { limits: { pagesPerStep } } : {}),
      async freshSource(caller, documentId) { snapshot(caller, documentId) },
    })
  }
  async function close() { await retrieval.dispose(); ocr.dispose(); image.dispose(); embeddings.dispose(); await store.dispose() }
  start()
  return {
    calls,
    get counts() { return { native: calls.native.length, renders: calls.renders.length, ocr: calls.ocr.length,
      image: calls.image.length, documentEmbeddings: calls.documentEmbeddings.length } },
    get bytes() { return bytes }, get document() { return document }, get session() { return session }, get id() { return id },
    get retrieval() { return retrieval }, snapshot: () => snapshot(session, id),
    readEvidence: (refId: string) => evidence.readEvidence(session, id, refId, signal),
    async reopen() { await close(); session = `session-${++revision}`; id = `document-${revision}`; start() },
    async save(operations: PdfWorkingCopyOperation[]) {
      const oldHash = hash(bytes), oldContent = document.indexContentDigest, oldPages = document.indexPageDigests
      bytes = (await materializeFixturePdf(bytes, operations)).bytes
      document = await inspectFixturePdf(bytes)
      assert.notEqual(hash(bytes), oldHash, 'the test must actually serialize different PDF bytes')
      assert.ok(oldContent, 'real inspection must expose a stable body identity')
      assert.equal(document.indexContentDigest, oldContent, 'annotation/outline saves preserve the real body')
      assert.deepEqual(document.indexPageDigests, oldPages, 'annotation/outline saves preserve every page identity')
    },
    async replace(next: Uint8Array) {
      document = await inspectFixturePdf(next)
      if (mode === 'native') pageText = await fixturePageText(next)
      bytes = next
      revision++
    },
    setPageIdentity(page: number, value: string | null) {
      const pageDigests = document.indexPageDigests?.map((digest, index) => index === page - 1 ? value : digest)
      document = { ...document, ...(pageDigests ? { indexPageDigests: pageDigests } : {}),
        ...(value === null ? { indexContentDigest: undefined } : {}) }
    },
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
    const pageDigests = f.document.indexPageDigests
    assert.ok(pageDigests?.length === 2 && pageDigests.every(digest => typeof digest === 'string'))
    const rotatedPages = Array.from({ length: 2 }, (_, index) => ({ size: [240, 320] as const,
      rotate: index === 0 ? 90 : undefined,
      lines: mode === 'native' ? [{ text: sentence(index + 1), x: 20, y: 200, size: 8 }] : [],
      operators: mode === 'native' ? '' : '20 100 180 100 re S\n' }))
    await f.replace(plainPdf(rotatedPages))
    assert.notEqual(f.document.indexPageDigests?.[0], pageDigests[0])
    assert.equal(f.document.indexPageDigests?.[1], pageDigests[1])
    await f.reopen()
    const before = f.counts
    await f.retrieval.prepare(f.session, { documentId: f.id }, signal)
    assert.deepEqual(f.calls.native.slice(before.native), [1], 'rotation invalidates only the changed page extraction')
    assert.deepEqual(f.calls.renders.slice(before.renders), mode === 'native' ? [] : [1])
    assert.deepEqual(f.calls.ocr.slice(before.ocr), mode === 'ocr' ? [1] : [])
    assert.deepEqual(f.calls.image.slice(before.image), mode === 'image' ? [1] : [])
    assert.equal(f.counts.documentEmbeddings, before.documentEmbeddings, 'rotation preserves the encoded text')
    const changed = await f.retrieval.search(f.session, { documentId: f.id, query: 'needle', mode: 'semantic' }, signal)
    assert.notEqual(changed.indexGeneration, generation)
    f.changePath('/synthetic/another.pdf')
    await f.reopen()
    const movedReads = f.counts.native
    await f.retrieval.prepare(f.session, { documentId: f.id }, signal)
    assert.ok(f.counts.native > movedReads, 'a new canonical path gets its own document index namespace')
  } finally { await f.close() }
})

test('replacing text on two pages reuses the other pages and fences old evidence and search cursors', async t => {
  const f = await fixture(t, 'native', { pageCount: 4, pagesPerStep: 1 })
  try {
    const query = { documentId: f.id, query: 'needle', mode: 'semantic' as const, topK: 4 }
    await f.retrieval.prepare(f.session, { documentId: f.id }, signal)
    const original = await f.retrieval.search(f.session, query, signal)
    assert.equal(original.status, 'complete')
    const oldCandidates = new Map(original.candidates.map(candidate => [candidate.page, candidate]))
    assert.equal(oldCandidates.size, 4)
    assert.equal(oldCandidates.get(2)?.quote, sentence(2))
    assert.equal(oldCandidates.get(4)?.quote, sentence(4))
    const originalDigests = f.document.indexPageDigests
    assert.ok(originalDigests?.length === 4 && originalDigests.every(digest => typeof digest === 'string'))

    const lexicalQuery = { ...query, mode: 'lexical' as const }
    const pending = await f.retrieval.search(f.session, lexicalQuery, signal)
    assert.ok(pending.nextCursor, 'a bounded search must leave a caller-bound continuation')

    const replacements = new Map([[2, 'A replacement needle describes an updated second page.'],
      [4, 'A revised needle points to the new conclusion on the final page.']])
    const replacementPages = Array.from({ length: 4 }, (_, index) => ({ size: [240, 320] as const,
      lines: [{ text: replacements.get(index + 1) ?? sentence(index + 1), x: 20, y: 200, size: 8 }] }))
    await f.replace(plainPdf(replacementPages))
    assert.deepEqual(f.document.indexPageDigests?.map((digest, index) => digest === originalDigests[index]),
      [true, false, true, false], 'the new PDF must actually change just the two edited pages')

    const before = f.counts
    await assert.rejects(f.retrieval.search(f.session, { ...lexicalQuery, cursor: pending.nextCursor }, signal), { code: 'pdf/stale-reader' })
    assert.deepEqual(f.counts, before, 'an obsolete cursor cannot start new extraction or inference')
    await f.retrieval.prepare(f.session, { documentId: f.id }, signal)
    assert.deepEqual(f.calls.native.slice(before.native), [2, 4])
    assert.deepEqual(f.calls.documentEmbeddings.slice(before.documentEmbeddings), [...replacements.values()])
    assert.equal(f.counts.renders, before.renders)
    assert.equal(f.counts.ocr, before.ocr)
    assert.equal(f.counts.image, before.image)

    for (const page of replacements.keys()) {
      await assert.rejects(f.readEvidence(oldCandidates.get(page)!.evidence.refId), { code: 'pdf/stale-reader' })
    }
    const rebound = await f.readEvidence(oldCandidates.get(1)!.evidence.refId)
    assert.equal(rebound.revalidated, true)
    assert.equal(rebound.pages[0]?.snapshot.text, sentence(1))
    assert.equal(rebound.pages[0]?.sourceDigest, hash(f.bytes))

    const updated = await f.retrieval.search(f.session, query, signal)
    assert.equal(updated.status, 'complete')
    assert.notEqual(updated.indexGeneration, original.indexGeneration)
    assert.deepEqual(new Map(updated.candidates.map(candidate => [candidate.page, candidate.quote])),
      new Map([[1, sentence(1)], [2, replacements.get(2)!], [3, sentence(3)], [4, replacements.get(4)!]]))
    for (const candidate of updated.candidates) {
      assert.equal(candidate.evidence.sourceDigest, hash(f.bytes))
      assert.notEqual(candidate.evidence.refId, oldCandidates.get(candidate.page)!.evidence.refId)
      assert.ok('text' in candidate.evidence.snapshot, 'native evidence must carry literal page text')
      assert.equal(candidate.evidence.snapshot.text, candidate.quote)
    }
  } finally { await f.close() }
})

test('a page without a reliable identity follows the source bytes while proven pages can still be reused', async t => {
  const f = await fixture(t, 'native', { pageCount: 3 })
  try {
    const original = plainPdf(Array.from({ length: 3 }, (_, index) => ({ size: [240, 320] as const,
      lines: [{ text: sentence(index + 1), x: 20, y: 200, size: 8 }] })))
    await f.replace(original)
    assert.ok(f.document.indexContentDigest)
    assert.deepEqual(f.document.indexPageDigests?.map(Boolean), [true, true, true])
    await f.retrieval.prepare(f.session, { documentId: f.id }, signal)

    const edited = plainPdf(Array.from({ length: 3 }, (_, index) => ({ size: [240, 320] as const,
      lines: [{ text: index === 2 ? 'A newly indexed needle sentence.' : sentence(index + 1), x: 20, y: 200, size: 8 }] })))
    await f.replace(edited)
    f.setPageIdentity(3, null)
    assert.deepEqual(f.document.indexPageDigests?.map(Boolean), [true, true, false])
    await f.reopen()
    const before = f.counts
    await f.retrieval.prepare(f.session, { documentId: f.id }, signal)
    assert.deepEqual(f.calls.native.slice(before.native), [3], 'revisit only the changed page while reusing unchanged pages')
    assert.equal(f.counts.documentEmbeddings, before.documentEmbeddings + 1, 'the uncertain page still reuses its unchanged text vector')
    assert.match(f.calls.documentEmbeddings.at(-1)!, /A newly indexed needle sentence/)
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
