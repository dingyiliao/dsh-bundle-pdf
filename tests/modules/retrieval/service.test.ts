import assert from 'node:assert/strict'
import test from 'node:test'
import { createRetrievalService } from '../../../src/modules/retrieval/service.ts'
import type { RetrievalDocument, RetrievalEmbedding, RetrievalInput, RetrievalPorts, RetrievalResult } from '../../../src/modules/retrieval/types.ts'

const document = (): RetrievalDocument => ({ id: 'doc', path: '/synthetic.pdf', sourceDigest: 'source-1', contentVersion: 'content-1', pageCount: 3 })
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0))
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(options: { text?: string[]; limits?: RetrievalPorts['limits']; provider?: RetrievalEmbedding } = {}) {
  const state = { document: document(), provider: options.provider }
  const text = options.text ?? ['A distant introduction.', 'The animal is a cat.', 'A cat sleeps in the garden.']
  state.document.pageCount = text.length
  const reads: number[] = []
  const stored = new Map<string, unknown>()
  const ports: RetrievalPorts = {
    documents: { snapshot: () => ({ ...state.document }) },
    pages: { read: async (_session, _document, page) => { reads.push(page); return { text: text[page - 1], source: 'pdf-text' } } },
    cache: { get: async key => stored.get(key), set: async (key, value) => { stored.set(key, value) } },
    embedding: { select: () => state.provider }, limits: options.limits,
  }
  return { state, ports, reads, stored, service: createRetrievalService(ports) }
}
const baseInput = { documentId: 'doc', query: 'cat' }
async function finish(service: ReturnType<typeof createRetrievalService>, input: RetrievalInput = baseInput): Promise<RetrievalResult> {
  let result = await service.search('session', input)
  for (let count = 0; result.status !== 'complete' && count < 30; count++) {
    result = await service.search('session', { ...input, cursor: result.nextCursor })
  }
  assert.equal(result.status, 'complete')
  return result
}
function embedding() {
  const calls: { purpose: string; texts: string[] }[] = []
  const provider: RetrievalEmbedding = {
    fingerprint: 'fixture-model-v1', dimensions: 2, maxBatchSize: 2, maxInputCharacters: 1200,
    embed: async (texts, purpose) => {
      calls.push({ texts, purpose })
      return texts.map(text => /cat|feline|猫/i.test(text) ? [1, 0] : [0, 1])
    },
  }
  return { provider, calls }
}

test('invalid embedding provider metadata fails before reading or indexing PDF content', async () => {
  for (const invalid of [{ dimensions: 0 }, { dimensions: 1.5 }, { maxBatchSize: 0 }, { maxInputCharacters: 63 }]) {
    const e = embedding()
    const f = fixture({ provider: { ...e.provider, ...invalid } })
    try {
      await assert.rejects(f.service.search('session', baseInput), { code: 'pdf/retrieval-invalid-provider' })
      assert.deepEqual(f.reads, [])
      assert.deepEqual(e.calls, [])
      assert.equal(f.stored.size, 0)
    } finally { await f.service.dispose() }
  }
})

test('incremental indexing publishes global scope ranking only when every page is indexed', async () => {
  const { service, reads } = fixture({ limits: { pagesPerStep: 1 } })
  const first = await service.search('session', baseInput)
  assert.equal(first.status, 'building'); assert.deepEqual(first.chunks, [])
  assert.deepEqual(first.scope, { fromPage: 1, toPage: 3 })
  assert.equal(first.coverage.indexedPages, 1); assert.equal(first.coverage.visual, 'not-indexed')
  const second = await service.search('session', { ...baseInput, cursor: first.nextCursor })
  assert.equal(second.status, 'building'); assert.deepEqual(second.chunks, [])
  const result = await service.search('session', { ...baseInput, cursor: second.nextCursor })
  assert.equal(result.status, 'complete'); assert.deepEqual(reads, [1, 2, 3])
  assert.equal(result.effectiveMode, 'lexical'); assert.equal(result.fallbackReason, 'embedding-engine-unavailable')
  assert.deepEqual(new Set(result.chunks.map(chunk => chunk.page)), new Set([2, 3]))
  for (const chunk of result.chunks) assert.ok(chunk.endUtf16 > chunk.startUtf16)
  assert.equal(result.nextCursor, undefined)
})

