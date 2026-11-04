import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import test from 'node:test'
import { isDeepStrictEqual, promisify } from 'node:util'
import { decodeCachedVector, digest, encodeCachedVector, type CachedRetrievalPage } from '../../../src/modules/retrieval/cache.ts'
import { chunkRetrievalPage } from '../../../src/modules/retrieval/text.ts'
import { buildIndexPageEntries, createVolatileIndexStore, readIndexHead, readIndexPage, readIndexSummary, recoverIndexPageHeader,
  storedIndexHeadKey, storedIndexPageKey, summarizeIndexPage, type StoredIndexPage,
  type StoredIndexPageHeader } from '../../../src/modules/retrieval/stored-index.ts'
import type { RetrievalCache } from '../../../src/modules/retrieval/types.ts'

const key = 'a'.repeat(64), generation = '42d2d852-35d6-4d86-89c9-824c816e9320'
const otherGeneration = '27f29b07-90a6-438d-9585-664c7318f1db'
const corrupt = { code: 'pdf/index-storage-corrupt' }
function fixture() {
  const values = new Map<string, unknown>(), calls: string[] = []
  const cache: RetrievalCache = { async get(key) { calls.push(key); return values.get(key) },
    async set(key, value) { values.set(key, value) } }
  const head = storedIndexHeadKey(key), page = storedIndexPageKey(key, generation, 1)
  const content: CachedRetrievalPage = { version: 1, source: 'pdf-text', text: 'First evidence.\n\nSecond evidence.' }
  const chunks = chunkRetrievalPage(1, content)
  const record: StoredIndexPage = { version: 1, generation, page: 1, content,
    vectors: { [chunks[0]!.id]: encodeCachedVector([3, 4]) } }
  return { values, calls, cache, head, page, content, chunks, record }
}

async function doubleNormalizationFixture() {
  const f = fixture(), casCalls: string[] = []
  f.content.units = [
    { id: 'native', blockId: 'native', kind: 'native-text', text: f.content.text,
      digest: `sha256:${digest(f.content.text)}`, nativeRange: { startUtf16: 0, endUtf16: f.content.text.length } },
    { id: 'ocr', blockId: 'scan', kind: 'ocr-text', text: 'Retained scanned evidence.',
      digest: `sha256:${digest('Retained scanned evidence.')}`, producer: { id: 'ocr-engine', version: '1' },
      spans: [{ startUtf16: 0, endUtf16: 8, rectPdf: [1, 2, 5, 6] }] },
  ]
  f.content.warnings = ['OCR contains uncertain punctuation.']
  const chunks = chunkRetrievalPage(1, f.content), id = chunks.find(chunk => chunk.source === 'ocr')!.id
  const source = encodeCachedVector([11, 37]), rebuilt = encodeCachedVector(decodeCachedVector(source, 2)!)
  assert.notEqual(source.sha256, rebuilt.sha256, 'this fixture reproduces actual Float32 renormalization drift')
  f.record.vectors = { [id]: rebuilt }
  f.record.failure = { code: 'ocr/partial', attempts: 2 }
  const sourceKey = `retrieval_${'b'.repeat(64)}`, targetKey = `index_vector_${rebuilt.sha256}`
  const built = buildIndexPageEntries(key, generation, f.record, chunks, undefined, { [id]: sourceKey })
  for (const [recordKey, value] of built.entries) await f.cache.set(recordKey, structuredClone(value))
  await f.cache.set(sourceKey, source)
  const ocrKey = `retrieval_${'e'.repeat(64)}`, ocr = { source: 'ocr', text: 'Retained cached OCR layer.' }
  await f.cache.set(ocrKey, ocr)
  const header = structuredClone(f.values.get(f.page)) as StoredIndexPageHeader
  const cache: RetrievalCache = { ...f.cache, async has(recordKey) { return f.values.has(recordKey) },
    async compareAndSet(recordKey, expected, value) {
      casCalls.push(recordKey)
      if (!isDeepStrictEqual(f.values.get(recordKey), expected)) return false
      f.values.set(recordKey, structuredClone(value)); return true
    } }
  return { ...f, cache, chunks, id, source, rebuilt, sourceKey, targetKey, header, casCalls, ocrKey, ocr,
    contentKey: built.location.contentKey }
}

test('head and page keys are stable, filename-safe and isolate generations, pages and sources', () => {
  assert.equal(storedIndexHeadKey(key), `index_head_${key}`)
  assert.match(storedIndexPageKey(key, generation, 1), /^index_page_[a-f0-9]{64}$/)
  assert.equal(storedIndexPageKey(key, generation, 1), storedIndexPageKey(key, generation, 1))
  assert.notEqual(storedIndexPageKey(key, generation, 1), storedIndexPageKey(key, otherGeneration, 1))
  assert.notEqual(storedIndexPageKey(key, generation, 1), storedIndexPageKey(key, generation, 2))
  assert.notEqual(storedIndexPageKey(key, generation, 1), storedIndexPageKey('b'.repeat(64), generation, 1))
})

test('missing heads remain absent and valid active, pending and seed metadata are independent copies', async () => {
  const f = fixture()
  assert.equal(await readIndexHead(f.cache, key), undefined)
  f.values.set(f.head, null)
  assert.equal(await readIndexHead(f.cache, key), undefined)
  const active = { id: generation, rebuildToken: 'completed-attempt' }
  const pending = { id: otherGeneration, rebuildToken: 'pending-attempt' }
  f.values.set(f.head, { version: 1, key, active, pending, seeds: [active] })
  const restored = await readIndexHead(f.cache, key)
  assert.deepEqual(restored, { version: 1, key, active, pending, seeds: [active] })
  restored!.active!.rebuildToken = 'locally-edited'
  restored!.seeds!.length = 0
  assert.deepEqual(await readIndexHead(f.cache, key), { version: 1, key, active, pending, seeds: [active] })
  f.values.set(f.head, { version: 1, key, pending })
  assert.deepEqual((await readIndexHead(f.cache, key))!.pending, pending)
  f.values.set(f.head, { version: 1, key, active })
  assert.deepEqual((await readIndexHead(f.cache, key))!.active, active)
  assert.ok(f.calls.every(call => call === f.head))
})

