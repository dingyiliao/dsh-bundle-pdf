import assert from 'node:assert/strict'
import test from 'node:test'
import { createRetrievalService } from '../../../src/modules/retrieval/service.ts'
import { measureIndexOperation, recordIndexPerformance, withIndexPerformance, type IndexPerformanceMetric } from '../../../src/modules/retrieval/performance.ts'
import type { RetrievalPorts } from '../../../src/modules/retrieval/types.ts'

function fixture(pages = 32, maxBatchSize = 16) {
  const records = new Map<string, unknown>(), batches: string[][] = [], transactions: string[][] = []
  let reads = 0
  const ports: RetrievalPorts = {
    cache: {
      async get(key) { return structuredClone(records.get(key)) },
      async has(key) { return records.has(key) },
      async set(key, value) { records.set(key, structuredClone(value)) },
      async setMany(entries) { transactions.push(entries.map(([key]) => key)); for (const [key, value] of entries) records.set(key, structuredClone(value)) },
    },
    documents: { snapshot: (_session, id) => ({ id, path: '/fixture.pdf', sourceDigest: 'fixture', contentVersion: 'fixture', pageCount: pages }) },
    pages: { async read(_s, _d, page) { reads++; return { text: `Unique paragraph on page ${page}.`, source: 'pdf-text' } } },
    embedding: { select: () => ({ fingerprint: 'fixture', dimensions: 2, maxBatchSize,
      async embed(texts) { batches.push(texts); return texts.map(() => [1, 0]) } }) },
  }
  return { ports, records, batches, transactions, reads: () => reads }
}

test('short pages share bounded embedding batches and publish durable page progress after the vector transaction', async () => {
  const f = fixture(), service = createRetrievalService(f.ports)
  try {
    await service.prepare('a', { documentId: 'doc' })
    assert.equal(f.batches.flat().length, 32)
    assert.ok(f.batches.length <= 3, '32 single-chunk pages require at most three requests with the 20-page step boundary')
    assert.ok(f.batches.every(batch => batch.length <= 16))
    const vectors = f.transactions.filter(keys => keys.every(key => key.startsWith('retrieval_')))
    assert.equal(vectors.length, f.batches.length)
    assert.ok(vectors.some(keys => keys.length === 16), 'the backend receives one transaction for a full batch')
    await service.prepare('b', { documentId: 'doc' })
    assert.equal(f.reads(), 32)
    assert.equal(f.batches.flat().length, 32)
  } finally { await service.dispose() }
})

test('identical text on separate pages is embedded once and assigned to every matching chunk', async () => {
  const f = fixture(8)
  f.ports.pages.read = async () => ({ text: 'One shared paragraph.', source: 'pdf-text' })
  const service = createRetrievalService(f.ports)
  try {
    await service.prepare('a', { documentId: 'doc' })
    assert.deepEqual(f.batches, [['One shared paragraph.']])
    const result = await service.search('a', { documentId: 'doc', query: 'shared', mode: 'lexical' })
    assert.equal(result.coverage.indexedPages, 8)
  } finally { await service.dispose() }
})

test('a failed page publication reuses its independently committed model batch after service restart', async () => {
  const f = fixture(3)
  let failed = false
  const setMany = f.ports.cache!.setMany!
  f.ports.cache!.setMany = async entries => {
    if (!failed && f.batches.length && entries.some(([key]) => key.startsWith('index_page_'))) {
      failed = true
      throw Object.assign(new Error('Disk unavailable'), { code: 'pdf/index-storage-unavailable' })
    }
    await setMany(entries)
  }
  let service = createRetrievalService(f.ports)
  try {
    await assert.rejects(service.prepare('a', { documentId: 'doc' }), { code: 'pdf/index-storage-unavailable' })
    assert.equal(f.batches.length, 1)
    await service.dispose()
    service = createRetrievalService(f.ports)
    await service.prepare('a', { documentId: 'doc' })
    assert.equal(f.batches.length, 1)
    assert.equal(f.reads(), 3)
  } finally { await service.dispose() }
})

test('one preparation slice yields without discarding its generation or successful pages', async () => {
  const f = fixture(3); f.ports.limits = { pagesPerStep: 1 }
  const service = createRetrievalService(f.ports)
  try {
    assert.equal(await service.prepareSlice('a', { documentId: 'doc' }), false)
    assert.equal(f.reads(), 1)
    await service.prepare('a', { documentId: 'doc' })
    assert.equal(f.reads(), 3)
    assert.equal(await service.prepareSlice('a', { documentId: 'doc' }), true)
  } finally { await service.dispose() }
})

test('performance scopes isolate concurrent attempts, measure failed operations and tolerate broken observers', async () => {
  const a: IndexPerformanceMetric[] = [], b: IndexPerformanceMetric[] = []
  await Promise.all([
    withIndexPerformance(metric => a.push(metric), () => measureIndexOperation('page-extraction', async () => { await Promise.resolve(); return 1 }, { records: 1 })),
    withIndexPerformance(metric => b.push(metric), async () => {
      await assert.rejects(measureIndexOperation('embedding-batch', async () => { throw new Error('fixture') }))
      recordIndexPerformance({ stage: 'Unsafe path /document.pdf', durationMs: 1 })
      recordIndexPerformance({ stage: 'embedding-batch', durationMs: -1 })
      recordIndexPerformance({ stage: 'embedding-batch', durationMs: Infinity })
    }),
  ])
  assert.deepEqual(a.map(metric => metric.stage), ['page-extraction'])
  assert.deepEqual(b.map(metric => metric.stage), ['embedding-batch'])
  assert.equal(a[0]!.records, 1)
  assert.ok(b[0]!.durationMs >= 0)
  withIndexPerformance(() => { throw new Error('broken observer') }, () => recordIndexPerformance({ stage: 'safe', durationMs: 0 }))
  recordIndexPerformance({ stage: 'safe', durationMs: 0 })
})