test('explicit page scope is indexed completely and exact original ranges survive normalized ranking', async () => {
  const text = ['A cat', '  ＣＡＴ on page two.  ', 'Cat on page three.']
  const { service, reads } = fixture({ text })
  const result = await finish(service, { ...baseInput, mode: 'lexical', fromPage: 2, maxPages: 1 })
  assert.deepEqual(reads, [2]); assert.deepEqual(result.scope, { fromPage: 2, toPage: 2 })
  assert.equal(result.chunks.length, 1)
  const chunk = result.chunks[0]
  assert.equal(text[1].slice(chunk.startUtf16, chunk.endUtf16), chunk.text)
  assert.ok(chunk.text.includes('ＣＡＴ'))
})

test('continuation rejects query, scope, mode, topK, document version and session changes', async () => {
  const f = fixture({ limits: { pagesPerStep: 1 } })
  const initial = await f.service.search('session', baseInput)
  for (const changes of [{ query: 'dog' }, { terms: ['animal'] }, { topK: 2 }]) {
    await assert.rejects(f.service.search('session', { ...baseInput, ...changes, cursor: initial.nextCursor }),
      { code: 'pdf/invalid-window', message: 'PDF search parameters do not match its saved progress; start a new search' })
  }
  for (const changes of [{ fromPage: 2 }, { maxPages: 2 }, { mode: 'lexical' as const }]) {
    await assert.rejects(f.service.search('session', { ...baseInput, ...changes, cursor: initial.nextCursor }), { code: 'pdf/stale-reader' })
  }
  await assert.rejects(f.service.search('other-session', { ...baseInput, cursor: initial.nextCursor }), { code: 'pdf/stale-reader' })
  f.state.document.sourceDigest = 'source-2'
  await assert.rejects(f.service.search('session', { ...baseInput, cursor: initial.nextCursor }), { code: 'pdf/stale-reader' })
  f.service.dispose()
})

test('malformed or modified generation cursors cannot resume an index', async () => {
  const { service } = fixture({ limits: { pagesPerStep: 1 } })
  const initial = await service.search('session', baseInput)
  for (const cursor of ['not-base64', `${initial.nextCursor}=`, Buffer.from(JSON.stringify({ version: 1 })).toString('base64url')]) {
    await assert.rejects(service.search('session', { ...baseInput, cursor }), { code: 'pdf/invalid-window' })
  }
  const decoded = JSON.parse(Buffer.from(initial.nextCursor!, 'base64url').toString())
  decoded.generation = '11111111-1111-4111-8111-111111111111'
  await assert.rejects(service.search('session', { ...baseInput, cursor: Buffer.from(JSON.stringify(decoded)).toString('base64url') }), { code: 'pdf/stale-reader' })
})

test('semantic and hybrid require an embedding provider and auto reports lexical fallback', async () => {
  const { service } = fixture()
  for (const mode of ['semantic', 'hybrid'] as const) {
    await assert.rejects(service.search('session', { ...baseInput, mode }), { code: 'pdf/retrieval-engine-unavailable' })
  }
  const result = await finish(service)
  assert.equal(result.effectiveMode, 'lexical'); assert.ok(result.fallbackReason)
})

test('semantic retrieval encodes query and documents separately and supports paraphrases', async () => {
  const e = embedding()
  const { service } = fixture({ provider: e.provider })
  const result = await finish(service, { ...baseInput, query: 'feline', mode: 'semantic', topK: 1 })
  assert.equal(result.chunks.length, 1); assert.match(result.chunks[0].text, /cat/)
  assert.equal(result.effectiveMode, 'semantic')
  assert.ok(e.calls.some(call => call.purpose === 'query' && call.texts[0] === 'feline'))
  assert.ok(e.calls.some(call => call.purpose === 'document'))
})

test('embedding work is bounded across continuations and no partial vector ranking escapes', async () => {
  const e = embedding(); e.provider.maxBatchSize = 1
  const { service } = fixture({ provider: e.provider, limits: { embeddingBatchesPerStep: 1 } })
  const first = await service.search('session', baseInput)
  assert.equal(first.coverage.indexedPages, 3); assert.equal(first.coverage.embeddedChunks, 1)
  assert.equal(first.status, 'building'); assert.deepEqual(first.chunks, [])
  assert.equal(e.calls.length, 1)
  const second = await service.search('session', { ...baseInput, cursor: first.nextCursor })
  assert.equal(second.coverage.embeddedChunks, 2); assert.equal(second.status, 'building')
  const last = await service.search('session', { ...baseInput, cursor: second.nextCursor })
  assert.equal(last.status, 'complete'); assert.equal(last.effectiveMode, 'hybrid')
})