test('malformed, mismatched and empty head records cannot claim a complete or pending generation', async () => {
  const f = fixture()
  for (const value of [
    true, [], { version: 2, key, active: { id: generation } },
    { version: 1, key: 'b'.repeat(64), active: { id: generation } },
    { version: 1, key }, { version: 1, key, seeds: [{ id: generation }] },
    { version: 1, key, active: { id: 'not-a-generation' } },
    { version: 1, key, active: { id: generation }, seeds: Array.from({ length: 9 }, () => ({ id: generation })) },
    { version: 1, key, pending: { id: generation }, unexpected: true },
  ]) {
    f.values.set(f.head, value)
    await assert.rejects(readIndexHead(f.cache, key), corrupt)
  }
})

test('page reads retain exact evidence while returning independently decoded vectors and content', async () => {
  const f = fixture()
  f.content.units = [{ id: 'native-unit', blockId: 'native-block', kind: 'native-text', text: f.content.text,
    digest: `sha256:${digest(f.content.text)}`, nativeRange: { startUtf16: 0, endUtf16: f.content.text.length },
    spans: [{ startUtf16: 0, endUtf16: 5, rectPdf: [1, 2, 5, 6] }], producer: { id: 'native-engine' } }]
  const chunks = chunkRetrievalPage(1, f.content)
  f.record.vectors = { [chunks[0]!.id]: encodeCachedVector([3, 4]) }
  f.record.failure = { code: 'ocr/unavailable', attempts: 2 }
  f.values.set(f.page, f.record)
  const restored = await readIndexPage(f.cache, key, generation, 1, 2, 1200)
  assert.ok(restored)
  assert.deepEqual(restored.chunks, chunks)
  assert.deepEqual(restored.record.failure, { code: 'ocr/unavailable', attempts: 2 })
  assert.ok(restored.vectors.get(chunks[0]!.id) instanceof Float32Array)
  assert.ok(Math.abs(restored.vectors.get(chunks[0]!.id)![0]! - 0.6) < 1e-6)
  assert.deepEqual(restored.chunks[0]!.representation!.spans, [{ startUtf16: 0, endUtf16: 5, rectPdf: [1, 2, 5, 6] }])
  restored.record.content.text = 'local edit'
  restored.chunks[0]!.representation!.spans![0]!.rectPdf[0] = 999
  restored.vectors.get(chunks[0]!.id)![0] = 999
  const next = await readIndexPage(f.cache, key, generation, 1, 2, 1200)
  assert.equal(next!.record.content.text, f.content.text)
  assert.equal(next!.chunks[0]!.representation!.spans![0]!.rectPdf[0], 1)
  assert.ok(Math.abs(next!.vectors.get(chunks[0]!.id)![0]! - 0.6) < 1e-6)
})

test('missing pages are distinguishable from malformed page, generation and content records', async () => {
  const f = fixture()
  assert.equal(await readIndexPage(f.cache, key, generation, 1, 2, 1200), undefined)
  f.values.set(f.page, null)
  assert.equal(await readIndexPage(f.cache, key, generation, 1, 2, 1200), undefined)
  for (const value of [
    [], { ...f.record, version: 2 }, { ...f.record, page: 2 },
    { ...f.record, generation: otherGeneration }, { ...f.record, generation: 'invalid' },
    { ...f.record, content: { version: 1, text: 42, source: 'pdf-text' } },
    { ...f.record, content: { ...f.content, paragraphBreaks: [5000] } },
    { ...f.record, vectors: { malformed: encodeCachedVector([3, 4]) } },
    { ...f.record, failure: { code: '', attempts: 0 } },
  ]) {
    f.values.set(f.page, value)
    await assert.rejects(readIndexPage(f.cache, key, generation, 1, 2, 1200), corrupt)
  }
})

test('invalid vectors are marked incomplete while unknown chunk IDs and lexical vectors are ignored', async () => {
  const f = fixture(), first = f.chunks[0]!.id, second = f.chunks[1]!.id
  f.record.vectors = {
    [first]: { ...encodeCachedVector([3, 4]), data: 'damaged' },
    [second]: encodeCachedVector([0, 1]),
    ['c'.repeat(64)]: encodeCachedVector([1, 0]),
  }
  f.values.set(f.page, f.record)
  const restored = await readIndexPage(f.cache, key, generation, 1, 2, 1200)
  assert.deepEqual([...restored!.vectors.keys()], [second])
  assert.deepEqual(Object.keys(restored!.record.vectors), [second])
  assert.deepEqual(f.record.vectors[first]!.data, 'damaged', 'repair planning cannot mutate the stored input record')
  const lexical = await readIndexPage(f.cache, key, generation, 1, undefined, 1200)
  assert.equal(lexical!.vectors.size, 0)
  assert.deepEqual(Object.keys(lexical!.record.vectors), [])
})

test('V2 checkpoints split immutable page geometry and vectors from the small final header without changing runtime evidence', async () => {
  const f = fixture()
  f.content.units = [{ id: 'native', blockId: 'native', kind: 'native-text', text: f.content.text,
    digest: `sha256:${digest(f.content.text)}`, nativeRange: { startUtf16: 0, endUtf16: f.content.text.length },
    spans: [{ startUtf16: 0, endUtf16: 5, rectPdf: [1, 2, 5, 6] }] }]
  const chunks = chunkRetrievalPage(1, f.content)
  f.record.vectors = { [chunks[0]!.id]: encodeCachedVector([3, 4]) }
  const built = buildIndexPageEntries(key, generation, f.record, chunks)
  assert.equal(built.entries.at(-1)![0], f.page, 'all referenced immutable data is written before the checkpoint header')
  const header = built.entries.at(-1)![1] as Record<string, unknown>
  assert.equal(header.version, 2)
  assert.equal('content' in header, false); assert.equal('vectors' in header, false)
  assert.equal('text' in (header.summary as Record<string, unknown>), false)
  for (const [recordKey, value] of built.entries) await f.cache.set(recordKey, value)
  const restored = await readIndexPage(f.cache, key, generation, 1, 2, 1200)
  assert.deepEqual(restored!.chunks, chunks)
  assert.deepEqual(restored!.location, built.location)
  assert.deepEqual(Object.entries(restored!.record.vectors), Object.entries(f.record.vectors))
  assert.equal(restored!.record.version, 1, 'the physical layout does not leak into the in-memory domain record')
  assert.equal(summarizeIndexPage(restored!.record, restored!.chunks, 1).dataVersion,
    summarizeIndexPage(f.record, chunks, 1).dataVersion)
  restored!.record.vectors[chunks[0]!.id]!.sha256 = '0'.repeat(64)
  assert.equal((await readIndexPage(f.cache, key, generation, 1, 2, 1200))!.vectors.size, 1,
    'mutating a decoded record cannot modify an immutable vector in storage')
})

