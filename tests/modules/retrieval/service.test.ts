import assert from 'node:assert/strict'
import test from 'node:test'
import { createRetrievalService } from '../../../src/modules/retrieval/service.ts'
import { digest, pageCacheKey, retrievalCacheKey } from '../../../src/modules/retrieval/cache.ts'
import { RETRIEVAL_TEXT_VERSION } from '../../../src/modules/retrieval/text.ts'
import type { RetrievalDocument, RetrievalEmbedding, RetrievalInput, RetrievalPorts, RetrievalProgress, RetrievalResult } from '../../../src/modules/retrieval/types.ts'

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
    cache: { get: async key => stored.get(key), set: async (key, value) => { stored.set(key, value) },
      clear: async () => { stored.clear() } },
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
  for (const invalid of [{ dimensions: 0 }, { dimensions: 1.5 }, { maxBatchSize: 0 }, { maxInputCharacters: 63 },
    { documentFingerprint: '' }, { documentFingerprint: 'x'.repeat(513) }, { documentFingerprint: 12 as never }]) {
    const e = embedding()
    const f = fixture({ provider: { ...e.provider, ...invalid } })
    try {
      await assert.rejects(f.service.search('session', baseInput), { code: 'pdf/retrieval-invalid-provider' })
      await assert.rejects(f.service.prepare('session', { documentId: 'doc' }), { code: 'pdf/retrieval-invalid-provider' })
      assert.deepEqual(f.reads, [])
      assert.deepEqual(e.calls, [])
      assert.equal(f.stored.size, 0)
    } finally { await f.service.dispose() }
  }
})

test('oversized extraction identities fail before reading, caching or embedding a document', async () => {
  const e = embedding(), f = fixture({ provider: e.provider })
  f.ports.pages.identity = () => 'x'.repeat(16_385)
  try {
    await assert.rejects(f.service.prepare('session', { documentId: 'doc' }),
      { code: 'pdf/retrieval-extraction-failed', message: 'PDF extraction identity is invalid' })
    assert.deepEqual(f.reads, [])
    assert.deepEqual(e.calls, [])
    assert.equal(f.stored.size, 0)
  } finally { await f.service.dispose() }
})

test('oversized native text and combined derived representations fail without caching or embedding a truncated page', async () => {
  const unitText = 'cat '.repeat(62_501)
  for (const kind of ['native', 'derived'] as const) {
    const e = embedding(), f = fixture({ text: ['cat '.repeat(125_001)], provider: e.provider })
    if (kind === 'derived') f.ports.pages.read = async (_session, _document, page) => {
      f.reads.push(page)
      return { text: '', source: 'pdf-text', units: ['first', 'second'].map(id => ({
        id, blockId: id, kind: 'ocr-text', text: unitText, digest: `sha256:${digest(unitText)}`,
      })) }
    }
    try {
      await assert.rejects(f.service.prepare('session', { documentId: 'doc' }), { code: 'pdf/retrieval-budget' })
      assert.deepEqual(f.reads, [1])
      assert.deepEqual(e.calls, [])
      assert.equal(f.stored.size, 0, 'an over-budget page must not leave a persistent partial success')
    } finally { await f.service.dispose() }
  }
})

test('query-free preparation embeds the complete scope and the first search reuses its document index', async () => {
  const e = embedding(), f = fixture({ provider: e.provider, limits: { pagesPerStep: 1, embeddingBatchesPerStep: 1 } })
  try {
    await f.service.prepare('session', { documentId: 'doc' })
    assert.deepEqual(f.reads, [1, 2, 3])
    assert.ok(e.calls.length > 0)
    assert.ok(e.calls.every(call => call.purpose === 'document'), 'preparation must never invent a query to embed')
    const documentCalls = e.calls.length
    const result = await f.service.search('session', { ...baseInput, mode: 'semantic' })
    assert.equal(result.status, 'complete')
    assert.deepEqual(f.reads, [1, 2, 3])
    assert.equal(e.calls.length, documentCalls + 1)
    assert.equal(e.calls.at(-1)!.purpose, 'query')
    assert.ok(result.chunks.length > 0)
  } finally { await f.service.dispose() }
})