test('saved byte changes re-extract page text but reuse unchanged document vectors', async () => {
  const e = embedding()
  const f = fixture({ provider: e.provider })
  const first = await finish(f.service)
  const documentCalls = e.calls.filter(call => call.purpose === 'document').length
  f.state.document.sourceDigest = 'saved-bytes'
  f.state.document.contentVersion = 'saved-content'
  const after = await finish(f.service)
  assert.notEqual(first.indexGeneration, after.indexGeneration)
  assert.equal(f.reads.length, 6)
  assert.equal(e.calls.filter(call => call.purpose === 'document').length, documentCalls)
  assert.equal(after.chunks[0].text, first.chunks[0].text)
})

test('derived page cache survives service disposal, ignores invalid entries and still requires document authorization', async () => {
  const f = fixture()
  await finish(f.service); f.service.dispose()
  await finish(createRetrievalService(f.ports))
  assert.equal(f.reads.length, 3)
  for (const key of f.stored.keys()) f.stored.set(key, { arbitrary: 'invalid' })
  await finish(createRetrievalService(f.ports))
  assert.equal(f.reads.length, 6)
  f.ports.documents.snapshot = () => { throw Object.assign(new Error('Denied'), { code: 'pdf/access-denied' }) }
  await assert.rejects(createRetrievalService(f.ports).search('forbidden', baseInput), { code: 'pdf/access-denied' })
})

test('source changes during extraction reject results before publishing old-source pages', async () => {
  const f = fixture()
  f.ports.pages.read = async () => { f.state.document.sourceDigest = 'changed'; return { text: 'cat', source: 'pdf-text' } }
  await assert.rejects(f.service.search('session', baseInput), { code: 'pdf/stale-reader' })
  assert.equal(f.stored.size, 0)
})

test('one cancelled subscriber does not cancel a shared index build used by another query', async () => {
  const gate = deferred<void>(); const started = deferred<void>()
  const f = fixture({ text: ['A cat'] })
  let calls = 0; let nativeSignal: AbortSignal | undefined
  f.ports.pages.read = async (_session, _document, _page, signal) => {
    calls++; nativeSignal = signal; started.resolve(); await gate.promise
    return { text: 'A cat', source: 'pdf-text' }
  }
  const cancel = new AbortController()
  const first = f.service.search('session', baseInput, cancel.signal)
  const second = f.service.search('session', { ...baseInput, query: 'animal cat' })
  await started.promise
  cancel.abort(new Error('First caller left'))
  await assert.rejects(first, /First caller left/)
  assert.equal(nativeSignal?.aborted, false)
  gate.resolve()
  assert.equal((await second).status, 'complete'); assert.equal(calls, 1)
})

test('all subscribers cancelling stops late extraction from entering an index or cache', async () => {
  const gate = deferred<void>(); const started = deferred<void>()
  const f = fixture({ text: ['A cat'] })
  let nativeSignal: AbortSignal | undefined
  f.ports.pages.read = async (_session, _document, _page, signal) => {
    nativeSignal = signal; started.resolve(); await gate.promise
    return { text: 'A cat', source: 'pdf-text' }
  }
  const cancel = new AbortController()
  const request = f.service.search('session', baseInput, cancel.signal)
  await started.promise; cancel.abort(new Error('Cancelled'))
  await assert.rejects(request, /Cancelled/); assert.equal(nativeSignal?.aborted, true)
  gate.resolve(); await turn(); await turn()
  assert.equal(f.stored.size, 0)
  assert.equal((await finish(f.service)).coverage.indexedPages, 1)
})

test('extraction failures are visible incomplete coverage and retry without misreporting no results', async () => {
  const f = fixture({ text: ['cat', 'second page'] })
  let failed = false
  f.ports.pages.read = async (_session, _document, page) => {
    if (page === 2 && !failed) { failed = true; throw Object.assign(new Error('Transient failure'), { code: 'native/failed' }) }
    return { text: 'A cat', source: 'pdf-text' }
  }
  const first = await f.service.search('session', baseInput)
  assert.equal(first.status, 'incomplete'); assert.equal(first.coverage.failedPages[0].attempts, 1)
  assert.equal(first.coverage.failedPages[0].page, 2); assert.deepEqual(first.chunks, [])
  const recovered = await f.service.search('session', { ...baseInput, cursor: first.nextCursor })
  assert.equal(recovered.status, 'complete'); assert.deepEqual(recovered.coverage.failedPages, [])
})