test('V2 headers written with the old failure-attempt checksum remain readable and normalize their data version', async () => {
  const f = fixture()
  f.record.failure = { code: 'pdf/index-image-unavailable', attempts: 2 }
  const built = buildIndexPageEntries(key, generation, f.record, f.chunks)
  for (const [recordKey, value] of built.entries) await f.cache.set(recordKey, value)
  const header = structuredClone(f.values.get(f.page)) as {
    chunkIds: string[]
    vectorRefs: Record<string, { sha256: string }>
    summary: { dataVersion: string; warnings: string[]; failure: { page: number; code: string; attempts: number } }
  }
  const orderedVectors = Object.entries(header.vectorRefs).sort(([left], [right]) => left.localeCompare(right))
    .map(([id, vector]) => [id, vector.sha256])
  header.summary.dataVersion = digest(JSON.stringify([header.chunkIds, orderedVectors,
    { code: header.summary.failure.code, attempts: header.summary.failure.attempts }, header.summary.warnings]))
  assert.notEqual(header.summary.dataVersion, summarizeIndexPage(f.record, f.chunks, 1).dataVersion,
    'the legacy checksum included diagnostic retry count')
  f.values.set(f.page, header)
  const light = await readIndexSummary(f.cache, key, generation, 1, 2, 1200)
  const full = await readIndexPage(f.cache, key, generation, 1, 2, 1200)
  assert.equal(light?.dataVersion, summarizeIndexPage(f.record, f.chunks, 1).dataVersion)
  assert.equal(full?.record.failure?.attempts, 2)
  assert.equal(summarizeIndexPage(full!.record, full!.chunks, full!.vectors.size).dataVersion, light?.dataVersion)
  header.summary.failure.attempts = 3
  await assert.rejects(readIndexSummary(f.cache, key, generation, 1, 2, 1200), corrupt,
    'a forged retry counter still invalidates an old checksum')
})

test('V2 embedding commits reuse loaded geometry and model-text vector keys instead of rewriting either payload', async () => {
  const f = fixture()
  const firstId = f.chunks[0]!.id, secondId = f.chunks[1]!.id
  const firstKey = `retrieval_${'b'.repeat(64)}`, secondKey = `retrieval_${'c'.repeat(64)}`
  await f.cache.set(firstKey, f.record.vectors[firstId])
  const built = buildIndexPageEntries(key, generation, f.record, f.chunks, undefined, { [firstId]: firstKey })
  assert.equal(built.entries.length, 2, 'an already durable model+text vector is referenced rather than duplicated')
  for (const [recordKey, value] of built.entries) await f.cache.set(recordKey, value)
  const loaded = (await readIndexPage(f.cache, key, generation, 1, 2, 1200))!
  loaded.record.vectors[secondId] = encodeCachedVector([0, 1])
  await f.cache.set(secondKey, loaded.record.vectors[secondId])
  const next = buildIndexPageEntries(key, generation, loaded.record, loaded.chunks, loaded.location, { [secondId]: secondKey })
  assert.equal(next.entries.length, 1, 'a later embedding batch writes only the small checkpoint header')
  assert.equal(next.location.contentKey, built.location.contentKey)
  for (const [recordKey, value] of next.entries) await f.cache.set(recordKey, value)
  assert.equal((await readIndexPage(f.cache, key, generation, 1, 2, 1200))!.vectors.size, 2)
  const changedContent = { ...loaded.record.content, warnings: ['A new quality warning'] }
  const changed = buildIndexPageEntries(key, generation, { ...loaded.record, content: changedContent }, loaded.chunks, next.location)
  assert.notEqual(changed.location.contentKey, next.location.contentKey)
  assert.ok(changed.entries.some(([recordKey]) => recordKey === changed.location.contentKey), 'changed content owns a new immutable record')
})

test('V2 legacy migration retains normalized float bytes and deduplicates fallback vector records', async () => {
  const f = fixture(), id = f.chunks[0]!.id
  const encoded = encodeCachedVector([3, 4])
  f.record.vectors = Object.fromEntries(f.chunks.map(chunk => [chunk.id, encoded]))
  f.values.set(f.page, f.record)
  const legacy = (await readIndexPage(f.cache, key, generation, 1, 2, 1200))!
  assert.equal(legacy.location, undefined)
  assert.deepEqual(legacy.record.vectors[id], encoded, 'valid vectors are not normalized and encoded a second time while reading')
  const built = buildIndexPageEntries(key, generation, legacy.record, legacy.chunks)
  assert.equal(built.entries.filter(([recordKey]) => recordKey.startsWith('index_vector_')).length, 1)
  for (const [recordKey, value] of built.entries) await f.cache.set(recordKey, value)
  assert.equal((await readIndexPage(f.cache, key, generation, 1, 2, 1200))!.vectors.size, 2)
})

test('V2 missing or damaged vectors become repairable gaps and lexical reads do not load vector payloads', async () => {
  const f = fixture(), id = f.chunks[0]!.id
  const built = buildIndexPageEntries(key, generation, f.record, f.chunks)
  for (const [recordKey, value] of built.entries) await f.cache.set(recordKey, value)
  const reference = built.location.vectorRefs[id]!
  f.values.delete(reference.key)
  const missing = (await readIndexPage(f.cache, key, generation, 1, 2, 1200))!
  assert.equal(missing.vectors.size, 0)
  assert.deepEqual(Object.keys(missing.location!.vectorRefs), [])
  f.values.set(reference.key, { ...f.record.vectors[id], sha256: 'f'.repeat(64) })
  assert.equal((await readIndexPage(f.cache, key, generation, 1, 2, 1200))!.vectors.size, 0)
  const lexicalStart = f.calls.length
  const lexical = await readIndexPage(f.cache, key, generation, 1, undefined, 1200)
  assert.equal(lexical!.vectors.size, 0)
  assert.deepEqual(f.calls.slice(lexicalStart), [f.page, built.location.contentKey])
})

