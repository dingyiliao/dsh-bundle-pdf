import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'
import { createRetrievalStore } from '../../../src/adapters/host/filesystem/retrieval-store.ts'
import { createRetrievalService } from '../../../src/modules/retrieval/service.ts'
import { chunkRetrievalPage, tokenizeRetrievalText } from '../../../src/modules/retrieval/text.ts'
import type { RetrievalEmbedding, RetrievalPage, RetrievalPorts } from '../../../src/modules/retrieval/types.ts'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
async function directory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'pdf-durable-index-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}
function fixture(path: string, pageTexts: string[], options: { batchSize?: number; memoryBytes?: number; source?: string;
  onDocumentEmbed?(texts: readonly string[], batch: number): Promise<void> } = {}) {
  const reads = new Map<number, number>(), embedded: string[] = [], leases: string[] = []
  let calls = 0, authorized = true, documentId = 'doc', source = options.source ?? 'source-digest', extraction = 'native-plus-ocr-v1'
  let store = createRetrievalStore({ directory: path, maxMemoryBytes: options.memoryBytes ?? 64 * 1024 })
  const provider: RetrievalEmbedding = { fingerprint: 'model-query-v1', documentFingerprint: 'stable-document-encoder-v1',
    generation: 'registration-1', configurationIdentity: 'query-config-1', dimensions: 2,
    maxBatchSize: options.batchSize ?? 2, maxInputCharacters: 1200,
    async embed(texts, purpose) {
      if (purpose === 'document') {
        await options.onDocumentEmbed?.(texts, ++calls)
        embedded.push(...texts)
      }
      return texts.map(text => purpose === 'query' || text.includes('needle-target') ? [1, 0] : [0, 1])
    },
  }
  const ports: RetrievalPorts = {
    documents: {
      snapshot(_session, id) {
        if (!authorized || id !== documentId) throw Object.assign(new Error('Document access revoked'), { code: 'pdf/unknown-document' })
        return { id, path: '/synthetic/durable.pdf', sourceDigest: source, contentVersion: source, pageCount: pageTexts.length }
      },
      async retain(session, _id, signal) {
        signal.throwIfAborted()
        if (!authorized) throw Object.assign(new Error('Document access revoked'), { code: 'pdf/unknown-document' })
        leases.push(session)
        return () => { leases.splice(leases.indexOf(session), 1) }
      },
    },
    pages: { identity: () => extraction, async read(_session, _id, page, signal) {
      signal.throwIfAborted(); reads.set(page, (reads.get(page) ?? 0) + 1)
      return { text: pageTexts[page - 1]!, source: 'pdf-text' }
    } },
    embedding: { select: () => provider }, cache: store,
    limits: { pagesPerStep: 2, embeddingBatchesPerStep: 2, maxMemoryBytes: 64 * 1024 * 1024 },
  }
  let service = createRetrievalService(ports)
  return { ports, reads, embedded, provider, leases,
    get store() { return store }, get service() { return service },
    setAuthorized(value: boolean) { authorized = value },
    setDocumentId(value: string) { documentId = value },
    setSource(value: string) { source = value },
    setExtraction(value: string) { extraction = value },
    async reopen() {
      await service.dispose(); await store.dispose()
      store = createRetrievalStore({ directory: path, maxMemoryBytes: options.memoryBytes ?? 64 * 1024 })
      ports.cache = store; service = createRetrievalService(ports)
    },
    async close() { await service.dispose(); await store.dispose() },
  }
}
async function records(path: string) {
  const db = new DatabaseSync(join(path, 'records.sqlite'), { readOnly: true })
  try {
    return db.prepare('SELECT id,key,envelope,bytes FROM records').all().map(row => ({
      id: String(row.id), key: String(row.key), bytes: Number(row.bytes),
      payload: (JSON.parse(String(row.envelope)) as { payload: unknown }).payload,
    }))
  } finally { db.close() }
}
function changeRecord(path: string, id: string, text?: string) {
  const db = new DatabaseSync(join(path, 'records.sqlite'))
  try {
    if (text === undefined) db.prepare('DELETE FROM records WHERE id=?').run(id)
    else db.prepare('UPDATE records SET envelope=?,bytes=? WHERE id=?').run(text, Buffer.byteLength(text), id)
  } finally { db.close() }
}
async function physicalBytes(path: string) {
  let bytes = 0
  for (const name of await readdir(path)) if (/^records\.sqlite(?:-wal|-shm)?$/.test(name)) bytes += (await stat(join(path, name))).size
  return bytes
}

