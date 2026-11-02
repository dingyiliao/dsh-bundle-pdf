import assert from 'node:assert/strict'
import test from 'node:test'
import { searchStoredIndex, type SearchPage, type StoredIndexSearchOptions } from '../../../src/modules/retrieval/streaming-search.ts'
import { createBm25Index, rankVectors, searchBm25 } from '../../../src/modules/retrieval/ranking.ts'
import type { RetrievalChunk } from '../../../src/modules/retrieval/text.ts'

const chunk = (id: string, page: number, text: string): RetrievalChunk => ({ id, page, text,
  startUtf16: 0, endUtf16: text.length, pageTextDigest: 'a'.repeat(64), source: 'pdf-text' })
function options(source: readonly SearchPage[], overrides: Partial<StoredIndexSearchOptions> = {}) {
  return { async *pages() { yield* source }, query: 'causal', terms: [] as string[], mode: 'hybrid' as const,
    queryVector: [1, 2], limit: 5, signal: new AbortController().signal, check() {}, ...overrides }
}

test('streamed branches exactly match global BM25 and cosine ranking over uneven pages and query terms', async () => {
  const pages: SearchPage[] = [
    { page: 1, chunks: [chunk('b', 1, 'causal inference causal 原文')] },
    { page: 3, chunks: [chunk('a', 3, 'causal'), chunk('z', 3, 'causal 中文概率模型 ＰＤＦ'),
      chunk('long', 3, 'causal general '.repeat(70)), chunk('empty', 3, '')] },
    { page: 4, chunks: [] },
    { page: 9, chunks: [chunk('rare', 9, 'rare identification 原文 中文概率模型'), chunk('absent', 9, 'attention')] },
  ]
  let ordinal = 0
  for (const page of pages) page.vectors = new Map(page.chunks.filter(value => value.id !== 'empty')
    .map(value => [value.id, Float32Array.from([++ordinal, ordinal % 3 - 1])]))
  const chunks = pages.flatMap(page => page.chunks), vectors = pages.flatMap(page => [...page.vectors!]
    .map(([chunkId, vector]) => ({ chunkId, vector })))
  for (const mode of ['lexical', 'semantic', 'hybrid'] as const) {
    let scans = 0
    const input = options(pages, { mode, query: 'causal causal ＰＤＦ', terms: ['原文', '中文概率模型', 'identification'],
      async *pages() { scans++; yield* pages } })
    const result = await searchStoredIndex(input)
    const lexical = mode === 'semantic' ? [] : searchBm25(createBm25Index(chunks), [input.query, ...input.terms].join(' '), input.limit)
    const semantic = mode === 'lexical' ? [] : rankVectors(input.queryVector!, vectors, input.limit)
    assert.deepEqual(result.lexical, lexical)
    assert.deepEqual(result.semantic, semantic)
    assert.deepEqual(new Set(result.chunks.map(value => value.id)), new Set([...lexical, ...semantic].map(value => value.chunkId)))
    assert.ok(result.chunks.every(value => chunks.includes(value)), 'selected evidence keeps the actual persisted chunk')
    assert.equal(scans, mode === 'semantic' ? 1 : 2)
  }
})

test('ties retain deterministic IDs and negative cosine values across page boundaries', async () => {
  const pages = ['z', 'b', 'a', 'm'].map((id, index) => ({ page: index + 1,
    chunks: [chunk(id, index + 1, 'same text')], vectors: new Map([[id, Float32Array.from([-1, 0])]]) }))
  const result = await searchStoredIndex(options(pages, { query: 'same', queryVector: [1, 0], limit: 2 }))
  assert.deepEqual(result.lexical.map(row => row.chunkId), ['a', 'b'])
  assert.deepEqual(result.semantic, [{ chunkId: 'a', score: -1 }, { chunkId: 'b', score: -1 }])
  assert.equal(result.chunks.length, 2, 'overlapping winners are returned once')
})