test('V2 distinguishes missing content from corrupt headers, content hashes and mismatched page summaries', async () => {
  const f = fixture()
  const built = buildIndexPageEntries(key, generation, f.record, f.chunks)
  for (const [recordKey, value] of built.entries) await f.cache.set(recordKey, value)
  const header = structuredClone(f.values.get(f.page)) as Record<string, unknown>
  const content = f.values.get(built.location.contentKey)
  f.values.delete(built.location.contentKey)
  await assert.rejects(readIndexPage(f.cache, key, generation, 1, 2, 1200), { code: 'pdf/index-storage-missing' })
  f.values.set(built.location.contentKey, { ...f.content, text: 'Tampered page text' })
  await assert.rejects(readIndexPage(f.cache, key, generation, 1, 2, 1200), corrupt)
  f.values.set(built.location.contentKey, content)
  for (const value of [
    { ...header, page: 2 }, { ...header, generation: otherGeneration },
    { ...header, contentKey: '../../invalid' },
    { ...header, summary: { ...header.summary as Record<string, unknown>, embedded: 50 } },
    { ...header, summary: { ...header.summary as Record<string, unknown>, chunks: 50 } },
    { ...header, summary: { ...header.summary as Record<string, unknown>, noText: true } },
    { ...header, summary: { ...header.summary as Record<string, unknown>, ocr: true } },
    { ...header, summary: { ...header.summary as Record<string, unknown>, descriptions: true } },
    { ...header, vectorRefs: { invalid: { key: 'valid_key', sha256: 'f'.repeat(64) } } },
  ]) {
    f.values.set(f.page, value)
    await assert.rejects(readIndexPage(f.cache, key, generation, 1, 2, 1200), corrupt)
  }
})

test('V2 partial extraction failure is preserved in light and full summaries, and stale chunk metadata cannot certify changed content', async () => {
  const f = fixture()
  const cache: RetrievalCache = { ...f.cache, async has(recordKey) { return f.values.has(recordKey) } }
  f.record.failure = { code: 'ocr/offline', attempts: 2 }
  const built = buildIndexPageEntries(key, generation, f.record, f.chunks)
  for (const [recordKey, value] of built.entries) await cache.set(recordKey, value)
  const summary = await readIndexSummary(cache, key, generation, 1, 2, 1200)
  assert.deepEqual(summary!.failure, { page: 1, ...f.record.failure })
  const loaded = (await readIndexPage(cache, key, generation, 1, 2, 1200))!
  assert.deepEqual(summary, summarizeIndexPage(loaded.record, loaded.chunks, 1))
  const header = f.values.get(f.page) as { summary: Record<string, unknown> }
  f.values.set(f.page, { ...header, summary: { ...header.summary, failure: { page: 2, code: 'ocr/offline', attempts: 2 } } })
  await assert.rejects(readIndexSummary(cache, key, generation, 1, 2, 1200), corrupt)
  const stale = buildIndexPageEntries(key, generation, { ...f.record, vectors: {} },
    chunkRetrievalPage(1, { source: 'pdf-text', text: 'Different evidence text.' }))
  for (const [recordKey, value] of stale.entries) await cache.set(recordKey, value)
  await assert.rejects(readIndexPage(cache, key, generation, 1, 2, 1200), corrupt)
})

test('V2 builders reject unknown vector owners and unsafe external references before generating a checkpoint', () => {
  const f = fixture(), id = f.chunks[0]!.id
  assert.throws(() => buildIndexPageEntries(key, generation,
    { ...f.record, vectors: { unknown: encodeCachedVector([1, 0]) } }, f.chunks), corrupt)
  assert.throws(() => buildIndexPageEntries(key, generation,
    { ...f.record, vectors: { [id]: { ...f.record.vectors[id]!, sha256: 'invalid' } } }, f.chunks), corrupt)
  assert.throws(() => buildIndexPageEntries(key, generation, f.record, f.chunks, undefined, { [id]: '../unsafe' }), corrupt)
})

test('V2 summary restore validates vectors and source presence without loading page geometry', async () => {
  const f = fixture(), hasCalls: string[] = []
  const cache: RetrievalCache = { ...f.cache, async has(recordKey) { hasCalls.push(recordKey); return f.values.has(recordKey) } }
  const built = buildIndexPageEntries(key, generation, f.record, f.chunks)
  for (const [recordKey, value] of built.entries) await cache.set(recordKey, value)
  const summary = await readIndexSummary(cache, key, generation, 1, 2, 1200)
  assert.deepEqual(summary, summarizeIndexPage(f.record, f.chunks, 1))
  assert.deepEqual(hasCalls, [built.location.contentKey])
  assert.ok(!f.calls.includes(built.location.contentKey), 'warm restore must not load, parse or rechunk immutable glyph geometry')
  const lexicalStart = f.calls.length
  const lexical = await readIndexSummary(cache, key, generation, 1, undefined, 1200)
  assert.equal(lexical!.embedded, 0)
  assert.deepEqual(f.calls.slice(lexicalStart), [f.page])
  assert.deepEqual(lexical, summarizeIndexPage({ ...f.record, vectors: {} }, f.chunks, 0))
})

test('V2 summary corruption and missing vectors never claim complete embedding coverage', async () => {
  const f = fixture(), id = f.chunks[0]!.id
  const cache: RetrievalCache = { ...f.cache, async has(recordKey) { return f.values.has(recordKey) } }
  const built = buildIndexPageEntries(key, generation, f.record, f.chunks)
  for (const [recordKey, value] of built.entries) await cache.set(recordKey, value)
  const vectorKey = built.location.vectorRefs[id]!.key, original = f.values.get(vectorKey)
  for (const value of [undefined, {}, { ...f.record.vectors[id], data: 'damaged' }]) {
    f.values.set(vectorKey, value)
    const summary = await readIndexSummary(cache, key, generation, 1, 2, 1200)
    const loaded = (await readIndexPage(cache, key, generation, 1, 2, 1200))!
    assert.equal(summary!.embedded, 0)
    assert.deepEqual(summary, summarizeIndexPage(loaded.record, loaded.chunks, 0),
      'light and full restore agree on incomplete coverage and exact data identity')
  }
  f.values.set(vectorKey, original)
  const header = f.values.get(f.page) as Record<string, unknown>
  f.values.set(f.page, { ...header, chunkIds: [id, id] })
  await assert.rejects(readIndexSummary(cache, key, generation, 1, 2, 1200), corrupt)
  f.values.set(f.page, header); f.values.delete(built.location.contentKey)
  await assert.rejects(readIndexSummary(cache, key, generation, 1, 2, 1200), { code: 'pdf/index-storage-missing' })
})