test('a failed embedding batch resumes from disk after restart without rereading pages or recomputing successful vectors', async t => {
  const path = await directory(t)
  let failed = false
  const texts = Array.from({ length: 6 }, (_, page) => `Durable unique paragraph ${page}. ${page === 5 ? 'needle-target' : 'Context.'}`)
  const f = fixture(path, texts, { onDocumentEmbed: async (_texts, batch) => {
    if (batch === 2 && !failed) { failed = true; throw Object.assign(new Error('simulated connection reset'), { code: 'ECONNRESET' }) }
  } })
  try {
    await assert.rejects(f.service.prepare('first-session', { documentId: 'doc' }))
    const saved = [...f.embedded]
    assert.ok(saved.length > 0 && saved.length < texts.length, 'the fault occurs after useful model work was committed')
    assert.ok((await records(path)).some(row => row.key.startsWith('index_page_')))
    await f.reopen()
    await f.service.prepare('second-session', { documentId: 'doc' })
    assert.deepEqual([...f.reads.values()], texts.map(() => 1), 'successful extraction checkpoints survive the failed batch')
    assert.deepEqual([...f.embedded].sort(), [...texts].sort())
    assert.ok(saved.every(text => f.embedded.filter(value => value === text).length === 1))
    const result = await f.service.search('second-session', { documentId: 'doc', query: 'needle-target', mode: 'semantic', topK: 1 })
    assert.equal(result.status, 'complete'); assert.equal(result.chunks[0]!.page, 6)
    assert.equal(result.coverage.embeddedChunks, texts.length)
    assert.equal(f.leases.length, 0)
  } finally { await f.close() }
})

test('completed indexes reopen across sessions and document references while permission remains caller-owned', async t => {
  const path = await directory(t), f = fixture(path, ['First passage.', 'Second needle-target passage.'])
  try {
    await f.service.prepare('old-session', { documentId: 'doc' })
    const first = await f.service.search('old-session', { documentId: 'doc', query: 'needle-target', mode: 'semantic' })
    const embedded = f.embedded.length
    await f.reopen(); f.setDocumentId('new-reference')
    f.provider.generation = 'registration-after-restart'
    await f.service.prepare('new-session', { documentId: 'new-reference' })
    const reused = await f.service.search('new-session', { documentId: 'new-reference', query: 'needle-target', mode: 'semantic' })
    assert.equal(reused.indexGeneration, first.indexGeneration)
    assert.equal(f.embedded.length, embedded)
    assert.deepEqual([...f.reads.values()], [1, 1])
    assert.equal(reused.document.id, 'new-reference')
    assert.throws(() => f.service.validate('old-session', reused), { code: 'pdf/stale-reader' })
    f.setAuthorized(false)
    await assert.rejects(f.service.prepare('unauthorized', { documentId: 'new-reference' }), { code: 'pdf/unknown-document' })
    await assert.rejects(f.service.search('new-session', { documentId: 'new-reference', query: 'needle-target', mode: 'semantic' }), { code: 'pdf/unknown-document' })
    assert.equal(f.embedded.length, embedded, 'an on-disk index is not an access grant')
  } finally { await f.close() }
})

