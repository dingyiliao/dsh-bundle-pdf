import assert from 'node:assert/strict'
import test from 'node:test'
import { createPdfPageContent, type PdfPageContent } from '../../../../src/adapters/host/dsh/page-content.ts'
import { createPdfRetrieval } from '../../../../src/adapters/host/dsh/retrieval.ts'
import { EmbeddingRegistry } from '../../../../src/embedding/index.ts'
import { createMemoryEvidenceReferenceStore, evidenceSha256, type SavedReference } from '../../../../src/modules/evidence/index.ts'
import { createPageRepresentation, type PageContent } from '../../../../src/modules/document/index.ts'
import { HostOcrService } from '../../../../src/modules/ocr/index.ts'
import { HostImageUnderstandingService, type ImageUnderstandingBackend } from '../../../../src/modules/image-understanding/index.ts'
import type { HostWorkspaceSnapshot } from '../../../../src/modules/working-copy/index.ts'
import type { NativeTextContent } from '../../../../src/shared/native.ts'
import { defaultSettings, type PdfSettings } from '../../../../src/shared/contracts.ts'

const signal = new AbortController().signal
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
function fixture(options: { scan?: boolean; describe?: boolean; imageEngine?: string; invalidImageOutput?: boolean } = {}) {
  const state = { native: 'Prefix nativekeyword exact native evidence.', ocr: 'ocrkeyword recognized words',
    description: 'visionkeyword marks a rising chart.', visionModel: 'vision-revision-one', nativeReads: [] as number[],
    renders: [] as number[], recognitions: 0, descriptions: 0,
    contentReads: new Map<number, number>(), pins: 0, denied: false, imageFailure: false, diskChanged: false, freshChecks: 0, bytes: new Uint8Array([1, 2, 3]), version: 'v1',
    onContent: undefined as ((value: PageContent, read: number, page: number) => PageContent) | undefined,
    onPut: undefined as ((value: SavedReference) => Promise<void>) | undefined }
  let settings: PdfSettings = { ...defaultSettings, ocrEngine: 'ocr-fixture', imageEngine: options.imageEngine ?? 'image-fixture',
    embeddingEngine: 'embedding-fixture', indexScanPages: options.scan ?? true, indexImageDescriptions: options.describe ?? true }
  const snapshot = (session: string, id: string): HostWorkspaceSnapshot => {
    if (state.denied || id !== `doc-${session}`) throw Object.assign(new Error('Unauthorized PDF'), { code: 'pdf/access-denied' })
    return { id, path: '/content-search.pdf', bytes: state.bytes, sourceVersion: 'disk-one', contentVersion: state.version,
      revision: session === 'b' ? 7 : 0, dirty: false, conflict: false, canUndo: false, canRedo: false,
      document: { pageCount: 3, pages: [1, 2, 3].map(page => ({ page, userUnit: 1, rotation: 0,
        cropBox: [0, 0, 200, 300], mediaBox: [0, 0, 200, 300] })), annotations: [], signed: false, encrypted: false, readOnly: false } }
  }
  const workspaces = { readSnapshot: snapshot }
  const pages: Parameters<typeof createPdfPageContent>[1] = {
    async readPageText(session, id, page, _active, options) {
      assert.equal(options?.recover, false)
      state.nativeReads.push(page)
      const text = page === 1 ? state.native : ''
      const content: NativeTextContent = { items: text ? [{ str: text, transform: [10, 0, 0, 10, 10, 200], width: text.length * 4,
        height: 10, dir: 'ltr', fontName: 'fixture', hasEOL: false,
        glyphs: [...text].map((_character, index) => [10 + index * 4, 200, 4]) }] : [],
      styles: { fixture: { fontFamily: 'fixture', ascent: 0.8, descent: -0.2, vertical: false } }, lang: null }
      return { snapshot: snapshot(session, id), content }
    },
    async renderOcrImage(session, id, page, region, edge, _active, forms) {
      assert.equal(region, undefined); assert.equal(edge, 1024); assert.equal(forms, false)
      state.renders.push(page)
      const png = Buffer.alloc(25)
      png.set([137, 80, 78, 71, 13, 10, 26, 10]); png.write('IHDR', 12); png.writeUInt32BE(200, 16); png.writeUInt32BE(300, 20); png[24] = page
      return { snapshot: snapshot(session, id), png, width: 200, height: 300, pdfRegion: [0, 0, 200, 300] }
    },
  }
  const ocr = new HostOcrService(() => 'ocr-fixture'), image = new HostImageUnderstandingService(() => 'image-fixture')
  ocr.register({ descriptor: { id: 'ocr-fixture', name: 'Fixture OCR', version: '1', execution: 'local', capabilities: ['ocr-text'], geometry: ['word'], confidence: false },
    async cacheIdentity() { return 'ocr-stable-v1' }, async availability() { return { status: 'available' } },
    async recognize(request) {
      state.recognitions++
      const page = (request.image as Uint8Array)[24]!
      return { text: page === 2 ? state.ocr : '', status: 'complete', blocks: [], lines: [],
        words: page === 2 ? [{ id: 'word', text: 'ocrkeyword', box: { x0: 10, y0: 20, x1: 80, y1: 40 }, confidence: null }] : [],
        confidence: null, coverage: [], warnings: [] }
    } })
  const imageBackend = (id: string): ImageUnderstandingBackend => ({
    descriptor: { id, name: 'Fixture vision', version: '1', execution: 'local' },
    async cacheIdentity() { return `${id}-${state.visionModel}` }, async availability() { return { available: true } },
    async understand(request) {
      state.descriptions++
      if (state.imageFailure) throw new Error('Temporary image interpretation failure')
      assert.match(request.prompt, /document retrieval/)
      return { text: options.invalidImageOutput ? '' : request.image.data[24] === 3 ? state.description : 'An ordinary unlabeled figure.',
        model: state.visionModel }
    } })
  image.register(imageBackend('image-fixture'))
  image.register(imageBackend('image-fixture-two'))
  const embeddings = new EmbeddingRegistry()
  embeddings.register({ descriptor: { id: 'embedding-fixture', name: 'Fixture embedding', version: '1', execution: 'local' },
    describe: () => ({ engineId: 'embedding-fixture', engineVersion: '1', model: 'fixture', modelRevision: '1', dimensions: 2,
      maxBatchSize: 16, maxInputCharacters: 1200, encoding: 'fixture', fingerprint: 'embedding-v1' }),
    async availability() { return { status: 'available' } }, async embed(request) { return request.texts.map(() => [1, 0]) } })
  const data = new Map<string, unknown>()
  const cache = { async get(key: string) { return structuredClone(data.get(key)) }, async set(key: string, value: unknown) { data.set(key, structuredClone(value)) } }
  const content = createPdfPageContent(workspaces, pages, { settings: () => settings, ocr: () => ocr, image: () => image, cache })
  const bound: PdfPageContent = { ...content, async read(session, id, page, active) {
    const value = await content.read(session, id, page, active)
    const count = (state.contentReads.get(page) ?? 0) + 1
    state.contentReads.set(page, count)
    return state.onContent?.(value, count, page) ?? value
  } }
  const memory = createMemoryEvidenceReferenceStore(), issued: string[] = []
  const references = { ...memory, async put(key: string, value: SavedReference) { issued.push(key); await memory.put(key, value); await state.onPut?.(value) } }
  const retrieval = createPdfRetrieval(workspaces, pages, references, { cache, embeddings, settings: () => settings, content: bound,
    async freshSource(session, id, active) { active.throwIfAborted(); snapshot(session, id); state.freshChecks++;
      if (state.diskChanged) throw Object.assign(new Error('Original PDF changed on disk'), { code: 'pdf/source-changed' }) },
    async retain(session, id, active) { active.throwIfAborted(); snapshot(session, id); state.pins++; return () => { state.pins-- } } })
  return { state, content, retrieval, references, issued, data,
    updateSettings(change: Partial<PdfSettings>) { settings = { ...settings, ...change } },
    async dispose() { await retrieval.dispose(); ocr.dispose(); image.dispose(); embeddings.dispose() } }
}
const query = (text: string) => ({ documentId: 'doc-a', query: text, mode: 'lexical' as const })