test('full and fast reads recover proven double-normalized references without changing evidence or data identity', async () => {
  for (const firstRead of ['full', 'fast'] as const) {
    const f = await doubleNormalizationFixture(), original = structuredClone(f.header)
    const content = structuredClone(f.values.get(f.contentKey))
    if (firstRead === 'fast') {
      const light = await readIndexSummary(f.cache, key, generation, 1, 2, 1200)
      assert.deepEqual(light, original.summary)
      assert.equal(f.calls.includes(f.contentKey), false, 'fast recovery does not load OCR or glyph geometry')
    } else {
      const loaded = (await readIndexPage(f.cache, key, generation, 1, 2, 1200))!
      assert.deepEqual(loaded.record.vectors[f.id], f.rebuilt)
      assert.deepEqual([...loaded.vectors.get(f.id)!], decodeCachedVector(f.rebuilt, 2))
      assert.deepEqual(loaded.record.content, f.content)
      assert.deepEqual(loaded.location!.vectorRefs[f.id], { key: f.targetKey, sha256: f.rebuilt.sha256 })
      assert.deepEqual(summarizeIndexPage(loaded.record, loaded.chunks, loaded.vectors.size), original.summary)
    }
    assert.equal(f.calls.filter(recordKey => recordKey === f.sourceKey).length, 1,
      'each path validates the source vector in its existing load pass')
    const repaired = f.values.get(f.page) as StoredIndexPageHeader
    assert.deepEqual(repaired, { ...original, vectorRefs: { [f.id]: { key: f.targetKey, sha256: f.rebuilt.sha256 } } })
    assert.deepEqual(f.header, original, 'recovery does not mutate the caller\'s scanned header')
    assert.deepEqual(f.values.get(f.sourceKey), f.source, 'the original reusable vector remains immutable')
    assert.deepEqual(f.values.get(f.targetKey), f.rebuilt)
    assert.deepEqual(f.values.get(f.contentKey), content)
    assert.deepEqual(f.values.get(f.ocrKey), f.ocr)
    assert.deepEqual(f.casCalls, [f.targetKey, f.page], 'B is durable before the atomic header publication')
    const loaded = (await readIndexPage(f.cache, key, generation, 1, 2, 1200))!
    assert.deepEqual(await readIndexSummary(f.cache, key, generation, 1, 2, 1200),
      summarizeIndexPage(loaded.record, loaded.chunks, loaded.vectors.size))
    assert.equal(summarizeIndexPage(loaded.record, loaded.chunks, 1).dataVersion, original.summary.dataVersion)
    assert.deepEqual(f.casCalls, [f.targetKey, f.page], 'subsequent reads perform no migration writes')
  }
})

test('scanned header recovery infers validated dimensions, reuses existing B and is idempotent without reading content', async () => {
  const f = await doubleNormalizationFixture()
  f.values.set(f.targetKey, structuredClone(f.rebuilt))
  f.values.delete(f.contentKey)
  const repaired = await recoverIndexPageHeader(f.cache, f.page, f.header)
  assert.equal(repaired!.repairedReferences, 1); assert.equal(repaired!.persisted, true)
  assert.equal(repaired!.header.vectorRefs[f.id]!.key, f.targetKey)
  assert.deepEqual(repaired!.header.summary, f.header.summary)
  assert.deepEqual(f.casCalls, [f.page], 'validated immutable B is reused without being written again')
  const next = await recoverIndexPageHeader(f.cache, f.page, f.values.get(f.page))
  assert.equal(next!.repairedReferences, 0); assert.equal(next!.persisted, false)
  assert.deepEqual(f.casCalls, [f.page])
  assert.equal(f.calls.includes(f.contentKey), false)
  assert.equal(f.calls.includes(f.ocrKey), false)
  assert.equal(await recoverIndexPageHeader(f.cache, f.page, f.record), undefined, 'V1 pages remain on their normal reader')
  await assert.rejects(recoverIndexPageHeader(f.cache, f.sourceKey, f.header), corrupt,
    'the public repair entry point cannot overwrite arbitrary cache records')
  await assert.rejects(recoverIndexPageHeader(f.cache, 'index_page_unsafe', f.header), corrupt)
  await assert.rejects(recoverIndexPageHeader(f.cache, f.page, { ...f.header, summary: { ...f.header.summary, embedded: 99 } }), corrupt)
})

test('ports without atomic writes recover B in memory and leave all persistent records intact', async () => {
  const f = await doubleNormalizationFixture(), snapshot = structuredClone([...f.values])
  const cache: RetrievalCache = { async get(recordKey) { return f.cache.get(recordKey) },
    async has(recordKey) { return f.values.has(recordKey) }, async set() { assert.fail('read recovery must not write without CAS') } }
  const loaded = (await readIndexPage(cache, key, generation, 1, 2, 1200))!
  assert.deepEqual(loaded.record.vectors[f.id], f.rebuilt)
  assert.equal(loaded.location!.vectorRefs[f.id], undefined, 'a non-durable B key cannot be reused by a later checkpoint')
  const light = await readIndexSummary(cache, key, generation, 1, 2, 1200)
  assert.deepEqual(light, f.header.summary)
  assert.deepEqual(light, summarizeIndexPage(loaded.record, loaded.chunks, loaded.vectors.size))
  const recovered = await recoverIndexPageHeader(cache, f.page, f.header)
  assert.equal(recovered!.repairedReferences, 1); assert.equal(recovered!.persisted, false)
  assert.deepEqual(recovered!.header, f.header)
  assert.deepEqual([...f.values], snapshot)
  const checkpoint = buildIndexPageEntries(key, generation, loaded.record, loaded.chunks, loaded.location)
  assert.ok(checkpoint.entries.some(([recordKey, value]) => recordKey === f.targetKey && isDeepStrictEqual(value, f.rebuilt)),
    'normal checkpointing makes the recovered vector durable before publishing its reference')
})