test('cancelling a pending model batch preserves prior page and vector checkpoints across restart', { timeout: 5000 }, async t => {
  const path = await directory(t), f = fixture(path, ['First saved paragraph.', 'Second pending paragraph.', 'Final needle-target paragraph.'], { batchSize: 1 })
  const controller = new AbortController(), original = f.provider.embed
  let calls = 0, pending!: () => void
  const started = new Promise<void>(resolve => { pending = resolve })
  f.provider.embed = async (texts, purpose, signal) => {
    if (purpose === 'document' && ++calls === 2) {
      pending()
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
    }
    return original(texts, purpose, signal)
  }
  try {
    const task = f.service.prepare('session', { documentId: 'doc' }, controller.signal)
    const rejected = assert.rejects(task, /cancelled|stopped/i)
    await started
    assert.equal(f.embedded.length, 1)
    controller.abort(new Error('Reader stopped indexing'))
    await rejected
    await f.reopen(); f.provider.embed = original
    await f.service.prepare('new-session', { documentId: 'doc' })
    assert.equal(f.embedded.length, 3)
    assert.ok(f.embedded.every(value => f.embedded.filter(text => text === value).length === 1))
    assert.deepEqual([...f.reads.values()], [1, 1, 1])
  } finally { controller.abort(); await f.close() }
})

test('a failed page-checkpoint write still reuses the independently persisted embedding batch after restart', async t => {
  const path = await directory(t), f = fixture(path, ['Durable batch before failed page checkpoint.'])
  let pageWrites = 0
  const interrupted = createRetrievalService({ ...f.ports, cache: {
    get: key => f.store.get(key),
    async set(key, value) {
      if (key.startsWith('index_page_') && ++pageWrites === 2) throw Object.assign(new Error('simulated disk publication failure'),
        { code: 'pdf/index-storage-write-failed' })
      await f.store.set(key, value)
    },
  } })
  try {
    await assert.rejects(interrupted.prepare('session', { documentId: 'doc' }), { code: 'pdf/index-storage-write-failed' })
    assert.equal(f.embedded.length, 1)
    await interrupted.dispose(); await f.reopen()
    await f.service.prepare('restarted', { documentId: 'doc' })
    assert.equal(f.embedded.length, 1, 'the completed model batch was saved before publishing page progress')
    assert.equal(f.reads.get(1), 1)
  } finally { await interrupted.dispose(); await f.close() }
})

test('query-only model changes reuse document vectors while source, extraction and document encoder changes get distinct index generations', async t => {
  const path = await directory(t), f = fixture(path, ['Source-specific needle-target paragraph.'])
  try {
    const inspect = async () => {
      await f.service.prepare('session', { documentId: 'doc' })
      return f.service.search('session', { documentId: 'doc', query: 'needle-target', mode: 'semantic' })
    }
    const original = await inspect(), initialEmbeddings = f.embedded.length
    await f.reopen()
    f.provider.fingerprint = 'model-query-v2'; f.provider.configurationIdentity = 'query-config-2'
    assert.equal((await inspect()).indexGeneration, original.indexGeneration)
    assert.equal(f.embedded.length, initialEmbeddings)
    f.provider.documentFingerprint = 'changed-document-encoder'
    const newModel = await inspect()
    assert.notEqual(newModel.indexGeneration, original.indexGeneration)
    assert.equal(f.embedded.length, initialEmbeddings + 1)
    f.setSource('new-source-bytes')
    const newSource = await inspect()
    assert.notEqual(newSource.indexGeneration, newModel.indexGeneration)
    f.setExtraction('new-ocr-engine-or-pipeline')
    const newExtraction = await inspect()
    assert.notEqual(newExtraction.indexGeneration, newSource.indexGeneration)
    assert.equal(f.reads.get(1), 3, 'new model reuses extracted text; new source and extraction identities do not')
  } finally { await f.close() }
})