test('native, OCR and image-description retrieval issue distinct truthful evidence with their exact returned text', async () => {
  const f = fixture()
  try {
    const native = await f.retrieval.search('a', query('nativekeyword'), signal)
    assert.equal(native.status, 'complete')
    assert.equal(native.candidates.length, 1)
    const exact = native.candidates[0]!
    assert.equal(exact.page, 1); assert.equal(exact.source, 'native-text'); assert.equal(exact.evidence.source, 'pdf-text')
    assert.equal(exact.evidence.locator.kind, 'text-window')
    assert.equal(exact.annotationStatus, 'requires-geometry-check')
    assert.equal(exact.evidence.snapshot.text, exact.quote)
    assert.equal(exact.evidence.snapshot.sha256, evidenceSha256(exact.quote))
    assert.equal(f.references.get(exact.evidence.refId)?.sessionId, 'a')
    const recognized = await f.retrieval.search('a', query('ocrkeyword'), signal)
    const ocr = recognized.candidates[0]!
    assert.equal(ocr.page, 2); assert.equal(ocr.source, 'ocr-text'); assert.equal(ocr.evidence.source, 'ocr-text')
    assert.equal(ocr.annotationStatus, 'unavailable'); assert.equal(ocr.evidence.precision, 'approximate-geometry')
    assert.deepEqual(ocr.evidence.locator, { kind: 'pdf-region', rectPdf: [10, 260, 80, 280] })
    assert.equal(ocr.evidence.snapshot.text, ocr.quote)
    assert.equal(ocr.evidence.snapshot.sha256, evidenceSha256(ocr.quote))
    if (ocr.evidence.source === 'ocr-text') {
      assert.equal(ocr.evidence.snapshot.kind, 'derived-text')
      assert.equal(ocr.evidence.snapshot.backendId, 'ocr-fixture')
    }
    const interpreted = await f.retrieval.search('a', query('visionkeyword'), signal)
    const description = interpreted.candidates[0]!
    assert.equal(description.page, 3); assert.equal(description.source, 'image-description'); assert.equal(description.evidence.source, 'auxiliary-vision')
    assert.equal(description.annotationStatus, 'unavailable'); assert.equal(description.evidence.precision, 'page-only')
    assert.equal(description.evidence.snapshot.text, description.quote)
    if (description.evidence.source === 'auxiliary-vision') {
      assert.equal(description.evidence.snapshot.kind, 'derived-text')
      assert.equal(description.evidence.snapshot.backendId, 'image-fixture')
      assert.equal(description.evidence.snapshot.model, f.state.visionModel)
    }
    assert.deepEqual(f.references.get(description.evidence.refId)?.evidence, description.evidence)
    assert.match(description.evidence.limitations.join(' '), /generated image description/)
    assert.deepEqual(interpreted.coverage.ocrPages, [2]); assert.deepEqual(interpreted.coverage.imageDescriptionPages, [1, 2, 3])
    assert.deepEqual(interpreted.coverage.noTextPages, [3])
    assert.equal(f.state.recognitions, 2); assert.equal(f.state.descriptions, 3, 'evidence reads reuse the exact indexed representations')
    assert.deepEqual(f.state.renders, [1, 2, 3], 'OCR and vision share one clean render for each indexed page')
    assert.equal(f.state.pins, 0)
  } finally { await f.dispose() }
})