test('high-dimensional multi-chunk recovery keeps fast, full and scanned results consistent in one vector-read pass', async () => {
  const f = fixture(), dimensions = 8192
  f.content.text = Array.from({ length: 12 }, (_, index) => `Distinct paragraph ${index} contains retained evidence.`).join('\n\n')
  const chunks = chunkRetrievalPage(1, f.content), input = new Array<number>(dimensions).fill(0)
  input[0] = 11; input[1] = 37
  const source = encodeCachedVector(input), rebuilt = encodeCachedVector(decodeCachedVector(source, dimensions)!)
  assert.notEqual(source.sha256, rebuilt.sha256)
  f.record.vectors = Object.fromEntries(chunks.map(chunk => [chunk.id, rebuilt]))
  const sourceKeys = Object.fromEntries(chunks.map(chunk => [chunk.id, `retrieval_${digest(chunk.id)}`]))
  const built = buildIndexPageEntries(key, generation, f.record, chunks, undefined, sourceKeys)
  for (const [recordKey, value] of built.entries) f.values.set(recordKey, structuredClone(value))
  for (const sourceKey of Object.values(sourceKeys)) f.values.set(sourceKey, source)
  const header = f.values.get(f.page) as StoredIndexPageHeader
  const cache: RetrievalCache = { ...f.cache, async has(recordKey) { return f.values.has(recordKey) } }
  const assertSinglePass = () => {
    for (const sourceKey of Object.values(sourceKeys)) assert.equal(f.calls.filter(recordKey => recordKey === sourceKey).length, 1)
    f.calls.length = 0
  }
  const light = await readIndexSummary(cache, key, generation, 1, dimensions, 1200)
  assert.equal(f.calls.includes(built.location.contentKey), false); assertSinglePass()
  const loaded = (await readIndexPage(cache, key, generation, 1, dimensions, 1200))!
  assertSinglePass()
  assert.deepEqual(light, summarizeIndexPage(loaded.record, loaded.chunks, loaded.vectors.size))
  assert.deepEqual(light, header.summary)
  assert.equal(loaded.vectors.size, chunks.length)
  for (const vector of loaded.vectors.values()) assert.equal(vector.length, dimensions)
  const recovered = await recoverIndexPageHeader(cache, f.page, header)
  assertSinglePass()
  assert.equal(recovered!.repairedReferences, chunks.length)
  assert.deepEqual(recovered!.header.summary, light)
})

test('fast summaries and scanned recovery release high-dimensional vector payloads within a bounded heap', async () => {
  const storedIndexUrl = new URL('../../../src/modules/retrieval/stored-index.ts', import.meta.url).href
  const cacheUrl = new URL('../../../src/modules/retrieval/cache.ts', import.meta.url).href
  const textUrl = new URL('../../../src/modules/retrieval/text.ts', import.meta.url).href
  const script = `
    import assert from 'node:assert/strict'
    import { buildIndexPageEntries, readIndexSummary, recoverIndexPageHeader } from ${JSON.stringify(storedIndexUrl)}
    import { decodeCachedVector, digest, encodeCachedVector } from ${JSON.stringify(cacheUrl)}
    import { chunkRetrievalPage } from ${JSON.stringify(textUrl)}
    const key = 'a'.repeat(64), generation = ${JSON.stringify(generation)}, dimensions = 65536
    const content = { version: 1, source: 'pdf-text', text: Array.from({ length: 96 }, (_, index) =>
      'Distinct paragraph ' + index + ' contains retained evidence.').join('\\n\\n') }
    const chunks = chunkRetrievalPage(1, content), input = new Array(dimensions).fill(0)
    input[0] = 11; input[1] = 37
    const source = encodeCachedVector(input), rebuilt = encodeCachedVector(decodeCachedVector(source, dimensions))
    assert.notEqual(source.sha256, rebuilt.sha256)
    const record = { version: 1, page: 1, generation, content,
      vectors: Object.fromEntries(chunks.map(chunk => [chunk.id, rebuilt])) }
    const keys = Object.fromEntries(chunks.map(chunk => [chunk.id, 'retrieval_' + digest(chunk.id)]))
    const sourceKeys = new Set(Object.values(keys))
    const built = buildIndexPageEntries(key, generation, record, chunks, undefined, keys)
    const [pageKey, header] = built.entries.at(-1)
    let baseline = 0, peak = 0, reads = 0
    const cache = {
      async has(recordKey) { assert.equal(recordKey, built.location.contentKey); return true },
      async get(recordKey) {
        if (recordKey === pageKey) return header
        assert.ok(sourceKeys.has(recordKey), 'the lightweight path must not load geometry')
        reads++
        if (reads % 12 === 0) { global.gc(); peak = Math.max(peak, process.memoryUsage().heapUsed - baseline) }
        return source
      },
      async set() { assert.fail('read-only recovery cannot write') }
    }
    for (const mode of ['summary', 'scan']) {
      global.gc(); baseline = process.memoryUsage().heapUsed; peak = 0; reads = 0
      if (mode === 'summary') assert.deepEqual(await readIndexSummary(cache, key, generation, 1, dimensions, 1200), header.summary)
      else assert.equal((await recoverIndexPageHeader(cache, pageKey, header)).repairedReferences, chunks.length)
      assert.equal(reads, chunks.length)
      assert.ok(peak < 16 * 1024 * 1024, mode + ' retained whole-page decoded vectors: ' + peak + ' bytes')
    }
    process.stdout.write('bounded')
  `
  const result = await promisify(execFile)(process.execPath,
    ['--expose-gc', '--max-old-space-size=256', '--import', 'tsx', '--input-type=module', '--eval', script],
    { timeout: 30_000, maxBuffer: 1024 * 1024 })
  assert.equal(result.stdout, 'bounded')
})