test('preparation reports page and vector progress during bounded shared work and immediately reports a warm index', async () => {
  const e = embedding(), entered = deferred<void>(), gate = deferred<void>()
  const f = fixture({ provider: { ...e.provider, async embed(texts, purpose, signal) {
    if (purpose === 'document') { entered.resolve(); await gate.promise }
    return e.provider.embed(texts, purpose, signal)
  } } })
  const progress: RetrievalProgress[] = []
  try {
    const preparing = f.service.prepare('session', { documentId: 'doc' }, undefined, value => { progress.push(value) })
    await entered.promise
    assert.deepEqual(progress[0], { indexedPages: 0, totalPages: 3, embeddedChunks: 0, totalChunks: 0,
      phase: 'restoring', reusedChunks: 0, computedChunks: 0 })
    assert.deepEqual([...new Set(progress.map(value => value.indexedPages))], [0, 1, 2, 3])
    assert.equal(progress.at(-1)!.phase, 'embedding', 'an active model request must not look like cache restoration')
    assert.equal(progress.at(-1)!.embeddedChunks, 0, 'page progress must be visible before the embedding batch completes')
    gate.resolve(); await preparing
    assert.deepEqual(progress.at(-1), { indexedPages: 3, totalPages: 3, embeddedChunks: 3, totalChunks: 3,
      phase: 'ready', reusedChunks: 0, computedChunks: 3 })
    assert.ok(progress.some(value => value.embeddedChunks === 2), 'each completed vector batch exposes progress')
    for (let i = 1; i < progress.length; i++) {
      assert.ok(progress[i].indexedPages >= progress[i - 1].indexedPages)
      assert.ok(progress[i].embeddedChunks >= progress[i - 1].embeddedChunks)
      assert.ok(progress[i].totalChunks >= progress[i - 1].totalChunks)
    }
    const warm: RetrievalProgress[] = []
    await f.service.prepare('session', { documentId: 'doc' }, undefined, value => { warm.push(value) })
    assert.deepEqual(warm, [{ indexedPages: 3, totalPages: 3, embeddedChunks: 3, totalChunks: 3,
      phase: 'ready', reusedChunks: 3, computedChunks: 0 }])
  } finally { gate.resolve(); await f.service.dispose() }
})

test('preparation progress restores cached vectors and isolates synchronous and asynchronous observer failures', async () => {
  const e = embedding(), f = fixture({ provider: e.provider })
  await f.service.prepare('session', { documentId: 'doc' })
  const calls = e.calls.length, reads = f.reads.length
  await f.service.dispose()
  const restored = createRetrievalService(f.ports), progress: RetrievalProgress[] = []
  try {
    await restored.prepare('session', { documentId: 'doc' }, undefined, value => {
      progress.push(value)
      throw new Error('observer cannot break cache restoration')
    })
    assert.deepEqual(progress.at(-1), { indexedPages: 3, totalPages: 3, embeddedChunks: 3, totalChunks: 3,
      phase: 'ready', reusedChunks: 3, computedChunks: 0 })
    assert.ok(progress.slice(0, -1).every(value => value.phase === 'restoring'),
      'cache restoration must not claim native extraction or new embedding work')
    assert.equal(e.calls.length, calls)
    assert.equal(f.reads.length, reads)
    await restored.prepare('session', { documentId: 'doc' }, undefined, async () => { throw new Error('async observer') })
    await turn()
  } finally { await restored.dispose() }
})