test('retrieval coverage and evidence follow independent OCR and visual indexing toggles', async () => {
  for (const scan of [false, true]) for (const describe of [false, true]) {
    const f = fixture({ scan, describe })
    try {
      const visual = await f.retrieval.search('a', query('visionkeyword'), signal)
      const recognized = await f.retrieval.search('a', query('ocrkeyword'), signal)
      assert.equal(visual.status, 'complete'); assert.equal(recognized.status, 'complete')
      assert.equal(visual.candidates.length, Number(describe))
      assert.equal(recognized.candidates.length, Number(scan))
      assert.deepEqual(visual.coverage.imageDescriptionPages, describe ? [1, 2, 3] : [])
      assert.deepEqual(recognized.coverage.ocrPages, scan ? [2] : [])
      if (describe) {
        const candidate = visual.candidates[0]!
        assert.equal(candidate.source, 'image-description')
        assert.equal(candidate.evidence.source, 'auxiliary-vision')
        assert.equal(f.references.get(candidate.evidence.refId)?.evidence.source, 'auxiliary-vision')
      }
      if (scan) {
        const candidate = recognized.candidates[0]!
        assert.equal(candidate.source, 'ocr-text')
        assert.equal(candidate.evidence.source, 'ocr-text')
        assert.equal(f.references.get(candidate.evidence.refId)?.evidence.source, 'ocr-text')
      }
      assert.equal(f.state.recognitions, scan ? 2 : 0, 'visual-only retrieval never reaches the OCR engine')
      assert.equal(f.state.descriptions, describe ? 3 : 0)
      assert.deepEqual(f.state.renders, describe ? [1, 2, 3] : scan ? [2, 3] : [])
    } finally { await f.dispose() }
  }
})