test('missing immutable content is repaired on ordinary resume and on a new structural generation', async t => {
  for (const rebuild of [false, true]) await t.test(rebuild ? 'new generation' : 'resume', async () => {
    const f = fixture(2)
    let service = createRetrievalService(f.ports)
    try {
      await service.prepare('a', { documentId: 'doc' }); await service.dispose()
      const key = [...f.records.keys()].find(key => key.startsWith('index_content_'))!
      assert.ok(key); f.records.delete(key)
      service = createRetrievalService(f.ports)
      await service.prepare('a', { documentId: 'doc', ...(rebuild ? { rebuild: true, rebuildToken: 'repair-content-missing-from-seed' } : {}) })
      assert.ok(f.records.has(key))
      assert.equal(f.reads(), 2, 'the independent source cache repairs lost geometry without extraction')
      assert.equal(f.batches.length, 1, 'durable model/text vectors are reused')
    } finally { await service.dispose() }
  })
})

test('a slow page yields its preparation slice at the soft deadline after checkpointing at least one model batch', async t => {
  const f = fixture(3)
  let clock = 0
  t.mock.method(performance, 'now', () => clock)
  const read = f.ports.pages.read
  f.ports.pages.read = async (...args) => { clock += 800; return read(...args) }
  const service = createRetrievalService(f.ports)
  try {
    assert.equal(await service.prepareSlice('a', { documentId: 'doc' }), false)
    assert.equal(f.reads(), 1)
    assert.equal(f.batches.flat().length, 1)
    await service.prepare('a', { documentId: 'doc' })
    assert.equal(f.reads(), 3)
  } finally { await service.dispose() }
})

test('a small working budget flushes the page window instead of rejecting individually processable pages', async () => {
  const f = fixture(10)
  f.ports.limits = { maxMemoryBytes: 16 * 1024 }
  f.ports.pages.read = async (_s, _d, page) => ({ text: `Page ${page}. ` + 'Content words. '.repeat(55), source: 'pdf-text' })
  const service = createRetrievalService(f.ports)
  try {
    await service.prepare('a', { documentId: 'doc' })
    assert.equal(f.batches.flat().length, 10)
    assert.ok(f.batches.length > 1, 'the bounded window deliberately sends smaller batches')
  } finally { await service.dispose() }
})

test('legacy pages with over 256 unique vectors migrate in ordered backend batches without new inference', async () => {
  const f = fixture(1)
  f.ports.pages.read = async () => ({ text: Array.from({ length: 300 }, (_, i) => `Paragraph ${i}.`).join('\n\n'), source: 'pdf-text' })
  f.ports.embedding = { select: () => ({ fingerprint: 'legacy-fixture', dimensions: 2, maxBatchSize: 16,
    async embed(texts) { f.batches.push(texts); return texts.map(text => [1, Number(text.match(/\d+/)![0]) + 1]) } }) }
  let service = createRetrievalService(f.ports)
  try {
    await service.prepare('a', { documentId: 'doc' }); await service.dispose()
    const entry = [...f.records].find(([key]) => key.startsWith('index_page_'))!
    const header = entry[1] as { page: number; generation: string; contentKey: string; vectorRefs: Record<string, { key: string }> }
    f.records.set(entry[0], { version: 1, page: header.page, generation: header.generation,
      content: f.records.get(header.contentKey), vectors: Object.fromEntries(Object.entries(header.vectorRefs).map(([id, ref]) => [id, f.records.get(ref.key)])) })
    const requests = f.batches.length
    f.transactions.length = 0
    service = createRetrievalService(f.ports)
    await service.prepare('a', { documentId: 'doc', rebuild: true, rebuildToken: 'migrate-legacy-page' })
    assert.equal(f.batches.length, requests)
    assert.ok(f.transactions.some(keys => keys.length === 256))
    assert.ok(f.transactions.every(keys => keys.length <= 256))
    const last = f.transactions.findLast(keys => keys.some(key => key.startsWith('index_page_')))!
    assert.ok(last.at(-1)!.startsWith('index_page_'), 'page publication stays after immutable content and vectors')
  } finally { await service.dispose() }
})

test('oversized model output is rejected before calling inference instead of allocating an unbounded batch', async () => {
  const f = fixture(1)
  f.ports.embedding = { select: () => ({ fingerprint: 'oversized-fixture', dimensions: 100_000_000, maxBatchSize: 16,
    async embed() { assert.fail('inference must not start outside the memory budget') } }) }
  const service = createRetrievalService(f.ports)
  try {
    await assert.rejects(service.prepare('a', { documentId: 'doc' }), { code: 'pdf/retrieval-memory-budget' })
  } finally { await service.dispose() }
})