test('many representations of one block cannot consume the entire bounded candidate window', async () => {
  const alternatives = Array.from({ length: 200 }, (_, index) => {
    const value = chunk(`alternative-${String(index).padStart(3, '0')}`, 1, 'needle')
    value.representation = { id: `alternative-${index}`, blockId: 'same-block', kind: 'image-description',
      unitDigest: 'a'.repeat(64), unitStartUtf16: 0, unitEndUtf16: value.text.length }
    return value
  })
  const distinct = chunk('distinct', 1, 'A longer distinct passage about the needle.')
  distinct.representation = { id: 'distinct-unit', blockId: 'distinct-block', kind: 'image-description',
    unitDigest: 'b'.repeat(64), unitStartUtf16: 0, unitEndUtf16: distinct.text.length }
  const ordinary = chunk('ordinary', 1, 'Needle context from ordinary native text.')
  const corpus = [...alternatives, distinct, ordinary]
  const vectors = new Map(corpus.map(value => [value.id, Float32Array.from(value === distinct ? [1, 1] : [1, 0])]))
  const result = await searchStoredIndex(options([{ page: 1, chunks: corpus, vectors }], { query: 'needle', queryVector: [1, 0], limit: 30 }))
  for (const branch of [result.lexical, result.semantic]) {
    assert.ok(branch.some(row => row.chunkId === 'distinct'))
    assert.ok(branch.some(row => row.chunkId === 'ordinary'))
    assert.equal(branch.filter(row => row.chunkId.startsWith('alternative-')).length, 8)
  }
  assert.ok(result.chunks.length <= 60)
})

test('one logical text block keeps multiple precise subranges and later better hits replace its worst retained candidate', async () => {
  const chunks = Array.from({ length: 80 }, (_, index) => {
    const value = chunk(`range-${String(index).padStart(3, '0')}`, 1, `needle ${'padding '.repeat(80 - index)}`)
    value.representation = { id: 'long-unit', blockId: 'long-block', kind: 'native-text',
      unitDigest: 'a'.repeat(64), unitStartUtf16: index * 100, unitEndUtf16: index * 100 + value.text.length }
    return value
  })
  const result = await searchStoredIndex(options([{ page: 1, chunks }], { mode: 'lexical', query: 'needle', limit: 80 }))
  const expected = searchBm25(createBm25Index(chunks), 'needle', 20)
  assert.deepEqual(result.lexical, expected)
  assert.equal(result.chunks.length, 20)
  assert.ok(result.chunks.every(value => value.representation?.id === 'long-unit'))
  assert.ok(new Set(result.chunks.map(value => value.representation!.unitStartUtf16)).size > 1)
})

test('empty text, unmatched queries and missing vectors never invent candidates or require another scan', async () => {
  assert.deepEqual(await searchStoredIndex(options([], { mode: 'lexical' })), { lexical: [], semantic: [], chunks: [] })
  const pages = [{ page: 1, chunks: [chunk('a', 1, '???')] }]
  let scans = 0
  assert.deepEqual(await searchStoredIndex(options(pages, { async *pages() { scans++; yield* pages } })),
    { lexical: [], semantic: [], chunks: [] })
  assert.equal(scans, 1, 'an entirely untokenizable corpus has no lexical second pass')
  assert.deepEqual(await searchStoredIndex(options([{ page: 1, chunks: [chunk('a', 1, 'cat')] }],
    { mode: 'lexical', query: 'absent' })), { lexical: [], semantic: [], chunks: [] })
  scans = 0
  await searchStoredIndex(options(pages, { query: '???', async *pages() { scans++; yield* pages } }))
  assert.equal(scans, 1, 'a query without tokens only executes its semantic pass')
  assert.deepEqual(await searchStoredIndex(options(pages, { mode: 'semantic' })), { lexical: [], semantic: [], chunks: [] })
})

test('invalid candidate limits and query or stored vectors fail before returning misleading ranks', async () => {
  for (const limit of [-1, 257, 1.5, NaN, Infinity]) await assert.rejects(searchStoredIndex(options([], { limit })), /limit/)
  let scans = 0
  assert.deepEqual(await searchStoredIndex(options([], { limit: 0, async *pages() { scans++ } })),
    { lexical: [], semantic: [], chunks: [] })
  assert.equal(scans, 0)
  for (const queryVector of [undefined, [], [0, 0], [NaN, 1], [Infinity, 1]]) {
    await assert.rejects(searchStoredIndex(options([], { mode: 'semantic', queryVector })))
  }
  const a = chunk('a', 1, 'text')
  for (const vector of [[], [0, 0], [1], [NaN, 1], [Infinity, 1]]) {
    await assert.rejects(searchStoredIndex(options([{ page: 1, chunks: [a], vectors: new Map([['a', Float32Array.from(vector)]]) }],
      { mode: 'semantic' })))
  }
  const malformed = new Map([['a', Float32Array.from([NaN, 0])]])
  assert.equal((await searchStoredIndex(options([{ page: 1, chunks: [a], vectors: malformed }], { mode: 'lexical', query: 'text' }))).lexical.length, 1,
    'lexical mode does not load or inspect unrelated vector data')
})