test('OCR, empty pages and extraction quality warnings remain distinct from visual coverage', async () => {
  const f = fixture()
  f.ports.pages.read = async (_session, _document, page) => page === 1
    ? { text: '', source: 'pdf-text' }
    : { text: 'A cat', source: 'ocr', warnings: ['OCR cannot provide exact native text geometry'] }
  const result = await finish(f.service)
  assert.deepEqual(result.coverage.noTextPages, [1]); assert.deepEqual(result.coverage.ocrPages, [2, 3])
  assert.equal(result.coverage.qualityWarnings.length, 2)
  assert.equal(result.coverage.visual, 'not-indexed')
  assert.ok(result.chunks.every(chunk => chunk.source === 'ocr'))
})

test('engine replacement during asynchronous embedding invalidates the result', async () => {
  const e = embedding(); const f = fixture({ provider: e.provider })
  const original = e.provider.embed
  e.provider.embed = async (...args) => {
    const result = await original(...args)
    f.state.provider = { ...e.provider, fingerprint: 'replacement' }
    return result
  }
  await assert.rejects(f.service.search('session', baseInput), { code: 'pdf/stale-reader' })
})

test('invalid embedding vectors cannot enter ranking or persistent vector cache', async () => {
  for (const vector of [[0, 0], [NaN, 1], [1]]) {
    const e = embedding(); e.provider.embed = async texts => texts.map(() => vector)
    const f = fixture({ provider: e.provider })
    await assert.rejects(f.service.search('session', baseInput), { code: 'pdf/retrieval-invalid-vector' })
    assert.equal([...f.stored.values()].filter(value => Array.isArray(value)).length, 0)
  }
})

test('session cancellation and disposal abort active query embeddings and reject late results', async () => {
  for (const action of ['cancelSession', 'dispose'] as const) {
    const e = embedding(); const gate = deferred<void>(); const started = deferred<void>()
    const original = e.provider.embed
    e.provider.embed = async (...args) => {
      if (args[1] === 'query') { started.resolve(); await gate.promise }
      return original(...args)
    }
    const f = fixture({ provider: e.provider })
    const pending = f.service.search('session', baseInput)
    await started.promise
    if (action === 'dispose') f.service.dispose(); else f.service.cancelSession('session')
    gate.resolve()
    await assert.rejects(pending, { code: 'pdf/cancelled' })
  }
})

test('memory, chunk and index-count limits fail explicitly rather than silently truncating scope', async () => {
  for (const limits of [{ maxMemoryBytes: 1 }, { maxChunks: 1 }]) {
    const f = fixture({ limits })
    await assert.rejects(f.service.search('session', baseInput), { code: 'pdf/retrieval-budget' })
  }
  const f = fixture({ limits: { maxIndexes: 1, pagesPerStep: 1 } })
  const first = await f.service.search('session', baseInput)
  await f.service.search('session', { ...baseInput, fromPage: 2 })
  await assert.rejects(f.service.search('session', { ...baseInput, cursor: first.nextCursor }), { code: 'pdf/stale-reader' })
})

test('empty-page coverage and extraction warnings also consume the bounded index budget', async () => {
  const blank = fixture({ text: ['', '', ''], limits: { maxMemoryBytes: 256 } })
  await assert.rejects(blank.service.search('session', baseInput), { code: 'pdf/retrieval-budget' })
  await blank.service.dispose()
  const warned = fixture({ text: [''], limits: { maxMemoryBytes: 1000 } })
  warned.ports.pages.read = async () => ({ text: '', source: 'pdf-text', warnings: ['x'.repeat(500)] })
  await assert.rejects(warned.service.search('session', baseInput), { code: 'pdf/retrieval-budget' })
  await warned.service.dispose()
})

test('provider input bounds determine chunk sizes without silent truncation', async () => {
  const e = embedding(); e.provider.maxInputCharacters = 128
  const f = fixture({ provider: e.provider, text: ['cat '.repeat(120)] })
  const result = await finish(f.service)
  assert.ok(result.coverage.totalChunks > 1)
  assert.ok(e.calls.flatMap(call => call.texts).every(text => text.length <= 128))
  await assert.rejects(f.service.search('session', { ...baseInput, query: 'x'.repeat(129) }), { code: 'pdf/retrieval-query-too-long' })
})