test('unrelated checksum mismatches, invalid sources and wrong dimensions never qualify for double-normalization repair', async () => {
  const invalidSources: unknown[] = [
    undefined, {}, encodeCachedVector([0, 1]), [11, 37],
    { ...encodeCachedVector([11, 37]), data: 'damaged' },
    { ...encodeCachedVector([11, 37]), sha256: 'f'.repeat(64) },
    { ...encodeCachedVector([11, 37]), dimensions: 3 },
  ]
  for (const raw of invalidSources) {
    const f = await doubleNormalizationFixture()
    f.values.set(f.sourceKey, raw)
    const light = await readIndexSummary(f.cache, key, generation, 1, 2, 1200)
    const loaded = (await readIndexPage(f.cache, key, generation, 1, 2, 1200))!
    assert.equal(loaded.vectors.size, 0); assert.equal(light!.embedded, 0)
    assert.deepEqual(light, summarizeIndexPage(loaded.record, loaded.chunks, 0))
    const recovered = await recoverIndexPageHeader(f.cache, f.page, f.header, 2)
    assert.equal(recovered!.repairedReferences, 0)
    assert.deepEqual(f.values.get(f.page), f.header)
    assert.equal(f.values.has(f.targetKey), false); assert.deepEqual(f.casCalls, [])
  }
  const wrongDimensions = await doubleNormalizationFixture()
  assert.equal((await readIndexPage(wrongDimensions.cache, key, generation, 1, 3, 1200))!.vectors.size, 0)
  assert.equal((await recoverIndexPageHeader(wrongDimensions.cache, wrongDimensions.page, wrongDimensions.header, 3))!.repairedReferences, 0)
  for (const dimensions of [0, -1, 1.5, 65_537, Number.MAX_SAFE_INTEGER, Infinity]) {
    const f = await doubleNormalizationFixture()
    f.values.set(f.sourceKey, { ...f.source, dimensions })
    assert.equal((await recoverIndexPageHeader(f.cache, f.page, f.header))!.repairedReferences, 0)
    assert.deepEqual(f.casCalls, [], 'unattested migration dimensions are bounded before decoding')
  }
})

test('recovery verifies existing content-addressed B rather than blessing or overwriting corrupt target records', async () => {
  for (const target of [{}, encodeCachedVector([0, 1]), [11, 37], { data: 'damaged' }]) {
    const f = await doubleNormalizationFixture()
    f.values.set(f.targetKey, target)
    await assert.rejects(recoverIndexPageHeader(f.cache, f.page, f.header), corrupt)
    assert.deepEqual(f.values.get(f.page), f.header)
    assert.deepEqual(f.values.get(f.targetKey), target)
    assert.deepEqual(f.values.get(f.sourceKey), f.source)
    assert.deepEqual(f.casCalls, [])
  }
})

test('header CAS conflicts preserve the winning checkpoint and reject full, fast and scanned recovery as stale', async () => {
  for (const path of ['full', 'fast', 'scan'] as const) {
    const f = await doubleNormalizationFixture(), compareAndSet = f.cache.compareAndSet!
    const replacement = buildIndexPageEntries(key, generation, { ...f.record, vectors: {} }, f.chunks).entries.at(-1)![1]
    f.cache.compareAndSet = async (recordKey, expected, value) => {
      if (recordKey === f.page) { f.values.set(f.page, replacement); return false }
      return compareAndSet(recordKey, expected, value)
    }
    const read = path === 'full' ? readIndexPage(f.cache, key, generation, 1, 2, 1200)
      : path === 'fast' ? readIndexSummary(f.cache, key, generation, 1, 2, 1200)
        : recoverIndexPageHeader(f.cache, f.page, f.header)
    await assert.rejects(read, { code: 'pdf/stale-reader' })
    assert.deepEqual(f.values.get(f.page), replacement)
    assert.deepEqual(f.values.get(f.sourceKey), f.source)
    assert.deepEqual(f.values.get(f.targetKey), f.rebuilt, 'an unreferenced immutable B is safe after a lost publication race')
  }
})

test('racing immutable B insertion is re-read and verified before updating a page header', async () => {
  for (const validWinner of [true, false]) {
    const f = await doubleNormalizationFixture(), compareAndSet = f.cache.compareAndSet!
    const winner = validWinner ? f.rebuilt : encodeCachedVector([0, 1])
    f.cache.compareAndSet = async (recordKey, expected, value) => {
      if (recordKey === f.targetKey) { f.values.set(recordKey, winner); return false }
      return compareAndSet(recordKey, expected, value)
    }
    if (validWinner) {
      assert.equal((await recoverIndexPageHeader(f.cache, f.page, f.header))!.persisted, true)
      assert.equal((f.values.get(f.page) as StoredIndexPageHeader).vectorRefs[f.id]!.key, f.targetKey)
    } else {
      await assert.rejects(recoverIndexPageHeader(f.cache, f.page, f.header), corrupt)
      assert.deepEqual(f.values.get(f.page), f.header)
    }
    assert.deepEqual(f.values.get(f.targetKey), winner)
  }
})

test('failed vector or header persistence propagates storage errors while leaving the original checkpoint and OCR untouched', async () => {
  for (const failingRecord of ['vector', 'header'] as const) {
    for (const path of ['full', 'fast', 'scan'] as const) {
      const f = await doubleNormalizationFixture(), compareAndSet = f.cache.compareAndSet!
      const error = Object.assign(new Error('write refused'), { code: 'pdf/index-storage-write-failed' })
      f.cache.compareAndSet = async (recordKey, expected, value) => {
        if (recordKey === (failingRecord === 'vector' ? f.targetKey : f.page)) throw error
        return compareAndSet(recordKey, expected, value)
      }
      const read = path === 'full' ? readIndexPage(f.cache, key, generation, 1, 2, 1200)
        : path === 'fast' ? readIndexSummary(f.cache, key, generation, 1, 2, 1200)
          : recoverIndexPageHeader(f.cache, f.page, f.header)
      await assert.rejects(read, value => value === error)
      assert.deepEqual(f.values.get(f.page), f.header)
      assert.deepEqual(f.values.get(f.sourceKey), f.source)
      assert.deepEqual(f.values.get(f.ocrKey), f.ocr)
      assert.equal(f.values.has(f.targetKey), failingRecord === 'header')
    }
  }
})