test('partial disk restoration computes only a missing vector and reports reuse separately', async () => {
  const e = embedding(), f = fixture({ provider: { ...e.provider, maxBatchSize: 1 } })
  await f.service.prepare('session', { documentId: 'doc' })
  await f.service.dispose()
  const records = [...f.stored.entries()].filter(([, value]) => value !== null && typeof value === 'object'
    && 'encoding' in value && value.encoding === 'float32-le-base64')
  f.stored.delete(records[0]![0])
  const entered = deferred<void>(), gate = deferred<void>(), get = f.ports.cache!.get
  f.ports.cache!.get = async key => {
    if (key === records[1]![0]) { entered.resolve(); await gate.promise }
    return get(key)
  }
  const calls = e.calls.length, reads = f.reads.length, progress: RetrievalProgress[] = []
  const restored = createRetrievalService(f.ports)
  try {
    const pending = restored.prepare('another-session', { documentId: 'doc' }, undefined, value => { progress.push(value) })
    await entered.promise
    assert.equal(progress.at(-1)!.phase, 'restoring', 'a later cache read must not inherit the completed model-request phase')
    assert.equal(progress.at(-1)!.computedChunks, 1)
    gate.resolve(); await pending
    assert.equal(f.reads.length, reads, 'page text survives an independent vector eviction')
    assert.equal(e.calls.slice(calls).flatMap(call => call.texts).length, 1)
    assert.ok(progress.some(value => value.phase === 'embedding'))
    assert.deepEqual(progress.at(-1), { indexedPages: 3, totalPages: 3, embeddedChunks: 3, totalChunks: 3,
      phase: 'ready', reusedChunks: 2, computedChunks: 1 })
  } finally { gate.resolve(); await restored.dispose() }
})

test('failed preparation retains incomplete page progress instead of reporting full coverage', async () => {
  const e = embedding(), f = fixture({ provider: e.provider, text: ['cat', 'unreadable'] })
  const original = f.ports.pages.read, progress: RetrievalProgress[] = []
  f.ports.pages.read = async (...args) => {
    if (args[2] === 2) throw Object.assign(new Error('corrupt page'), { code: 'pdf/extraction-error' })
    return original(...args)
  }
  try {
    await assert.rejects(f.service.prepare('session', { documentId: 'doc' }, undefined, value => { progress.push(value) }),
      { code: 'pdf/retrieval-incomplete' })
    assert.equal(progress.at(-1)!.indexedPages, 1)
    assert.equal(progress.at(-1)!.totalPages, 2)
    assert.equal(progress.some(value => value.indexedPages === value.totalPages), false)
  } finally { await f.service.dispose() }
})

test('preparation and foreground searches share one in-flight indexing step without duplicate extraction or document embeddings', async () => {
  const e = embedding(), f = fixture({ provider: e.provider, limits: { pagesPerStep: 1 } })
  const entered = deferred<void>(), gate = deferred<void>(), originalRead = f.ports.pages.read
  f.ports.pages.read = async (...args) => {
    if (args[2] === 1) { entered.resolve(); await gate.promise }
    return originalRead(...args)
  }
  try {
    const preparing = f.service.prepare('session', { documentId: 'doc' })
    await entered.promise
    const searching = f.service.search('session', { ...baseInput, mode: 'semantic' })
    gate.resolve()
    await Promise.all([preparing, searching])
    assert.deepEqual(f.reads, [1, 2, 3])
    const embedded = e.calls.filter(call => call.purpose === 'document').flatMap(call => call.texts)
    assert.equal(embedded.length, 3)
    assert.equal(new Set(embedded).size, 3)
    assert.equal((await f.service.search('session', { ...baseInput, mode: 'semantic' })).status, 'complete')
  } finally { gate.resolve(); await f.service.dispose() }
})