test('offline automatic retrieval is explicitly lexical and recovery invalidates an old lexical cursor', async () => {
  const e = embedding(); let online = false
  e.provider.availability = async () => online
  const f = fixture({ provider: e.provider, limits: { pagesPerStep: 1 } })
  const offline = await f.service.search('session', baseInput)
  assert.equal(offline.effectiveMode, 'lexical'); assert.ok(offline.fallbackReason)
  assert.equal(e.calls.length, 0)
  await assert.rejects(f.service.search('session', { ...baseInput, mode: 'hybrid' }), { code: 'pdf/retrieval-engine-unavailable' })
  online = true
  await assert.rejects(f.service.search('session', { ...baseInput, cursor: offline.nextCursor }), { code: 'pdf/stale-reader' })
  assert.equal((await finish(f.service)).effectiveMode, 'hybrid')
})

test('same model re-registered with another lifetime invalidates its cursor but reuses valid vectors', async () => {
  const e = embedding(); e.provider.generation = 'registration-1'
  const f = fixture({ provider: e.provider, limits: { pagesPerStep: 1 } })
  const first = await f.service.search('session', baseInput)
  f.state.provider = { ...e.provider, generation: 'registration-2' }
  await assert.rejects(f.service.search('session', { ...baseInput, cursor: first.nextCursor }), { code: 'pdf/stale-reader' })
  const complete = await finish(f.service)
  assert.equal(complete.status, 'complete')
  assert.equal(e.calls.filter(call => call.purpose === 'document').flatMap(call => call.texts).length, 3)
})

test('annotation revision does not invalidate the original-source text index', async () => {
  const f = fixture({ limits: { pagesPerStep: 1 } })
  let revision = 1
  f.ports.documents.snapshot = () => ({ ...f.state.document, revision })
  const first = await f.service.search('session', baseInput)
  revision++
  const second = await f.service.search('session', { ...baseInput, cursor: first.nextCursor })
  assert.equal(second.indexGeneration, first.indexGeneration)
  assert.equal(second.coverage.indexedPages, 2)
})

test('disposal drains a native operation that acknowledges cancellation late before cache shutdown', async () => {
  const gate = deferred<void>(); const started = deferred<void>()
  const f = fixture({ text: ['cat'] })
  f.ports.pages.read = async () => { started.resolve(); await gate.promise; return { text: 'cat', source: 'pdf-text' } }
  const request = f.service.search('session', baseInput)
  await started.promise
  let drained = false
  const disposal = f.service.dispose().then(() => { drained = true })
  await assert.rejects(request, { code: 'pdf/cancelled' })
  await turn(); assert.equal(drained, false)
  gate.resolve(); await disposal
  assert.equal(drained, true); assert.equal(f.stored.size, 0)
})

test('independent concurrent builds have an explicit bound and retry succeeds when capacity returns', async () => {
  const gate = deferred<void>(); const started = deferred<void>()
  const f = fixture({ text: ['cat'], limits: { maxConcurrentJobs: 1 } })
  f.ports.pages.read = async () => { started.resolve(); await gate.promise; return { text: 'cat', source: 'pdf-text' } }
  const first = f.service.search('session-1', baseInput)
  await started.promise
  await assert.rejects(f.service.search('session-2', baseInput), { code: 'pdf/retrieval-busy' })
  gate.resolve(); await first
  assert.equal((await f.service.search('session-2', baseInput)).status, 'complete')
})

test('derived cache failures are rebuildable and never change retrieval semantics', async () => {
  const f = fixture()
  f.ports.cache = { get: async () => { throw new Error('offline') }, set: async () => { throw new Error('full') } }
  const result = await finish(f.service)
  assert.equal(result.status, 'complete'); assert.ok(result.chunks.length)
})

test('completed-index query embeddings obey query admission limits and recover capacity', async () => {
  const e = embedding(); const f = fixture({ provider: e.provider, limits: { maxConcurrentQueries: 1 } })
  await finish(f.service)
  const gate = deferred<void>(); const started = deferred<void>(); const original = e.provider.embed
  e.provider.embed = async (...args) => {
    if (args[1] === 'query') { started.resolve(); await gate.promise }
    return original(...args)
  }
  const first = f.service.search('session', baseInput)
  await started.promise
  await assert.rejects(f.service.search('session', { ...baseInput, query: 'feline' }), { code: 'pdf/retrieval-busy' })
  gate.resolve()
  assert.equal((await first).status, 'complete')
  assert.equal((await f.service.search('session', baseInput)).status, 'complete')
})