test('shared vision producer changes rebuild visual-only retrieval while disabled OCR settings do not', async () => {
  const f = fixture({ scan: false })
  try {
    const first = await f.retrieval.search('a', query('visionkeyword'), signal)
    assert.equal(first.candidates[0]!.evidence.source, 'auxiliary-vision')
    f.updateSettings({ ocrEngine: 'missing-ocr-engine' })
    const warm = await f.retrieval.search('a', query('visionkeyword'), signal)
    assert.equal(warm.indexGeneration, first.indexGeneration)
    assert.equal(f.state.descriptions, 3)

    f.updateSettings({ imageEngine: 'image-fixture-two' })
    const changed = await f.retrieval.search('a', query('visionkeyword'), signal)
    assert.notEqual(changed.indexGeneration, first.indexGeneration)
    const evidence = changed.candidates[0]!.evidence
    assert.equal(evidence.source, 'auxiliary-vision')
    if (evidence.source === 'auxiliary-vision') {
      assert.equal(evidence.snapshot.backendId, 'image-fixture-two')
      assert.equal(evidence.snapshot.model, f.state.visionModel)
    }
    assert.equal(f.state.descriptions, 6); assert.equal(f.state.recognitions, 0)
  } finally { await f.dispose() }
})

test('missing vision engines and invalid outputs preserve native retrieval with truthful incomplete coverage', async () => {
  for (const invalid of ['missing-engine', 'invalid-result'] as const) {
    const f = fixture({ scan: false, imageEngine: invalid === 'missing-engine' ? 'missing-engine' : 'image-fixture',
      invalidImageOutput: invalid === 'invalid-result' })
    try {
      const result = await f.retrieval.search('a', { ...query('nativekeyword'), fromPage: 1, maxPages: 1 }, signal)
      assert.equal(result.status, 'incomplete')
      assert.equal(result.candidates.length, 1)
      assert.equal(result.candidates[0]!.source, 'native-text')
      assert.equal(result.candidates[0]!.evidence.source, 'pdf-text')
      assert.deepEqual(result.coverage.imageDescriptionPages, []); assert.deepEqual(result.coverage.ocrPages, [])
      assert.equal(result.coverage.failedPages[0]!.code,
        invalid === 'missing-engine' ? 'pdf/index-image-unavailable' : 'pdf/image-invalid-result')
      assert.equal(f.state.recognitions, 0)
      assert.equal(f.state.descriptions, invalid === 'missing-engine' ? 0 : 1)
      assert.deepEqual(f.state.renders, invalid === 'missing-engine' ? [] : [1])
      assert.equal(f.data.size, 0)
    } finally { await f.dispose() }
  }
})

test('a ready shared content index signs evidence for the authorized caller session and current revision', async () => {
  const f = fixture()
  try {
    await f.retrieval.search('a', query('ocrkeyword'), signal)
    const calls = f.state.recognitions
    const result = await f.retrieval.search('b', { ...query('ocrkeyword'), documentId: 'doc-b' }, signal)
    const evidence = result.candidates[0]!.evidence
    assert.equal(result.documentId, 'doc-b'); assert.equal(evidence.documentId, 'doc-b'); assert.equal(evidence.revision, 7)
    assert.equal(f.references.get(evidence.refId)?.sessionId, 'b')
    assert.equal(f.state.recognitions, calls)
    f.state.denied = true
    await assert.rejects(f.retrieval.search('b', { ...query('ocrkeyword'), documentId: 'doc-b' }, signal), { code: 'pdf/access-denied' })
    assert.equal(f.state.pins, 0)
  } finally { await f.dispose() }
})

test('derived evidence uses the immutable indexed representation instead of rerunning a changing producer', async () => {
  const f = fixture()
  f.state.onContent = (page, count, pageNumber) => {
    if (pageNumber !== 2 || count !== 2) return page
    return { ...page, blocks: page.blocks.map(block => ({ ...block, representations: block.representations.map(rep => rep.kind !== 'ocr-text' ? rep
      : createPageRepresentation({ ...rep, text: 'Changed producer text.' })) })) }
  }
  try {
    const result = await f.retrieval.search('a', query('ocrkeyword'), signal)
    assert.equal(result.candidates[0]!.quote, f.state.ocr)
    assert.equal(result.candidates[0]!.evidence.source, 'ocr-text')
    assert.equal(result.candidates[0]!.evidence.snapshot.text, f.state.ocr)
    assert.equal(f.state.contentReads.get(2), 1, 'sign the indexed representation without a second nondeterministic content read')
    assert.equal(f.state.recognitions, 2)
    assert.equal(f.state.pins, 0)
  } finally { await f.dispose() }
})

test('native page text is re-attested before evidence issuance even when content and retrieval indexes are warm', async () => {
  const f = fixture()
  try {
    await f.retrieval.search('a', query('nativekeyword'), signal)
    const references = f.issued.length
    f.state.native = 'nativekeyword changed after indexing'
    await assert.rejects(f.retrieval.search('a', query('nativekeyword'), signal), { code: 'pdf/stale-reader' })
    assert.equal(f.issued.length, references)
  } finally { await f.dispose() }
})