for (const maxConcurrentQueries of [8, 2]) {
  test(`preparation waits for occupied foreground capacity and resumes without polling (query limit ${maxConcurrentQueries})`, async () => {
    const e = embedding(), f = fixture({ provider: e.provider, text: ['cat'],
      limits: { maxConcurrentJobs: 2, maxConcurrentQueries } })
    const a = deferred<void>(), b = deferred<void>(), entered = deferred<void>()
    const reads: string[] = []
    f.ports.documents.snapshot = (_session, id) => ({ ...f.state.document, id, path: `/${id}.pdf`, sourceDigest: `source-${id}` })
    f.ports.pages.read = async (_session, id) => {
      reads.push(id)
      if (reads.length === 2) entered.resolve()
      if (id === 'a') await a.promise
      if (id === 'b') await b.promise
      return { text: `${id} cat`, source: 'pdf-text' }
    }
    const first = f.service.search('session', { ...baseInput, documentId: 'a', mode: 'semantic' })
    const second = f.service.search('session', { ...baseInput, documentId: 'b', mode: 'semantic' })
    void first.catch(() => undefined); void second.catch(() => undefined)
    try {
      await entered.promise
      let prepared = false
      const third = f.service.prepare('session', { documentId: 'c' }).then(() => { prepared = true })
      await turn()
      assert.equal(prepared, false)
      assert.deepEqual(reads, ['a', 'b'])
      a.resolve()
      await first
      await third
      assert.equal(prepared, true)
      assert.deepEqual(reads, ['a', 'b', 'c'], 'one free foreground slot admits the queued preparation')
      const documentCalls = e.calls.filter(call => call.purpose === 'document').length
      assert.equal((await f.service.search('session', { ...baseInput, documentId: 'c', mode: 'semantic' })).status, 'complete')
      assert.equal(e.calls.filter(call => call.purpose === 'document').length, documentCalls)
      b.resolve(); await second
    } finally { a.resolve(); b.resolve(); await f.service.dispose() }
  })
}

test('cancelling a preparation waiting for capacity does not wait for or cancel unrelated foreground work', async () => {
  const e = embedding(), f = fixture({ provider: e.provider, text: ['cat'], limits: { maxConcurrentJobs: 1, maxConcurrentQueries: 1 } })
  const entered = deferred<void>(), gate = deferred<void>()
  let foregroundSignal!: AbortSignal
  f.ports.pages.read = async (_session, _id, _page, signal) => {
    foregroundSignal = signal; entered.resolve(); await gate.promise
    return { text: 'cat', source: 'pdf-text' }
  }
  const foreground = f.service.search('foreground', { ...baseInput, mode: 'semantic' })
  void foreground.catch(() => undefined)
  try {
    await entered.promise
    const controller = new AbortController()
    const preparing = f.service.prepare('background', { documentId: 'doc' }, controller.signal)
    controller.abort()
    await assert.rejects(preparing, { name: 'AbortError' })
    assert.equal(foregroundSignal.aborted, false)
    gate.resolve()
    assert.equal((await foreground).status, 'complete')
  } finally { gate.resolve(); await f.service.dispose() }
})

test('rebuild cancels a preparation waiting for query capacity before draining the foreground read', async () => {
  const e = embedding(), f = fixture({ provider: e.provider, text: ['cat'], limits: { maxConcurrentJobs: 1, maxConcurrentQueries: 1 } })
  const entered = deferred<void>(), gate = deferred<void>()
  f.ports.pages.read = async () => { entered.resolve(); await gate.promise; return { text: 'cat', source: 'pdf-text' } }
  const foreground = f.service.search('foreground', { ...baseInput, mode: 'semantic' })
  const foregroundCancelled = assert.rejects(foreground, { code: 'pdf/cancelled' })
  try {
    await entered.promise
    const preparing = f.service.prepare('background', { documentId: 'doc' })
    const preparationCancelled = assert.rejects(preparing, { code: 'pdf/cancelled' })
    const reset = f.service.rebuild()
    await preparationCancelled
    gate.resolve()
    await Promise.all([reset, foregroundCancelled])
    assert.equal(f.stored.size, 0)
  } finally { gate.resolve(); await f.service.dispose() }
})