test('an index awaiting query embedding is not evicted by another index admission', async () => {
  const e = embedding(); const f = fixture({ provider: e.provider, limits: { maxIndexes: 1 } })
  await finish(f.service)
  const gate = deferred<void>(); const started = deferred<void>(); const original = e.provider.embed
  e.provider.embed = async (...args) => {
    if (args[1] === 'query') { started.resolve(); await gate.promise }
    return original(...args)
  }
  const first = f.service.search('session', baseInput)
  await started.promise
  await assert.rejects(f.service.search('session', { ...baseInput, fromPage: 2 }), { code: 'pdf/retrieval-budget' })
  gate.resolve()
  assert.equal((await first).status, 'complete')
  assert.equal((await f.service.search('session', { ...baseInput, fromPage: 2 })).status, 'complete')
})

test('shared indexing owns one document lease independent of a cancelled subscriber', async () => {
  const gate = deferred<void>(); const started = deferred<void>(); const f = fixture({ text: ['cat'] })
  let pins = 0; let acquisitions = 0
  f.ports.documents.retain = async () => { pins++; acquisitions++; return () => { pins-- } }
  f.ports.pages.read = async () => {
    assert.equal(pins, 1); started.resolve(); await gate.promise
    return { text: 'cat', source: 'pdf-text' }
  }
  const abort = new AbortController()
  const first = f.service.search('session', baseInput, abort.signal)
  const second = f.service.search('session', { ...baseInput, query: 'animal cat' })
  await started.promise; abort.abort(new Error('Caller left'))
  await assert.rejects(first, /Caller left/)
  assert.equal(pins, 1); assert.equal(acquisitions, 1)
  gate.resolve(); await second
  assert.equal(pins, 0)
})

test('an abandoned indexing lease is held until its actual read promise settles', async () => {
  const gate = deferred<void>(); const started = deferred<void>(); const f = fixture({ text: ['cat'] })
  let pins = 0
  f.ports.documents.retain = async () => { pins++; return () => { pins-- } }
  f.ports.pages.read = async () => { started.resolve(); await gate.promise; return { text: 'cat', source: 'pdf-text' } }
  const abort = new AbortController()
  const request = f.service.search('session', baseInput, abort.signal)
  await started.promise; abort.abort(new Error('Caller left'))
  await assert.rejects(request, /Caller left/)
  assert.equal(pins, 1)
  const disposal = f.service.dispose()
  gate.resolve(); await disposal
  assert.equal(pins, 0); assert.equal(f.stored.size, 0)
})

test('adapter result validation fences engine changes and session identity after core search returns', async () => {
  const e = embedding(); e.provider.generation = 'generation-1'
  const f = fixture({ provider: e.provider })
  const result = await finish(f.service)
  assert.doesNotThrow(() => f.service.validate('session', result))
  assert.throws(() => f.service.validate('foreign', result), { code: 'pdf/stale-reader' })
  assert.throws(() => f.service.validate('session', { ...result }), { code: 'pdf/stale-reader' })
  f.state.provider = { ...e.provider, generation: 'generation-2' }
  assert.throws(() => f.service.validate('session', result), { code: 'pdf/stale-reader' })
})

test('adapter result validation survives cache eviction but rejects a changed original source', async () => {
  const f = fixture({ limits: { maxIndexes: 1 } })
  const first = await finish(f.service)
  await f.service.search('session', { ...baseInput, fromPage: 2 })
  assert.doesNotThrow(() => f.service.validate('session', first))
  f.state.document.sourceDigest = 'external-change'
  assert.throws(() => f.service.validate('session', first), { code: 'pdf/stale-reader' })
})

test('session cancellation invalidates returned result fences without preventing a fresh authorized search', async () => {
  const f = fixture()
  const first = await finish(f.service)
  assert.doesNotThrow(() => f.service.validate('session', first))
  f.service.cancelSession('session')
  assert.throws(() => f.service.validate('session', first), { code: 'pdf/stale-reader' })
  const fresh = await finish(f.service)
  assert.notEqual(fresh.indexGeneration, first.indexGeneration)
  assert.doesNotThrow(() => f.service.validate('session', fresh))
  assert.throws(() => f.service.validate('session', first), { code: 'pdf/stale-reader' })
})

test('dormant session result fences are bounded and expire conservatively', async () => {
  const f = fixture({ text: ['cat'] })
  const first = await f.service.search('session-0', baseInput)
  for (let i = 1; i <= 64; i++) await f.service.search(`session-${i}`, baseInput)
  assert.throws(() => f.service.validate('session-0', first), { code: 'pdf/stale-reader' })
  const fresh = await f.service.search('session-0', baseInput)
  assert.doesNotThrow(() => f.service.validate('session-0', fresh))
})