test('summary restore falls back to full validation without an existence probe and keeps V1 arrays readable', async () => {
  const f = fixture(), id = f.chunks[0]!.id
  f.values.set(f.page, { ...f.record, vectors: { [id]: [3, 4] } })
  const legacy = (await readIndexPage(f.cache, key, generation, 1, 2, 1200))!
  assert.deepEqual(legacy.record.vectors[id], encodeCachedVector([3, 4]))
  assert.deepEqual(await readIndexSummary(f.cache, key, generation, 1, 2, 1200),
    summarizeIndexPage(legacy.record, legacy.chunks, legacy.vectors.size))
  const built = buildIndexPageEntries(key, generation, legacy.record, legacy.chunks)
  for (const [recordKey, value] of built.entries) await f.cache.set(recordKey, value)
  f.calls.length = 0
  await readIndexSummary(f.cache, key, generation, 1, 2, 1200)
  assert.ok(f.calls.includes(built.location.contentKey), 'ports without has() preserve content validation rather than guessing readiness')
  f.values.set(built.location.contentKey, { invalid: true })
  await assert.rejects(readIndexSummary(f.cache, key, generation, 1, 2, 1200), corrupt)
  const missing = fixture()
  assert.equal(await readIndexSummary(missing.cache, key, generation, 1, 2, 1200), undefined)
  const probing: RetrievalCache = { ...missing.cache, async has() { return false } }
  assert.equal(await readIndexSummary(probing, key, generation, 1, 2, 1200), undefined)
  missing.values.set(missing.page, null)
  assert.equal(await readIndexSummary(probing, key, generation, 1, 2, 1200), undefined)
  missing.values.set(missing.page, { ...missing.record, content: { ...missing.content, text: 42 } })
  await assert.rejects(readIndexSummary(probing, key, generation, 1, 2, 1200), corrupt,
    'legacy full restore validates its actual referenced content rather than trusting a presence probe')
})

test('summaries report source coverage and change data identity when persisted evidence or quality changes', () => {
  const f = fixture()
  const base = summarizeIndexPage(f.record, f.chunks, 1)
  assert.match(base.dataVersion, /^[a-f0-9]{64}$/)
  assert.equal(base.chunks, 2); assert.equal(base.embedded, 1)
  assert.equal(base.noText, false); assert.equal(base.ocr, false); assert.equal(base.descriptions, false)
  assert.deepEqual(base.warnings, [])
  assert.equal('text' in base, false)
  assert.equal(summarizeIndexPage(f.record, f.chunks, 1).dataVersion, base.dataVersion)
  const changedWarnings = { ...f.record, content: { ...f.content, warnings: ['OCR was partial.'] } }
  const changedFailure = { ...f.record, failure: { code: 'ocr/unavailable', attempts: 1 } }
  const changedVectors = { ...f.record, vectors: { [f.chunks[0]!.id]: encodeCachedVector([-3, 4]) } }
  for (const record of [changedWarnings, changedFailure, changedVectors]) {
    assert.notEqual(summarizeIndexPage(record, f.chunks, 1).dataVersion, base.dataVersion)
  }
  const changedChunks = chunkRetrievalPage(1, { source: 'pdf-text', text: 'Another exact evidence range.' })
  assert.notEqual(summarizeIndexPage(f.record, changedChunks, 1).dataVersion, base.dataVersion)
  assert.deepEqual(summarizeIndexPage(changedFailure, f.chunks, 1).failure, { page: 1, code: 'ocr/unavailable', attempts: 1 })
  assert.deepEqual(summarizeIndexPage(changedWarnings, f.chunks, 1).warnings, ['OCR was partial.'])
  const ocr = { ...f.chunks[0]!, source: 'ocr' as const }
  const description = { ...f.chunks[1]!, source: 'image-description' as const }
  const mixed = summarizeIndexPage(f.record, [ocr, description], 0)
  assert.equal(mixed.noText, false); assert.equal(mixed.ocr, true); assert.equal(mixed.descriptions, true)
  const visualOnly = summarizeIndexPage(f.record, [description], 0)
  assert.equal(visualOnly.noText, true); assert.equal(visualOnly.ocr, false); assert.equal(visualOnly.descriptions, true)
  assert.equal(summarizeIndexPage(f.record, [], 0).noText, true)
})

test('storage errors remain classified rather than masquerading as missing checkpoints', async () => {
  const error = Object.assign(new Error('storage refused'), { code: 'pdf/index-storage-read-failed' })
  const cache: RetrievalCache = { async get() { throw error }, async set() {} }
  await assert.rejects(readIndexHead(cache, key), value => value === error)
  await assert.rejects(readIndexPage(cache, key, generation, 1, 2, 1200), value => value === error)
})

test('volatile fallback bounds total storage, reclaims overwrites and clear, and never exposes mutable records', async () => {
  const cache = createVolatileIndexStore(80)
  const original = { text: 'a'.repeat(20), nested: { count: 1 } }
  await cache.set('first', original)
  original.nested.count = 2
  const restored = await cache.get('first') as typeof original
  assert.equal(restored.nested.count, 1)
  restored.nested.count = 3
  assert.equal((await cache.get('first') as typeof original).nested.count, 1)
  assert.equal(await cache.get('absent'), undefined)
  await assert.rejects(cache.set('second', { text: 'b'.repeat(50) }), error => {
    assert.equal((error as { code: string }).code, 'pdf/index-storage-limit')
    assert.deepEqual((error as { budget: unknown }).budget,
      { kind: 'record', limit: 80, used: Buffer.byteLength(JSON.stringify({ text: 'a'.repeat(20), nested: { count: 1 } })),
        requested: Buffer.byteLength(JSON.stringify({ text: 'b'.repeat(50) })) })
    return true
  })
  assert.equal(await cache.get('second'), undefined, 'a rejected write leaves the checkpoint map untouched')
  await cache.set('first', 'small')
  await cache.set('second', { text: 'b'.repeat(50) })
  assert.equal(await cache.get('first'), 'small')
  await cache.clear!()
  assert.equal(await cache.get('first'), undefined)
  await cache.set('third', 'c'.repeat(70))
  assert.equal(await cache.get('third'), 'c'.repeat(70))
  await cache.delete!('third')
  assert.equal(await cache.get('third'), undefined)
  await cache.delete!('absent')
  await cache.set('third', 'c'.repeat(70))
})