test('partial extraction checkpoints retry only the failed page and preserve successful source-layer and vector caches', async t => {
  const path = await directory(t), f = fixture(path, ['Native page one.', 'Native page two.'])
  let available = false, nativeCalls = 0, ocrCalls = 0
  f.ports.pages.read = async (_session, _document, page, signal) => {
    signal.throwIfAborted(); f.reads.set(page, (f.reads.get(page) ?? 0) + 1)
    const key = `source_layer_native_${page}`
    let text = await f.store.get(key) as string | undefined
    if (!text) { nativeCalls++; text = `Native page ${page}.`; await f.store.set(key, text) }
    const result: RetrievalPage = { text, source: 'pdf-text' }
    if (page === 2) {
      ocrCalls++
      if (!available) return { ...result, failure: { code: 'ocr/engine-unavailable' } }
      result.units = [{ id: 'ocr-page-two', blockId: 'page-two', kind: 'ocr-text',
        text: 'Recovered needle-target OCR.', digest: `sha256:${sha('Recovered needle-target OCR.')}` }]
    }
    return result
  }
  try {
    await assert.rejects(f.service.prepare('session', { documentId: 'doc' }), { code: 'pdf/retrieval-incomplete' })
    const embeddedBefore = [...f.embedded]
    assert.equal(nativeCalls, 2); assert.ok(ocrCalls >= 1)
    await f.reopen(); available = true
    await f.service.prepare('session-after-restart', { documentId: 'doc' })
    assert.equal(nativeCalls, 2)
    assert.equal(f.reads.get(1), 1, 'the successful page is never reopened for OCR retry')
    assert.ok(embeddedBefore.every(text => f.embedded.filter(value => value === text).length === 1))
    const result = await f.service.search('session-after-restart', { documentId: 'doc', query: 'needle-target', mode: 'semantic', topK: 1 })
    assert.equal(result.status, 'complete'); assert.equal(result.chunks[0]!.source, 'ocr')
    assert.deepEqual(result.coverage.failedPages, [])
  } finally { await f.close() }
})

test('a concurrent repair cannot combine old coverage with newly replaced page representations in one search result', async t => {
  const path = await directory(t), f = fixture(path, ['Stable first page.', 'Pending second page.'])
  let repaired = false
  f.ports.pages.read = async (_session, _document, page) => page === 1 ? { text: 'Stable first page.', source: 'pdf-text' }
    : repaired ? { text: 'Recovered needle-target OCR.', source: 'ocr' }
      : { text: 'Partial native text.', source: 'pdf-text', failure: { code: 'ocr/unavailable' } }
  const original = f.provider.embed
  let repairDuringQuery = true
  try {
    await assert.rejects(f.service.prepare('reader', { documentId: 'doc' }), { code: 'pdf/retrieval-incomplete' })
    f.provider.embed = async (texts, purpose, signal) => {
      if (purpose === 'query' && repairDuringQuery) {
        repairDuringQuery = false; repaired = true
        await f.service.prepare('background-repair', { documentId: 'doc' }, signal)
      }
      return original(texts, purpose, signal)
    }
    await assert.rejects(f.service.search('reader', { documentId: 'doc', query: 'needle-target', mode: 'hybrid' }),
      { code: 'pdf/stale-reader' })
    const result = await f.service.search('reader', { documentId: 'doc', query: 'needle-target', mode: 'hybrid' })
    assert.equal(result.status, 'complete')
    assert.deepEqual(result.coverage.failedPages, [])
    assert.equal(result.chunks[0]!.text, 'Recovered needle-target OCR.')
  } finally { await f.close() }
})

test('stable rebuild tokens resume the same pending generation and new rebuilds reuse valid extracted text and vectors', async t => {
  const path = await directory(t)
  let interrupt = true
  const f = fixture(path, ['First independent paragraph.', 'Second independent paragraph.', 'needle-target last paragraph.'],
    { batchSize: 1, onDocumentEmbed: async (_texts, batch) => { if (batch === 2 && interrupt) throw new Error('interrupted') } })
  try {
    await assert.rejects(f.service.prepare('session', { documentId: 'doc', rebuild: true, rebuildToken: 'attempt-one' }))
    const before = (await records(path)).find(row => row.key.startsWith('index_head_'))!
    const pending = (before.payload as { pending: { id: string } }).pending.id
    await f.reopen(); interrupt = false
    await f.service.prepare('session', { documentId: 'doc', rebuild: true, rebuildToken: 'attempt-one' })
    const resumed = await f.service.search('session', { documentId: 'doc', query: 'needle-target', mode: 'semantic' })
    assert.equal(resumed.indexGeneration, pending)
    const embedded = f.embedded.length, reads = [...f.reads]
    await f.service.prepare('session', { documentId: 'doc', rebuild: true, rebuildToken: 'attempt-two' })
    const rebuilt = await f.service.search('session', { documentId: 'doc', query: 'needle-target', mode: 'semantic' })
    assert.notEqual(rebuilt.indexGeneration, resumed.indexGeneration)
    assert.equal(f.embedded.length, embedded)
    assert.deepEqual([...f.reads], reads)
  } finally { await f.close() }
})

