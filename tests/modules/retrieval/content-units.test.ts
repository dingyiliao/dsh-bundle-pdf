import assert from 'node:assert/strict'
import { readIndexPage } from '../../../src/modules/retrieval/stored-index.ts'
import test from 'node:test'
import { digest, pageCacheKey, RETRIEVAL_EXTRACTION_VERSION, retrievalCacheKey, validateRetrievalPage } from '../../../src/modules/retrieval/cache.ts'
import { createRetrievalService } from '../../../src/modules/retrieval/service.ts'
import { chunkRetrievalPage, RETRIEVAL_TEXT_VERSION } from '../../../src/modules/retrieval/text.ts'
import type { RetrievalPage, RetrievalPageUnit, RetrievalPorts } from '../../../src/modules/retrieval/types.ts'

const sha = (text: string) => `sha256:${digest(text)}`
const unit = (id: string, kind: RetrievalPageUnit['kind'], text: string, extra: Partial<RetrievalPageUnit> = {}): RetrievalPageUnit =>
  ({ id, blockId: id, kind, text, digest: sha(text), ...extra })
const native = (id: string, text: string, startUtf16 = 0, extra: Partial<RetrievalPageUnit> = {}) =>
  unit(id, 'native-text', text, { nativeRange: { startUtf16, endUtf16: startUtf16 + text.length }, ...extra })