test('cancelling preparation does not cancel a foreground subscriber to its shared indexing step', async () => {
  const e = embedding(), f = fixture({ provider: e.provider, text: ['A cat is here.'] })
  const entered = deferred<void>(), gate = deferred<void>(), originalRead = f.ports.pages.read
  let buildSignal!: AbortSignal
  f.ports.pages.read = async (...args) => {
    buildSignal = args[3]; entered.resolve(); await gate.promise
    return originalRead(...args)
  }
  const controller = new AbortController(), progress: RetrievalProgress[] = []
  try {
    const preparing = f.service.prepare('session', { documentId: 'doc' }, controller.signal, value => { progress.push(value) })
    const cancelled = assert.rejects(preparing, { name: 'AbortError' })
    await entered.promise
    const searching = f.service.search('session', { ...baseInput, mode: 'semantic' })
    await turn()
    controller.abort()
    await cancelled
    const cancelledProgress = [...progress]
    assert.equal(buildSignal.aborted, false)
    gate.resolve()
    assert.equal((await searching).status, 'complete')
    assert.deepEqual(f.reads, [1])
    assert.deepEqual(progress, cancelledProgress, 'the cancelled subscriber must not receive later shared progress')
  } finally { gate.resolve(); await f.service.dispose() }
})

test('a cancelled sole preparation stays pending until its non-cooperative read releases the build slot', async () => {
  const e = embedding(), f = fixture({ provider: e.provider, text: ['A cat is here.'] })
  const entered = deferred<void>(), gate = deferred<void>(), originalRead = f.ports.pages.read
  let settled = false, released = 0
  f.ports.documents.retain = async () => () => { released++ }
  f.ports.pages.read = async (...args) => { entered.resolve(); await gate.promise; return originalRead(...args) }
  const controller = new AbortController()
  try {
    const preparing = f.service.prepare('session', { documentId: 'doc' }, controller.signal)
    const cancelled = assert.rejects(preparing, { name: 'AbortError' })
    void preparing.then(() => { settled = true }, () => { settled = true })
    await entered.promise
    controller.abort()
    await turn()
    assert.equal(settled, false, 'the background scheduler must not start another document yet')
    assert.equal(released, 0)
    gate.resolve()
    await cancelled
    assert.equal(settled, true)
    assert.equal(released, 1)
    assert.equal(f.stored.size, 0)
    assert.equal(e.calls.length, 0)
  } finally { gate.resolve(); await f.service.dispose() }
})

test('rebuilding cancels preparation and drains a late page read before clearing its derived records', async () => {
  const e = embedding(), f = fixture({ provider: e.provider })
  const entered = deferred<void>(), gate = deferred<void>(), originalRead = f.ports.pages.read
  f.ports.pages.read = async (...args) => { entered.resolve(); await gate.promise; return originalRead(...args) }
  try {
    const preparing = f.service.prepare('session', { documentId: 'doc' })
    const cancelled = assert.rejects(preparing, { code: 'pdf/cancelled' })
    await entered.promise
    const reset = f.service.rebuild()
    await turn()
    gate.resolve()
    await cancelled
    await reset
    assert.equal(f.stored.size, 0)
    assert.equal(e.calls.length, 0)
  } finally { gate.resolve(); await f.service.dispose() }
})

test('disposing cancels preparation but retains its document lease until the actual read settles', async () => {
  const e = embedding(), f = fixture({ provider: e.provider })
  const entered = deferred<void>(), gate = deferred<void>(), originalRead = f.ports.pages.read
  let released = 0, disposed = false
  f.ports.documents.retain = async () => () => { released++ }
  f.ports.pages.read = async (...args) => { entered.resolve(); await gate.promise; return originalRead(...args) }
  const preparing = f.service.prepare('session', { documentId: 'doc' })
  const cancelled = assert.rejects(preparing, { code: 'pdf/cancelled' })
  await entered.promise
  const disposal = f.service.dispose().then(() => { disposed = true })
  await turn()
  assert.equal(disposed, false)
  assert.equal(released, 0)
  gate.resolve()
  await cancelled
  await disposal
  assert.equal(released, 1)
  assert.equal(f.stored.size, 0)
  await assert.rejects(f.service.prepare('session', { documentId: 'doc' }), { code: 'pdf/cancelled' })
})