test('corrupt persisted heads and page shards are explicit failures and a structural rebuild repairs them without repeated model work', async t => {
  for (const prefix of ['index_head_', 'index_page_']) await t.test(prefix, async t => {
    const path = await directory(t), f = fixture(path, ['Corruption fixture needle-target.'])
    try {
      await f.service.prepare('session', { documentId: 'doc' })
      const embedded = f.embedded.length, reads = [...f.reads]
      const target = (await records(path)).find(row => row.key.startsWith(prefix))!
      await f.reopen()
      changeRecord(path, target.id, '{damaged-record')
      await assert.rejects(f.service.prepare('session', { documentId: 'doc' }), { code: 'pdf/index-storage-corrupt' })
      assert.equal(f.embedded.length, embedded)
      await f.service.prepare('session', { documentId: 'doc', rebuild: true, rebuildToken: `repair-${prefix}` })
      const repaired = await f.service.search('session', { documentId: 'doc', query: 'needle-target', mode: 'semantic' })
      assert.equal(repaired.status, 'complete')
      assert.equal(f.embedded.length, embedded)
      assert.deepEqual([...f.reads], reads)
    } finally { await f.close() }
  })
})

test('a missing shard cannot silently produce complete coverage from retained runtime metadata', async t => {
  const path = await directory(t), f = fixture(path, ['Missing-shard needle-target content.'])
  try {
    await f.service.prepare('session', { documentId: 'doc' })
    const target = (await records(path)).find(row => row.key.startsWith('index_page_'))!
    changeRecord(path, target.id)
    // The on-disk snapshot is authoritative once its hot serialized copy has
    // left the bounded cache; keep the service's lightweight summary resident.
    for (let record = 0; record < 40; record++) await f.store.set(`eviction_${record}`, 'x'.repeat(2000))
    await assert.rejects(f.service.search('session', { documentId: 'doc', query: 'needle-target', mode: 'semantic' }),
      { code: 'pdf/index-storage-missing' })
    const embedded = f.embedded.length, reads = [...f.reads]
    await f.service.prepare('session', { documentId: 'doc', rebuild: true, rebuildToken: 'repair-missing-shard' })
    const repaired = await f.service.search('session', { documentId: 'doc', query: 'needle-target', mode: 'semantic' })
    assert.equal(repaired.status, 'complete')
    assert.equal(repaired.chunks[0]!.page, 1)
    assert.equal(f.embedded.length, embedded)
    assert.deepEqual([...f.reads], reads)
  } finally { await f.close() }
})