test('manual document reindex refreshes derived content and search quotes through the shared preparation path', async () => {
  const f = fixture()
  try {
    const original = await f.retrieval.search('a', query('ocrkeyword'), signal)
    f.state.ocr = 'newocrkeyword refreshed recognition'
    const warm = await f.retrieval.search('a', query('ocrkeyword'), signal)
    assert.equal(warm.candidates[0]!.quote, original.candidates[0]!.quote)
    await f.retrieval.prepare('a', { documentId: 'doc-a', rebuild: true }, signal)
    const refreshed = await f.retrieval.search('a', query('newocrkeyword'), signal)
    assert.equal(refreshed.candidates.length, 1, 'manual refresh must expire the ready lexical index as well as rebuild its embedding index')
    assert.equal(refreshed.candidates[0]!.quote, f.state.ocr)
    assert.equal(refreshed.candidates[0]!.evidence.source, 'ocr-text')
    assert.equal(refreshed.candidates[0]!.evidence.snapshot.text, f.state.ocr)
    assert.notEqual(refreshed.indexGeneration, original.indexGeneration)
    assert.equal(f.state.pins, 0)
  } finally { await f.dispose() }
})

test('cancelled or source-changed derived evidence minting removes its provisional reference', async () => {
  for (const reason of ['cancel', 'source'] as const) {
    const f = fixture(), entered = deferred(), gate = deferred(), controller = new AbortController()
    f.state.onPut = async value => { assert.equal(value.evidence.source, 'ocr-text'); entered.resolve(); await gate.promise }
    const pending = f.retrieval.search('a', query('ocrkeyword'), controller.signal)
    const rejected = assert.rejects(pending, reason === 'cancel' ? /Closed query/ : { code: 'pdf/stale-reader' })
    try {
      await entered.promise
      if (reason === 'cancel') controller.abort(new Error('Closed query'))
      else { f.state.bytes = new Uint8Array([8, 9, 10]); f.state.version = 'v2' }
      gate.resolve(); await rejected
      assert.equal(f.issued.length, 1)
      assert.equal(f.references.get(f.issued[0]!), undefined)
      assert.equal(f.state.pins, 0)
    } finally { gate.resolve(); await f.dispose() }
  }
})

test('warm content and retrieval caches still verify the actual source before returning or signing evidence', async () => {
  const f = fixture()
  try {
    await f.retrieval.search('a', query('ocrkeyword'), signal)
    const issued = f.issued.length, recognitions = f.state.recognitions, checks = f.state.freshChecks
    f.state.diskChanged = true
    await assert.rejects(f.retrieval.search('a', query('ocrkeyword'), signal), { code: 'pdf/source-changed' })
    assert.ok(f.state.freshChecks > checks)
    assert.equal(f.state.recognitions, recognitions)
    assert.equal(f.issued.length, issued)
    assert.equal(f.state.pins, 0)
    await assert.rejects(f.retrieval.prepare('a', { documentId: 'doc-a' }, signal), { code: 'pdf/source-changed' })
  } finally { await f.dispose() }
})

test('an actual disk change after reference minting rejects delivery even when the working-copy snapshot did not change', async () => {
  const f = fixture()
  f.state.onPut = async () => { f.state.diskChanged = true }
  try {
    await assert.rejects(f.retrieval.search('a', query('ocrkeyword'), signal), { code: 'pdf/source-changed' })
    assert.equal(f.issued.length, 1)
    assert.equal(f.state.pins, 0)
  } finally { await f.dispose() }
})

test('optional image interpretation failure returns the available native evidence with explicit incomplete coverage', async () => {
  const f = fixture()
  f.state.imageFailure = true
  try {
    const result = await f.retrieval.search('a', { ...query('nativekeyword'), fromPage: 1, maxPages: 1 }, signal)
    assert.equal(result.status, 'incomplete')
    assert.equal(result.candidates.length, 1)
    assert.equal(result.candidates[0]!.source, 'native-text')
    assert.equal(result.candidates[0]!.evidence.source, 'pdf-text')
    assert.equal(result.coverage.failedPages.length, 1)
    assert.equal(result.coverage.failedPages[0]!.page, 1)
    assert.equal(result.nextCursor, undefined)
    assert.equal(f.data.size, 0, 'neither failed IR nor retrieval page is persisted as complete')
    const again = await f.retrieval.search('a', { ...query('nativekeyword'), fromPage: 1, maxPages: 1 }, signal)
    assert.equal(again.status, 'incomplete')
    assert.equal(f.state.descriptions, 1, 'the immutable partial index retries only on explicit rebuild')
  } finally { await f.dispose() }
})