test('preparation stops on unavailable providers, invalid scopes and persistently unextractable pages', async () => {
  const disabled = fixture()
  try {
    await assert.rejects(disabled.service.prepare('session', { documentId: 'doc' }), { code: 'pdf/retrieval-engine-unavailable' })
    assert.deepEqual(disabled.reads, [])
  } finally { await disabled.service.dispose() }
  const e = embedding(), f = fixture({ provider: e.provider, text: ['cat'] })
  let attempts = 0
  f.ports.pages.read = async () => { attempts++; throw new Error('unreadable page') }
  try {
    await assert.rejects(f.service.prepare('session', { documentId: 'doc', fromPage: 0 }))
    await assert.rejects(f.service.prepare('session', { documentId: 'doc' }), { code: 'pdf/retrieval-incomplete' })
    assert.equal(attempts, 2)
    assert.equal(e.calls.length, 0)
  } finally { await f.service.dispose() }
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

test('obsolete native quality warnings are re-extracted while unchanged text reuses cached embeddings', async () => {
  const text = 'The cat is learning.', e = embedding(), f = fixture({ text: [text], provider: e.provider })
  const source = f.state.document
  const oldKey = retrievalCacheKey('page', 'joined-page-text-v1', RETRIEVAL_TEXT_VERSION, source.path, source.sourceDigest, 1)
  f.stored.set(oldKey, { version: 1, source: 'pdf-text', text,
    warnings: ['Some native characters could not be decoded; OCR or visual inspection is needed.'] })
  // Quality-only extraction changes must not send unchanged document text to the model again.
  f.stored.set(retrievalCacheKey('vector', e.provider.fingerprint, 'document', digest(text)), [1, 0])
  try {
    const result = await finish(f.service, { ...baseInput, mode: 'semantic' })
    assert.deepEqual(f.reads, [1], 'obsolete extraction metadata must be replaced by an authorized page read')
    assert.deepEqual(result.coverage.qualityWarnings, [])
    assert.equal(result.chunks[0]!.text, text)
    assert.deepEqual(e.calls.map(call => call.purpose), ['query'])
    assert.deepEqual(f.stored.get(pageCacheKey(source.path, source.sourceDigest, 1)), { version: 1, source: 'pdf-text', text })
    await f.service.dispose()
    const restored = createRetrievalService(f.ports)
    try {
      assert.deepEqual((await finish(restored, { ...baseInput, mode: 'semantic' })).coverage.qualityWarnings, [])
      assert.deepEqual(f.reads, [1], 'the corrected quality metadata must survive service disposal')
      assert.ok(e.calls.every(call => call.purpose === 'query'))
    } finally { await restored.dispose() }
  } finally { await f.service.dispose() }
})

test('positioned paragraphs rank and persist independently without widening their exact evidence ranges', async () => {
  const e = embedding(), body = 'A cat learns useful patterns.\nIt should not memorize the examples.'
  const text = `Heading\n${body}\nFooter`
  const paragraphBreaks = ['Heading\n'.length, 'Heading\n'.length + body.length + 1]
  const f = fixture({ provider: e.provider, text: [text] })
  let reads = 0
  f.ports.pages.read = async () => { reads++; return { text, source: 'pdf-text', paragraphBreaks } }
  try {
    const input = { documentId: 'doc', query: 'feline', mode: 'semantic' as const, topK: 1 }
    const result = await finish(f.service, input)
    assert.equal(result.coverage.totalChunks, 3)
    assert.equal(result.coverage.embeddedChunks, 3)
    assert.equal(result.chunks[0]!.text, body)
    assert.equal(result.chunks[0]!.startUtf16, paragraphBreaks[0])
    assert.equal(result.chunks[0]!.endUtf16, paragraphBreaks[1]! - 1)
    assert.ok(e.calls.filter(call => call.purpose === 'document').flatMap(call => call.texts).includes(body))
    assert.ok([...f.stored.values()].some(value => value && typeof value === 'object'
      && 'paragraphBreaks' in value && JSON.stringify(value.paragraphBreaks) === JSON.stringify(paragraphBreaks)))
    await f.service.dispose()
    const restored = createRetrievalService(f.ports)
    try {
      const next = await finish(restored, input)
      assert.equal(next.chunks[0]!.text, body)
      assert.equal(reads, 1, 'the validated derived page cache must retain its paragraph boundaries')
    } finally { await restored.dispose() }
  } finally { await f.service.dispose() }
})

test('older chunking caches and malformed paragraph offsets are rebuilt from authorized page text', async () => {
  const f = fixture({ text: ['cat\nnext paragraph'] })
  const source = f.state.document
  const oldKey = retrievalCacheKey('page', 'joined-page-text-v1', 'page-text-v1', source.path, source.sourceDigest, 1)
  const freshKey = pageCacheKey(source.path, source.sourceDigest, 1)
  assert.notEqual(oldKey, freshKey)
  f.stored.set(oldKey, { version: 1, source: 'pdf-text', text: 'An obsolete whole-page cache.' })
  f.ports.pages.read = async () => {
    f.reads.push(1)
    return { text: 'cat\nnext paragraph', source: 'pdf-text', paragraphBreaks: [4] }
  }
  try {
    assert.equal((await finish(f.service)).chunks[0]!.text, 'cat')
    assert.equal(f.reads.length, 1)
    await f.service.dispose()
    for (const paragraphBreaks of [[0], [100], [4, 2], [4, 4], [1.5], [2]]) {
      // Offset 2 splits a Unicode surrogate in this cached source.
      f.stored.set(freshKey, { version: 1, source: 'pdf-text', text: 'A😀 cached cat', paragraphBreaks })
      const rebuilt = createRetrievalService(f.ports)
      try { assert.equal((await finish(rebuilt)).chunks[0]!.text, 'cat') }
      finally { await rebuilt.dispose() }
    }
    assert.equal(f.reads.length, 7)
  } finally { await f.service.dispose() }
})

test('invalid extraction paragraph metadata is reported without caching or signing partial ranges', async () => {
  const f = fixture({ text: ['cat'] })
  f.ports.pages.read = async () => ({ text: 'cat', source: 'pdf-text', paragraphBreaks: [1, 1] })
  try {
    const result = await f.service.search('session', baseInput)
    assert.equal(result.status, 'incomplete')
    assert.equal(result.coverage.indexedPages, 0)
    assert.equal(result.coverage.failedPages[0]!.code, 'pdf/retrieval-extraction-failed')
    assert.deepEqual(result.chunks, [])
    assert.equal(f.stored.size, 0)
  } finally { await f.service.dispose() }
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
    assert.equal([...f.stored.values()].filter(value => Array.isArray(value)
      || value !== null && typeof value === 'object' && 'encoding' in value && value.encoding === 'float32-le-base64').length, 0)
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
  f.ports.documents.snapshot = sessionId => ({ ...f.state.document, sourceDigest: `source-${sessionId}` })
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
  assert.equal(fresh.indexGeneration, first.indexGeneration, 'fresh authorization may reuse immutable data after the old Session lifetime expires')
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

test('rebuild expires all sessions, result fences and continuations, then rereads and reembeds the source', async () => {
  const e = embedding(), f = fixture({ provider: e.provider, limits: { pagesPerStep: 1 } })
  try {
    const complete = await finish(f.service)
    const progress = await f.service.search('another-session', { ...baseInput, fromPage: 2 })
    assert.ok(progress.nextCursor)
    const original = { ...f.state.document }, reads = f.reads.length
    const embeddings = e.calls.filter(call => call.purpose === 'document').length
    assert.ok(f.stored.size > 0)
    await f.service.rebuild()
    assert.equal(f.stored.size, 0)
    assert.deepEqual(f.state.document, original, 'a rebuild changes no document or draft state')
    assert.throws(() => f.service.validate('session', complete), { code: 'pdf/stale-reader' })
    assert.throws(() => f.service.validate('another-session', progress), { code: 'pdf/stale-reader' })
    await assert.rejects(f.service.search('another-session', { ...baseInput, cursor: progress.nextCursor }), { code: 'pdf/stale-reader' })
    const fresh = await finish(f.service)
    assert.notEqual(fresh.indexGeneration, complete.indexGeneration)
    assert.equal(f.reads.length, reads + 3)
    assert.ok(e.calls.filter(call => call.purpose === 'document').length > embeddings)
    assert.doesNotThrow(() => f.service.validate('session', fresh))
  } finally { await f.service.dispose() }
})

test('rebuild drains non-cooperative page reads, rejects concurrent admission and coalesces reset requests', async () => {
  const gate = deferred<void>(), started = deferred<void>(), f = fixture({ text: ['cat'] })
  const originalRead = f.ports.pages.read
  let clears = 0
  f.ports.pages.read = async () => { started.resolve(); await gate.promise; return { text: 'cat', source: 'pdf-text' } }
  f.ports.cache!.clear = async () => { clears++; f.stored.clear() }
  const request = f.service.search('session', baseInput)
  const rejected = assert.rejects(request, { code: 'pdf/cancelled' })
  await started.promise
  const reset = f.service.rebuild()
  assert.equal(f.service.rebuild(), reset)
  await rejected
  await assert.rejects(f.service.search('session', baseInput), { code: 'pdf/retrieval-busy' })
  assert.equal(clears, 0)
  gate.resolve()
  await reset
  assert.equal(clears, 1)
  assert.equal(f.stored.size, 0, 'the abandoned page read must not refill the cleared cache')
  f.ports.pages.read = originalRead
  assert.equal((await finish(f.service)).status, 'complete')
  await f.service.dispose()
})

test('rebuild waits for an already-started cache write and removes that old-generation record', async () => {
  const gate = deferred<void>(), started = deferred<void>(), f = fixture({ text: ['cat'] })
  f.ports.cache!.set = async (key, value) => { started.resolve(); await gate.promise; f.stored.set(key, value) }
  const search = f.service.search('session', baseInput)
  const rejected = assert.rejects(search, { code: 'pdf/cancelled' })
  await started.promise
  const reset = f.service.rebuild()
  await rejected
  gate.resolve()
  await reset
  assert.equal(f.stored.size, 0)
  await f.service.dispose()
})

test('a failed persistent reset prevents stale cache reuse until a successful retry', async () => {
  const f = fixture({ text: ['cat'] })
  await finish(f.service)
  f.ports.cache!.clear = async () => { throw new Error('storage offline') }
  await assert.rejects(f.service.rebuild(), /storage offline/)
  assert.ok(f.stored.size > 0)
  await assert.rejects(f.service.search('session', baseInput), { code: 'pdf/retrieval-cache-unavailable' })
  f.ports.cache!.clear = async () => { f.stored.clear() }
  await f.service.rebuild()
  assert.equal(f.stored.size, 0)
  assert.equal((await finish(f.service)).status, 'complete')
  await f.service.dispose()
})

test('in-memory-only services rebuild while caches without a reset contract report unsupported reset', async () => {
  const f = fixture({ text: ['cat'] })
  delete f.ports.cache!.clear
  await assert.rejects(f.service.rebuild(), { code: 'pdf/retrieval-cache-unavailable' })
  delete f.ports.cache
  const before = await finish(f.service)
  await f.service.rebuild()
  const after = await finish(f.service)
  assert.notEqual(before.indexGeneration, after.indexGeneration)
  await f.service.dispose()
  await assert.rejects(f.service.rebuild(), { code: 'pdf/cancelled' })
})

test('dispose waits for a reset already in storage and prevents subsequent search admission', async () => {
  const f = fixture(), started = deferred<void>(), gate = deferred<void>()
  f.ports.cache!.clear = async () => { started.resolve(); await gate.promise; f.stored.clear() }
  const reset = f.service.rebuild()
  const rejected = assert.rejects(reset, { code: 'pdf/cancelled' })
  await started.promise
  const disposal = f.service.dispose()
  await assert.rejects(f.service.search('session', baseInput), { code: 'pdf/cancelled' })
  gate.resolve()
  await rejected
  await disposal
})