test('malformed page order, wrong page ownership and duplicate IDs are rejected on the bounded page boundary', async () => {
  const a = chunk('a', 1, 'text')
  for (const pages of [
    [{ page: 0, chunks: [] }], [{ page: NaN, chunks: [] }],
    [{ page: 1, chunks: [] }, { page: 1, chunks: [] }],
    [{ page: 2, chunks: [] }, { page: 1, chunks: [] }],
    [{ page: 2, chunks: [a] }], [{ page: 1, chunks: [a, a] }],
  ]) await assert.rejects(searchStoredIndex(options(pages)), /Stored retrieval/)
})

test('cancellation and source fences stop scans before publishing results and close the producer', async () => {
  const controller = new AbortController(), cancelled = new Error('reader closed')
  let scans = 0
  controller.abort(cancelled)
  await assert.rejects(searchStoredIndex(options([], { signal: controller.signal, async *pages() { scans++ } })), error => error === cancelled)
  assert.equal(scans, 0)
  const active = new AbortController()
  let closed = 0, pageReads = 0
  await assert.rejects(searchStoredIndex(options([], { signal: active.signal, async *pages() {
    try {
      pageReads++; yield { page: 1, chunks: [chunk('a', 1, 'cat')] }
      active.abort(cancelled)
      pageReads++; yield { page: 2, chunks: [chunk('b', 2, 'cat')] }
    } finally { closed++ }
  } })), error => error === cancelled)
  assert.equal(pageReads, 2); assert.equal(closed, 1)
  const stale = new Error('source replaced')
  let checks = 0
  await assert.rejects(searchStoredIndex(options([{ page: 1, chunks: [chunk('a', 1, 'cat')] }],
    { check() { if (++checks === 4) throw stale } })), error => error === stale)
  assert.equal(checks, 4)
})

test('large scans yield cooperatively and retain only the requested winner window with complete evidence', async () => {
  const count = 3000, limit = 7
  let scans = 0, reads = 0, turns = 0
  setImmediate(() => { turns++ })
  const result = await searchStoredIndex(options([], { query: 'needle', limit,
    async *pages() {
      scans++
      for (let page = 1; page <= count; page++) {
        reads++
        const id = String(page).padStart(6, '0')
        const value = chunk(id, page, page === count ? 'needle' : 'unrelated '.repeat(20))
        value.representation = { id: `unit-${page}`, blockId: `block-${page}`, kind: 'native-text',
          unitDigest: 'b'.repeat(64), unitStartUtf16: 0, unitEndUtf16: value.text.length,
          spans: [{ startUtf16: 0, endUtf16: 5, rectPdf: [10, 20, 30, 40] }] }
        yield { page, chunks: [value], vectors: new Map([[id, Float32Array.from([page, count - page + 1])]]) }
      }
    }, queryVector: [1, 0],
  }))
  assert.equal(scans, 2); assert.equal(reads, count * 2); assert.equal(turns, 1)
  assert.equal(result.lexical[0]!.chunkId, '003000')
  assert.equal(result.semantic[0]!.chunkId, '003000')
  assert.equal(result.semantic.length, limit)
  assert.ok(result.chunks.length <= limit * 2)
  assert.deepEqual(result.chunks.find(row => row.id === '003000')!.representation!.spans,
    [{ startUtf16: 0, endUtf16: 5, rectPdf: [10, 20, 30, 40] }])
})

test('a second-pass source change is checked before using newly read page contents', async () => {
  const stale = new Error('generation changed')
  let scans = 0
  await assert.rejects(searchStoredIndex(options([], { mode: 'lexical',
    async *pages() { scans++; yield { page: 1, chunks: [chunk('a', 1, 'cat')] } },
    check() { if (scans === 2) throw stale },
  })), error => error === stale)
  assert.equal(scans, 2)
})