test('a V2 summary can restore without geometry, while a query verifies immutable content and rebuild repairs it', async t => {
  const path = await directory(t), f = fixture(path, ['Immutable content needle-target.'])
  try {
    await f.service.prepare('reader', { documentId: 'doc' })
    const saved = await records(path), header = saved.find(row => row.key.startsWith('index_page_'))!.payload as { version: number; contentKey: string }
    assert.equal(header.version, 2)
    const content = saved.find(row => row.key === header.contentKey)!
    assert.ok(content, 'V2 geometry is stored separately from its mutable page checkpoint')
    changeRecord(path, content.id, '{damaged-content')
    await f.reopen()
    const embedded = f.embedded.length, reads = [...f.reads]
    await f.service.prepare('new-reader', { documentId: 'doc' })
    assert.equal(f.embedded.length, embedded); assert.deepEqual([...f.reads], reads)
    await assert.rejects(f.service.search('new-reader', { documentId: 'doc', query: 'needle-target', mode: 'semantic' }),
      { code: 'pdf/index-storage-corrupt' }, 'a lightweight presence check cannot pass damaged content off as verified evidence')
    await f.service.prepare('new-reader', { documentId: 'doc', rebuild: true, rebuildToken: 'repair-immutable-content' })
    const result = await f.service.search('new-reader', { documentId: 'doc', query: 'needle-target', mode: 'semantic' })
    assert.equal(result.status, 'complete'); assert.equal(result.chunks[0]!.page, 1)
    assert.equal(f.embedded.length, embedded); assert.deepEqual([...f.reads], reads)
  } finally { await f.close() }
})

test('position-heavy native and OCR indexes exceed the former whole-corpus budget while the disk hot cache stays bounded', async t => {
  const count = 12, path = await directory(t), f = fixture(path, Array.from({ length: count }, () => ''), { memoryBytes: 64 * 1024, batchSize: 16 })
  const ordinary = 'Dense positioned source and OCR words. '.repeat(530)
  let previousAccounting = 0
  f.ports.pages.read = async (_session, _document, page, signal) => {
    signal.throwIfAborted(); f.reads.set(page, (f.reads.get(page) ?? 0) + 1)
    const text = `${page === count ? 'needle-target' : 'Page context'} ${page}. ${ordinary}`
    const ocr = `OCR ${page}. ${ordinary}`
    const spans = (value: string) => Array.from({ length: value.length }, (_, index) => ({ startUtf16: index,
      endUtf16: index + 1, rectPdf: [10 + index % 100, 20 + Math.floor(index / 100), 11 + index % 100, 21 + Math.floor(index / 100)] as [number, number, number, number] }))
    const result: RetrievalPage = { text, source: 'pdf-text', units: [
      { id: `native-${page}`, blockId: `block-${page}`, kind: 'native-text', text, digest: `sha256:${sha(text)}`,
        nativeRange: { startUtf16: 0, endUtf16: text.length }, spans: spans(text) },
      { id: `ocr-${page}`, blockId: `block-${page}`, kind: 'ocr-text', text: ocr, digest: `sha256:${sha(ocr)}`, spans: spans(ocr) },
    ] }
    const chunks = chunkRetrievalPage(page, result)
    previousAccounting += chunks.reduce((sum, value) => sum + value.text.length * 2 + 320
      + (value.representation ? JSON.stringify(value.representation).length * 2 + 128 : 0)
      + new Set(tokenizeRetrievalText(value.text)).size * 96, 128)
    return result
  }
  try {
    await f.service.prepare('session', { documentId: 'doc' })
    assert.ok(previousAccounting > 64 * 1024 * 1024, `synthetic whole-corpus accounting must reproduce the old failure (${previousAccounting} bytes)`)
    assert.ok(f.store.diagnostics().memoryBytes <= 64 * 1024)
    const diskBytes = await physicalBytes(path)
    assert.ok(diskBytes > f.store.diagnostics().memoryBytes)
    t.diagnostic(JSON.stringify({ pages: count, formerChargedBytes: previousAccounting, persistedBytes: diskBytes,
      hotCacheBytes: f.store.diagnostics().memoryBytes, hotCacheLimit: 64 * 1024 }))
    const embedded = f.embedded.length
    await f.reopen()
    await f.service.prepare('other-session', { documentId: 'doc' })
    const result = await f.service.search('other-session', { documentId: 'doc', query: 'needle-target', mode: 'hybrid', topK: 1 })
    assert.equal(result.status, 'complete'); assert.equal(result.chunks[0]!.page, count)
    assert.equal(f.embedded.length, embedded)
    assert.ok([...f.reads.values()].every(value => value === 1))
    assert.ok(f.store.diagnostics().memoryBytes <= 64 * 1024)
  } finally { await f.close() }
})