function fixture(pages: RetrievalPage[], options: { identity?: string; embedding?: boolean; pagesPerStep?: number } = {}) {
  const state = { identity: options.identity ?? '', sourceDigest: 'same-original', reads: 0, documentEmbeddings: 0 }
  const data = new Map<string, unknown>()
  const ports: RetrievalPorts = {
    documents: { snapshot: (_session, id) => ({ id, path: '/content-units.pdf', sourceDigest: state.sourceDigest,
      contentVersion: 'original', pageCount: pages.length }) },
    pages: { identity: () => state.identity, async read(_session, _id, page) { state.reads++; return structuredClone(pages[page - 1]!) } },
    cache: { async get(key) { return structuredClone(data.get(key)) }, async set(key, value) { data.set(key, structuredClone(value)) },
      async clear() { data.clear() } },
    ...(options.embedding ? { embedding: { select: () => ({ fingerprint: 'embedding-config', dimensions: 2, maxBatchSize: 8,
      async embed(texts: string[], purpose: 'query' | 'document') {
        if (purpose === 'document') state.documentEmbeddings += texts.length
        return texts.map(() => [1, 0])
      } }) } } : {}),
    limits: { pagesPerStep: options.pagesPerStep ?? 20 },
  }
  return { state, data, ports, service: createRetrievalService(ports) }
}
const search = { documentId: 'doc', query: 'needle', mode: 'lexical' as const, topK: 20 }
function assertNoSavedContent(data: Map<string, unknown>) {
  assert.ok([...data.values()].every(value => !value || typeof value !== 'object'
    || !('text' in value || 'content' in value || 'encoding' in value)), 'only metadata may be committed before source authority fails')
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

test('native, OCR and descriptions retain separate exact evidence coordinates and source coverage', async () => {
  const body = 'needle 😀 native text', text = `Heading\n${body}`
  const ocr = 'needle scanned words', description = 'A needle points at the red chart.'
  const f = fixture([
    { text, source: 'pdf-text', units: [native('native', body, 'Heading\n'.length)] },
    { text: '', source: 'pdf-text', units: [unit('scan', 'ocr-text', ocr, { rectPdf: [1, 2, 80, 20],
      spans: [{ startUtf16: 0, endUtf16: 6, rectPdf: [1, 2, 10, 20] }],
      producer: { id: 'ocr-fixture', model: 'model-v2', configurationIdentity: 'eng' }, inputDigest: sha('pixels') })] },
    { text: '', source: 'pdf-text', warnings: ['Generated interpretation; verify the image.'],
      units: [unit('figure', 'image-description', description, { rectPdf: [0, 0, 100, 100] })] },
  ])
  try {
    const result = await f.service.search('session', search)
    assert.equal(result.status, 'complete')
    assert.equal(result.chunks.length, 3)
    const byPage = new Map(result.chunks.map(chunk => [chunk.page, chunk]))
    const exact = byPage.get(1)!, scanned = byPage.get(2)!, described = byPage.get(3)!
    assert.equal(text.slice(exact.startUtf16, exact.endUtf16), exact.text)
    assert.equal(exact.pageTextDigest, digest(text))
    assert.equal(exact.representation!.unitStartUtf16, 0)
    assert.equal(scanned.source, 'ocr')
    assert.equal(scanned.startUtf16, 0)
    assert.equal(scanned.pageTextDigest, digest(ocr))
    assert.equal(scanned.representation!.unitDigest, sha(ocr))
    assert.deepEqual(scanned.representation!.spans, [{ startUtf16: 0, endUtf16: 6, rectPdf: [1, 2, 10, 20] }])
    assert.equal(scanned.representation!.producer!.configurationIdentity, 'eng')
    assert.equal(described.source, 'image-description')
    assert.equal(described.startUtf16, described.representation!.unitStartUtf16)
    assert.deepEqual(result.coverage.ocrPages, [2])
    assert.deepEqual(result.coverage.imageDescriptionPages, [3])
    assert.deepEqual(result.coverage.noTextPages, [3], 'generated descriptions do not claim a transcription')
    assert.equal(result.coverage.visual, 'image-descriptions')
    assert.equal(result.coverage.qualityWarnings[0]!.page, 3)
  } finally { await f.service.dispose() }
})

test('projected units are complete, so omitted native text is not indexed again as an implicit alternative', async () => {
  const f = fixture([{ text: 'needle native omitted by projection', source: 'pdf-text', units: [] }])
  try {
    const result = await f.service.search('session', search)
    assert.deepEqual(result.chunks, [])
    assert.equal(result.coverage.totalChunks, 0)
    assert.deepEqual(result.coverage.noTextPages, [1])
  } finally { await f.service.dispose() }
})

test('alternative block representations collapse after branch ranking while repeated distinct blocks remain separate', async () => {
  const text = 'needle same text\nneedle same text'
  const units = [native('a-native', 'needle same text', 0, { blockId: 'a' }),
    unit('a-ocr', 'ocr-text', 'needle same text', { blockId: 'a' }),
    unit('a-description', 'image-description', 'needle same text', { blockId: 'a' }),
    native('b-native', 'needle same text', 17, { blockId: 'b' })]
  for (const mode of ['lexical', 'semantic', 'hybrid'] as const) {
    const f = fixture([{ text, source: 'pdf-text', units }], { embedding: true })
    try {
      const result = await f.service.search('session', { ...search, mode })
      assert.equal(result.coverage.totalChunks, 4)
      assert.equal(result.chunks.length, 2)
      assert.deepEqual(result.chunks.map(chunk => chunk.representation!.blockId).sort(), ['a', 'b'])
    } finally { await f.service.dispose() }
  }
})

test('many generated alternatives cannot crowd distinct blocks out of the retrieval candidate window', async () => {
  const units = Array.from({ length: 50 }, (_, index) => unit(`alternative-${index}`, 'image-description', 'needle', { blockId: 'same-block' }))
  units.push(unit('distinct', 'image-description', 'A longer passage that also mentions the needle.', { blockId: 'distinct' }))
  const f = fixture([{ text: '', source: 'pdf-text', units }])
  try {
    const result = await f.service.search('session', { ...search, topK: 2 })
    assert.equal(result.chunks.length, 2)
    assert.deepEqual(result.chunks.map(chunk => chunk.representation!.blockId).sort(), ['distinct', 'same-block'])
  } finally { await f.service.dispose() }
})

test('long native block subranges survive duplicate collapse and never widen to surrounding page text', async () => {
  const body = 'needle paragraph words. '.repeat(30), text = `Preface\n${body}\nFooter`
  const content: RetrievalPage = { text, source: 'pdf-text', units: [native('long', body, 8)] }
  const chunks = chunkRetrievalPage(1, content, { maxCharacters: 96 })
  assert.ok(chunks.length > 2)
  for (const chunk of chunks) {
    assert.equal(text.slice(chunk.startUtf16, chunk.endUtf16), chunk.text)
    assert.equal(body.slice(chunk.representation!.unitStartUtf16, chunk.representation!.unitEndUtf16), chunk.text)
    assert.ok(chunk.startUtf16 >= 8 && chunk.endUtf16 <= 8 + body.length)
  }
  const f = fixture([content])
  try {
    const result = await f.service.search('session', search)
    assert.equal(result.chunks.length, 1, 'default size needs one native chunk')
    f.ports.embedding = { select: () => ({ fingerprint: 'small-input', dimensions: 2, maxBatchSize: 16, maxInputCharacters: 96,
      async embed(texts) { return texts.map(() => [1, 0]) } }) }
    const semantic = await f.service.search('session', { ...search, mode: 'semantic' })
    assert.equal(semantic.chunks.length, chunks.length)
    assert.equal(new Set(semantic.chunks.map(chunk => chunk.representation!.id)).size, 1)
  } finally { await f.service.dispose() }
})

test('validated representations and provenance survive cache restart without rereading or embedding', async () => {
  const text = 'needle generated image insight', f = fixture([{ text: '', source: 'pdf-text', contentIdentity: sha('content-v1'),
    units: [unit('figure', 'image-description', text, { producer: { id: 'vision', version: '2', model: 'm' }, inputDigest: sha('pixels') })] }],
  { identity: 'pipeline-v1', embedding: true })
  await f.service.prepare('session', { documentId: 'doc' })
  const reads = f.state.reads, embedded = f.state.documentEmbeddings
  await f.service.dispose()
  const restored = createRetrievalService(f.ports)
  try {
    await restored.prepare('other-session', { documentId: 'doc' })
    const result = await restored.search('other-session', { ...search, mode: 'semantic' })
    assert.equal(f.state.reads, reads)
    assert.equal(f.state.documentEmbeddings, embedded)
    assert.equal(result.chunks[0]!.representation!.producer!.id, 'vision')
    assert.equal(result.chunks[0]!.representation!.inputDigest, sha('pixels'))
  } finally { await restored.dispose() }
})

test('pipeline identities invalidate ready fences, continuations and page cache without changing embedding configuration', async () => {
  const f = fixture(new Array<RetrievalPage>(2).fill({ text: 'needle same text', source: 'pdf-text' }),
    { identity: 'pipeline-a', embedding: true, pagesPerStep: 1 })
  try {
    const first = await f.service.search('session', { ...search, mode: 'semantic' })
    assert.equal(first.status, 'building')
    const complete = await f.service.search('session', { ...search, mode: 'semantic', cursor: first.nextCursor })
    assert.equal(complete.status, 'complete')
    assert.equal(f.state.documentEmbeddings, 1)
    f.state.identity = 'pipeline-b'
    assert.throws(() => f.service.validate('session', complete), { code: 'pdf/stale-reader' })
    await assert.rejects(f.service.search('session', { ...search, mode: 'semantic', cursor: first.nextCursor }), { code: 'pdf/stale-reader' })
    await f.service.prepare('session', { documentId: 'doc' })
    assert.equal(f.state.reads, 4)
    assert.equal(f.state.documentEmbeddings, 1, 'identical text reuses model vectors across extraction pipelines')
    assert.ok(f.data.has(pageCacheKey('/content-units.pdf', 'same-original', 1, 'pipeline-a')))
    assert.ok(f.data.has(pageCacheKey('/content-units.pdf', 'same-original', 1, 'pipeline-b')))
    assert.equal(pageCacheKey('/content-units.pdf', 'same-original', 1),
      retrievalCacheKey('page', RETRIEVAL_EXTRACTION_VERSION, RETRIEVAL_TEXT_VERSION, '/content-units.pdf', 'same-original', 1))
    assert.equal(pageCacheKey('/content-units.pdf', 'same-original', 1, ''), pageCacheKey('/content-units.pdf', 'same-original', 1))
  } finally { await f.service.dispose() }
})

test('pipeline changes during a non-cooperative read reject late content before caching or embedding it', async () => {
  for (const prepare of [false, true]) {
    const f = fixture([{ text: 'needle', source: 'pdf-text' }], { identity: 'a', embedding: true })
    const entered = deferred(), gate = deferred()
    f.ports.pages.read = async () => { entered.resolve(); await gate.promise; return { text: 'needle stale', source: 'pdf-text' } }
    const pending = prepare ? f.service.prepare('session', { documentId: 'doc' }) : f.service.search('session', search)
    const rejected = assert.rejects(pending, { code: 'pdf/stale-reader' })
    try {
      await entered.promise
      f.state.identity = 'b'
      gate.resolve()
      await rejected
      assertNoSavedContent(f.data)
      assert.equal(f.state.documentEmbeddings, 0)
    } finally { gate.resolve(); await f.service.dispose() }
  }
})

test('unit cache schema rejects stale digests, invalid ranges, malformed geometry and duplicate IDs', () => {
  const text = 'A😀 needle', content = { version: 1, text, source: 'pdf-text', units: [native('native', text)] }
  assert.ok(validateRetrievalPage(content))
  const invalid = [
    { digest: sha('stale') }, { kind: 'unknown' }, { nativeRange: undefined },
    { nativeRange: { startUtf16: 0, endUtf16: text.length + 1 } },
    { nativeRange: { startUtf16: 2, endUtf16: 3 } }, { paragraphBreaks: [2] },
    { rectPdf: [10, 0, 1, 5] }, { rectPdf: [0, 0, 0, 5] }, { rectPdf: [0, 0, Infinity, 5] },
    { inputDigest: 'not-a-digest' }, { producer: { id: '' } },
    { spans: [{ startUtf16: 1, endUtf16: 2, rectPdf: [0, 0, 10, 10] }] },
    { spans: [{ startUtf16: 3, endUtf16: text.length + 1, rectPdf: [0, 0, 10, 10] }] },
    { spans: [{ startUtf16: 3, endUtf16: 3, rectPdf: [0, 0, 10, 10] }] },
  ]
  for (const change of invalid) assert.equal(validateRetrievalPage({ ...content, units: [{ ...content.units[0], ...change }] }), undefined,
    JSON.stringify(change))
  assert.equal(validateRetrievalPage({ ...content, units: [content.units[0], content.units[0]] }), undefined)
  assert.equal(validateRetrievalPage({ ...content, units: [unit('ocr', 'ocr-text', text, { nativeRange: { startUtf16: 0, endUtf16: text.length } })] }), undefined)
})

test('a corrupted unit record is re-extracted instead of returning unsigned or stale generated text', async () => {
  const f = fixture([{ text: '', source: 'pdf-text', units: [unit('figure', 'image-description', 'needle current')] }], { identity: 'pipeline' })
  const key = pageCacheKey('/content-units.pdf', 'same-original', 1, 'pipeline')
  f.data.set(key, { version: 1, text: '', source: 'pdf-text', units: [unit('figure', 'image-description', 'needle corrupt', { digest: sha('other') })] })
  try {
    const result = await f.service.search('session', search)
    assert.equal(f.state.reads, 1)
    assert.equal(result.chunks[0]!.text, 'needle current')
  } finally { await f.service.dispose() }
})

test('a pipeline-changing subscriber cannot publish late content into another subscriber shared index', async () => {
  const f = fixture([{ text: 'needle', source: 'pdf-text' }])
  const identities: Record<string, string> = { a: 'old-pipeline', b: 'old-pipeline' }
  f.ports.pages.identity = session => identities[session]!
  const entered = deferred(), gate = deferred(), reads: string[] = []
  f.ports.pages.read = async session => {
    reads.push(session)
    if (session === 'a') { entered.resolve(); await gate.promise; return { text: 'needle stale-a', source: 'pdf-text' } }
    return { text: 'needle authorized-b', source: 'pdf-text' }
  }
  const first = f.service.search('a', search)
  const rejected = assert.rejects(first, { code: 'pdf/stale-reader' })
  try {
    await entered.promise
    const second = f.service.search('b', search)
    await new Promise<void>(resolve => setImmediate(resolve))
    identities.a = 'new-pipeline'
    gate.resolve()
    const result = await second
    await rejected
    assert.equal(result.chunks[0]!.text, 'needle authorized-b')
    assert.deepEqual(reads, ['a', 'b'])
    assert.ok([...f.data.values()].every(value => !JSON.stringify(value).includes('stale-a')))
    f.service.validate('b', result)
  } finally { gate.resolve(); await f.service.dispose() }
})

test('sessions with different extraction policies keep separate indexes while reusing the exact same embedding configuration', async () => {
  const f = fixture([{ text: 'needle same text', source: 'pdf-text' }], { embedding: true })
  f.ports.pages.identity = session => `pipeline-${session}`
  try {
    const a = await f.service.search('a', { ...search, mode: 'semantic' })
    const b = await f.service.search('b', { ...search, mode: 'semantic' })
    assert.notEqual(a.indexGeneration, b.indexGeneration)
    assert.equal(f.state.reads, 2)
    assert.equal(f.state.documentEmbeddings, 1)
    const warm = await f.service.search('a', { ...search, mode: 'semantic' })
    assert.equal(warm.indexGeneration, a.indexGeneration)
    assert.equal(f.state.reads, 2)
    f.service.validate('a', a)
    f.service.validate('b', b)
  } finally { await f.service.dispose() }
})

test('partial representations are checkpointed and normal resume repairs the missing layer without replacing native vectors', async () => {
  const pages: RetrievalPage[] = [{ text: 'needle native remains usable', source: 'pdf-text',
    units: [native('native', 'needle native remains usable')], failure: { code: 'pdf/index-image-unavailable' },
    warnings: ['Image description failed; resume to retry.'] }]
  const f = fixture(pages, { identity: 'partial-pipeline', embedding: true })
  try {
    const result = await f.service.search('session', { ...search, mode: 'semantic' })
    assert.equal(result.status, 'incomplete')
    assert.equal(result.chunks[0]!.text, pages[0]!.text)
    assert.equal(result.nextCursor, undefined)
    assert.equal(result.coverage.indexedPages, 1)
    assert.deepEqual(result.coverage.failedPages, [{ page: 1, attempts: 1, code: 'pdf/index-image-unavailable' }])
    assert.equal(f.data.has(pageCacheKey('/content-units.pdf', 'same-original', 1, 'partial-pipeline')), false,
      'the general page cache must not claim an incomplete representation is complete')
    const head = [...f.data.values()].find(value => value && typeof value === 'object' && 'pending' in value) as { key: string; pending: { id: string } }
    const checkpoint = await readIndexPage({ get: async key => f.data.get(key), set: async () => {} }, head.key, head.pending.id, 1, 2, 1200)
    assert.equal(checkpoint!.record.content.text, pages[0]!.text)
    assert.equal(checkpoint!.record.failure!.code, 'pdf/index-image-unavailable')
    const again = await f.service.search('session', { ...search, mode: 'semantic' })
    assert.equal(again.status, 'incomplete'); assert.equal(again.coverage.totalChunks, 1)
    assert.equal(f.state.documentEmbeddings, 1, 'retrying an optional layer does not encode unchanged native text again')
    const beforeRepair = f.state.reads
    pages[0] = { text: 'needle native remains usable', source: 'pdf-text',
      units: [native('native', 'needle native remains usable'), unit('figure', 'image-description', 'needle repaired image insight')] }
    await f.service.prepare('session', { documentId: 'doc' })
    const refreshed = await f.service.search('session', { ...search, mode: 'semantic' })
    assert.equal(refreshed.status, 'complete'); assert.equal(refreshed.indexGeneration, result.indexGeneration)
    assert.equal(refreshed.coverage.totalChunks, 2)
    assert.equal(refreshed.chunks.find(chunk => chunk.source === 'pdf-text')!.id, result.chunks[0]!.id)
    assert.equal(f.state.documentEmbeddings, 2, 'only the newly available image description is encoded')
    assert.deepEqual(refreshed.coverage.failedPages, [])
    assert.equal(f.state.reads, beforeRepair + 1)
    assert.ok(f.data.has(pageCacheKey('/content-units.pdf', 'same-original', 1, 'partial-pipeline')))
  } finally { await f.service.dispose() }
})

test('a failed background preparation resumes its partial checkpoint after service recreation', async () => {
  const pages: RetrievalPage[] = [{ text: 'needle native', source: 'pdf-text', failure: { code: 'pdf/index-image-unavailable' } }]
  const f = fixture(pages, { embedding: true })
  try {
    await assert.rejects(f.service.prepare('session', { documentId: 'doc' }), { code: 'pdf/retrieval-incomplete' })
    const reads = f.state.reads, embeddings = f.state.documentEmbeddings
    assert.ok(reads >= 1 && reads <= 2, 'a single preparation has a bounded optional-layer retry')
    await f.service.dispose()
    pages[0] = { text: 'needle native', source: 'pdf-text' }
    const restored = createRetrievalService(f.ports)
    try {
      await restored.prepare('session', { documentId: 'doc' })
      assert.equal(f.state.reads, reads + 1)
      assert.equal(f.state.documentEmbeddings, embeddings, 'the saved native vector survives the failed attempt and restart')
      assert.equal((await restored.search('session', { ...search, mode: 'semantic' })).status, 'complete')
    } finally { await restored.dispose() }
  } finally { await f.service.dispose() }
})

test('structure rebuild reuses verified representations while source changes and explicit cache clear force fresh work', async () => {
  const f = fixture([{ text: 'needle original', source: 'pdf-text' }], { identity: 'policy-a', embedding: true })
  const originalRead = f.ports.pages.read
  let text = 'needle original'
  f.ports.pages.read = async (...args) => ({ ...await originalRead(...args), text })
  const originalSelect = f.ports.embedding!.select
  let configuration = 'a'
  f.ports.embedding!.select = session => ({ ...originalSelect(session)!, configurationIdentity: configuration })
  try {
    const lexical = await f.service.search('session', search)
    const semanticA = await f.service.search('session', { ...search, mode: 'semantic' })
    configuration = 'b'
    const semanticB = await f.service.search('session', { ...search, mode: 'semantic' })
    f.state.identity = 'policy-b'
    const otherPolicy = await f.service.search('session', search)
    f.state.identity = 'policy-a'; text = 'needle changed contributor output without a changed source identity'
    const reads = f.state.reads, embedded = f.state.documentEmbeddings
    await f.service.prepare('session', { documentId: 'doc', rebuild: true, rebuildToken: 'layout-v2' })
    const freshB = await f.service.search('session', { ...search, mode: 'semantic' })
    assert.notEqual(freshB.indexGeneration, semanticB.indexGeneration)
    assert.equal(freshB.chunks[0]!.text, 'needle original')
    assert.equal((await f.service.search('session', search)).indexGeneration, lexical.indexGeneration)
    assert.equal(f.state.reads, reads); assert.equal(f.state.documentEmbeddings, embedded)
    configuration = 'a'
    assert.equal((await f.service.search('session', { ...search, mode: 'semantic' })).indexGeneration, semanticA.indexGeneration)
    f.state.identity = 'policy-b'
    assert.equal((await f.service.search('session', search)).indexGeneration, otherPolicy.indexGeneration)
    f.state.identity = 'policy-a'; f.state.sourceDigest = 'replacement-source'; text = 'needle replaced source text'
    await f.service.prepare('session', { documentId: 'doc' })
    const replacement = await f.service.search('session', { ...search, mode: 'semantic' })
    assert.equal(replacement.chunks[0]!.text, text)
    assert.notEqual(replacement.indexGeneration, semanticA.indexGeneration)
    assert.throws(() => f.service.validate('session', semanticA), { code: 'pdf/stale-reader' })
    const beforeClear = { reads: f.state.reads, embedded: f.state.documentEmbeddings }
    await f.service.rebuild()
    await f.service.prepare('session', { documentId: 'doc' })
    assert.equal(f.state.reads, beforeClear.reads + 1)
    assert.equal(f.state.documentEmbeddings, beforeClear.embedded + 1)
  } finally { await f.service.dispose() }
})

test('a changed source with partial content never restores an older source as falsely complete after restart', async () => {
  const pages: RetrievalPage[] = [{ text: 'needle old complete', source: 'pdf-text' }]
  const f = fixture(pages, { embedding: true })
  const key = pageCacheKey('/content-units.pdf', 'same-original', 1)
  try {
    assert.equal((await f.service.search('session', search)).status, 'complete')
    assert.ok(f.data.get(key))
    f.state.sourceDigest = 'changed-source'
    pages[0] = { text: 'needle current partial', source: 'pdf-text', failure: { code: 'pdf/index-image-unavailable' } }
    await assert.rejects(f.service.prepare('session', { documentId: 'doc' }), { code: 'pdf/retrieval-incomplete' })
    assert.ok(f.data.get(key), 'a verified cache for different source bytes stays independently reusable')
    assert.equal(f.data.has(pageCacheKey('/content-units.pdf', 'changed-source', 1)), false)
    await f.service.dispose()
    const restored = createRetrievalService(f.ports)
    try {
      const result = await restored.search('session', search)
      assert.equal(result.status, 'incomplete')
      assert.equal(result.chunks[0]!.text, 'needle current partial')
      assert.ok(f.state.reads >= 3, 'the changed source must be read and its failed optional layer retried')
    } finally { await restored.dispose() }
  } finally { await f.service.dispose() }
})

test('representation spans preserve adjacent source ranges and overlapping visual boxes but reject unsorted or overlapping text offsets', () => {
  const text = 'needle text ranges', rectPdf: [number, number, number, number] = [0, 0, 10, 10]
  const first = { startUtf16: 0, endUtf16: 6, rectPdf }, second = { startUtf16: 6, endUtf16: text.length, rectPdf }
  const page = (spans: RetrievalPageUnit['spans']) => ({ version: 1, text, source: 'pdf-text', units: [native('native', text, 0, { spans })] })
  assert.ok(validateRetrievalPage(page([first, second])), 'visual rectangles may overlap when source ranges do not')
  assert.equal(validateRetrievalPage(page([second, first])), undefined)
  assert.equal(validateRetrievalPage(page([first, { ...second, startUtf16: 5 }])), undefined)
  const large = 'needle '.repeat(10_000)
  assert.equal(validateRetrievalPage({ version: 1, text: large, source: 'pdf-text', units: [native('large', large, 0, {
    spans: Array.from({ length: 1000 }, () => ({ startUtf16: 0, endUtf16: large.length, rectPdf })),
  })] }), undefined, 'overlapping full-unit spans must not amplify into every derived chunk')
})

test('source, session and permission failures abort retrieval instead of becoming an incomplete page result', async () => {
  for (const code of ['pdf/source-unavailable', 'pdf/source-changed', 'pdf/session-mismatch', 'pdf/access-denied',
    'pdf/unknown-document', 'pdf/permission-denied', 'FS_SANDBOX_DENIED', 'EACCES', 'EPERM']) {
    for (const wrapped of [false, true]) {
      const f = fixture([{ text: 'needle', source: 'pdf-text' }, { text: 'later page', source: 'pdf-text' }])
      let reads = 0
      const critical = Object.assign(new Error('Source authority failed'), { code })
      f.ports.pages.read = async () => { reads++; throw wrapped ? new Error('Contributor wrapped its source failure', { cause: critical }) : critical }
      try {
        await assert.rejects(f.service.search('session', search), error => {
          assert.ok(error && typeof error === 'object' && 'code' in error)
          assert.ok(error.code === 'pdf/stale-reader' || error.code === code)
          return true
        })
        assert.equal(reads, 1, `${code} must stop before reading another page`)
        assertNoSavedContent(f.data)
      } finally { await f.service.dispose() }
    }
  }
})

test('a projected page cannot downgrade a typed source authority failure into available partial content', async () => {
  const f = fixture([{ text: 'needle native', source: 'pdf-text', failure: { code: 'pdf/access-denied' } }])
  try {
    await assert.rejects(f.service.search('session', search), { code: 'pdf/access-denied' })
    assertNoSavedContent(f.data)
  } finally { await f.service.dispose() }
})

test('a changed source that throws during extraction cannot resurrect old content and can resume after restart', async () => {
  const f = fixture([{ text: 'needle old complete', source: 'pdf-text' }], { embedding: true })
  const key = pageCacheKey('/content-units.pdf', 'same-original', 1)
  try {
    assert.equal((await f.service.search('session', search)).status, 'complete')
    assert.ok(f.data.get(key))
    f.state.sourceDigest = 'changed-source'
    const originalRead = f.ports.pages.read
    f.ports.pages.read = async () => { throw Object.assign(new Error('Recognition failed'), { code: 'pdf/index-ocr-unavailable' }) }
    await assert.rejects(f.service.prepare('session', { documentId: 'doc' }), { code: 'pdf/retrieval-incomplete' })
    assert.ok(f.data.get(key), 'the old source remains a separate immutable cache entry')
    await f.service.dispose()
    const restored = createRetrievalService(f.ports)
    try {
      const result = await restored.search('session', search)
      assert.equal(result.status, 'incomplete'); assert.deepEqual(result.chunks, [])
      assert.equal(result.coverage.indexedPages, 0)
      assert.equal(result.coverage.failedPages[0]!.code, 'pdf/index-ocr-unavailable')
      f.ports.pages.read = originalRead
      const changed = 'needle recovered changed source'
      f.ports.pages.read = async (...args) => ({ ...await originalRead(...args), text: changed })
      await restored.prepare('session', { documentId: 'doc' })
      const recovered = await restored.search('session', { ...search, mode: 'semantic' })
      assert.equal(recovered.status, 'complete')
      assert.equal(recovered.chunks[0]!.text, changed)
      assert.equal(recovered.chunks[0]!.pageTextDigest, digest(changed))
    } finally { await restored.dispose() }
  } finally { await f.service.dispose() }
})
