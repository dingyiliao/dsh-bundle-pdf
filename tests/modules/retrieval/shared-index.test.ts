import assert from 'node:assert/strict'
import test from 'node:test'
import { createRetrievalService } from '../../../src/modules/retrieval/service.ts'
import type { RetrievalDocument, RetrievalEmbedding, RetrievalInput, RetrievalPorts, RetrievalProgress } from '../../../src/modules/retrieval/types.ts'

const turn = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const input = (session: string, extra: Partial<RetrievalInput> = {}): RetrievalInput => ({
  documentId: `document-${session}`, query: 'cat', mode: 'semantic', ...extra,
})

function fixture(options: { cache?: boolean; pagesPerStep?: number } = {}) {
  const text = ['An introduction to the book.', 'A cat sleeps in the garden.', 'A final page about feline behavior.']
  const documents = new Map<string, RetrievalDocument>(['a', 'b'].map(session => [session, {
    id: `document-${session}`, path: `/session-${session}/copy.pdf`, sourceDigest: 'same-source-v1',
    contentVersion: `working-copy-version-${session}`, pageCount: text.length,
  }]))
  const reads: Array<{ session: string; page: number; signal: AbortSignal }> = []
  const calls: Array<{ session: string; purpose: string; texts: string[] }> = []
  const pins = new Map<string, number>(), revoked = new Set<string>(), cache = new Map<string, unknown>()
  const providers = new Map<string, RetrievalEmbedding>()
  for (const session of ['a', 'b']) providers.set(session, {
    fingerprint: 'same-model', generation: 'same-registration', configurationIdentity: 'same-binding',
    dimensions: 2, maxBatchSize: 8, maxInputCharacters: 1200,
    async embed(texts, purpose, signal) {
      signal.throwIfAborted()
      calls.push({ session, purpose, texts: [...texts] })
      return texts.map(value => Array.from({ length: providers.get(session)!.dimensions },
        (_, index) => index === (/cat|feline/i.test(value) ? 0 : 1) ? 1 : 0))
    },
  })
  const state = { onRead: undefined as ((session: string, page: number, signal: AbortSignal) => Promise<string | undefined>) | undefined }
  const snapshot = (session: string, id: string) => {
    if (revoked.has(session)) throw Object.assign(new Error('Access revoked'), { code: 'pdf/access-denied' })
    const document = documents.get(session)
    assert.equal(id, document?.id, 'a Session resolves only its own working-copy reference')
    if (!document) throw Object.assign(new Error('Closed document'), { code: 'pdf/unknown-document' })
    return { ...document }
  }
  const ports: RetrievalPorts = {
    documents: { snapshot, async retain(session, id, signal) {
      snapshot(session, id); signal.throwIfAborted()
      pins.set(session, (pins.get(session) ?? 0) + 1)
      let released = false
      return () => { assert.equal(released, false, 'each build lease releases once'); released = true; pins.set(session, pins.get(session)! - 1) }
    } },
    pages: { async read(session, id, page, signal) {
      snapshot(session, id)
      reads.push({ session, page, signal })
      return { text: await state.onRead?.(session, page, signal) ?? text[page - 1]!, source: 'pdf-text' }
    } },
    embedding: { select: session => providers.get(session) },
    limits: { pagesPerStep: options.pagesPerStep ?? 1 },
    ...(options.cache ? { cache: { async get(key: string) { return cache.get(key) },
      async set(key: string, value: unknown) { cache.set(key, structuredClone(value)) } } } : {}),
  }
  return { service: createRetrievalService(ports), ports, state, documents, providers, reads, calls, pins, revoked, cache }
}
const documentCalls = (f: ReturnType<typeof fixture>) => f.calls.filter(call => call.purpose === 'document').flatMap(call => call.texts)

test('document rebuild refreshes ready text and vectors without invalidating another source or disabling warm reuse', async () => {
  const f = fixture({ cache: true })
  f.documents.set('b', { ...f.documents.get('b')!, sourceDigest: 'other-source' })
  try {
    await f.service.prepare('a', { documentId: 'document-a' })
    await f.service.prepare('b', { documentId: 'document-b' })
    const before = await f.service.search('a', input('a'))
    const other = await f.service.search('b', input('b'))
    const previousWindow = await f.service.search('a', input('a', { maxPages: 2 }))
    const otherWindow = await f.service.search('b', input('b', { maxPages: 2 }))
    assert.ok(previousWindow.nextCursor); assert.ok(otherWindow.nextCursor)
    const reads = f.reads.length, embeddings = documentCalls(f).length
    f.state.onRead = async (session, page) => session === 'a' ? `Refreshed cat material on page ${page}.` : undefined
    await f.service.prepare('a', { documentId: 'document-a', rebuild: true })
    assert.equal(f.reads.length, reads + 3, 'ready pages must be reread rather than restored from cache')
    assert.equal(documentCalls(f).length, embeddings + 3, 'fresh text must be encoded again')
    const refreshed = await f.service.search('a', input('a'))
    assert.notEqual(refreshed.indexGeneration, before.indexGeneration)
    assert.ok(refreshed.chunks.every(chunk => chunk.text.includes('Refreshed cat material')))
    await assert.rejects(f.service.search('a', input('a', { maxPages: 2, cursor: previousWindow.nextCursor })), { code: 'pdf/stale-reader' })
    const freshEmbeddings = documentCalls(f).length
    await f.service.prepare('a', { documentId: 'document-a', rebuild: true })
    assert.equal(documentCalls(f).length, freshEmbeddings + 3, 'even unchanged text must get fresh embeddings on an explicit rebuild')
    const unchanged = await f.service.search('b', input('b'))
    assert.equal(unchanged.indexGeneration, other.indexGeneration)
    const otherContinuation = await f.service.search('b', input('b', { maxPages: 2, cursor: otherWindow.nextCursor }))
    assert.equal(otherContinuation.indexGeneration, otherWindow.indexGeneration)
    f.service.validate('b', other)
    const warmReads = f.reads.length, warmEmbeddings = documentCalls(f).length
    await f.service.prepare('a', { documentId: 'document-a' })
    await f.service.prepare('b', { documentId: 'document-b' })
    assert.equal(f.reads.length, warmReads)
    assert.equal(documentCalls(f).length, warmEmbeddings)
    const restored = createRetrievalService(f.ports)
    try {
      await restored.prepare('a', { documentId: 'document-a' })
      assert.equal(f.reads.length, warmReads, 'the rebuilt cache remains reusable after service recreation')
      assert.equal(documentCalls(f).length, warmEmbeddings)
    } finally { await restored.dispose() }
  } finally { await f.service.dispose() }
})

test('rebuild waits for admitted same-source cache writes and respects cancellation while waiting', async () => {
  const f = fixture({ cache: true, pagesPerStep: 3 }), entered = deferred(), gate = deferred()
  const originalSet = f.ports.cache!.set
  let hold = true
  f.ports.cache!.set = async (key, value) => {
    if (hold) { entered.resolve(); await gate.promise }
    await originalSet(key, value)
  }
  const original = f.service.prepare('a', { documentId: 'document-a' }).catch(error => {
    assert.equal(error.code, 'pdf/stale-reader', 'a replaced generation can only require its old caller to restart')
  })
  try {
    await entered.promise
    const caller = new AbortController()
    const cancelledRebuild = f.service.prepare('b', { documentId: 'document-b', rebuild: true }, caller.signal)
    const stopped = assert.rejects(cancelledRebuild, /Stopped rebuild/)
    await turn()
    caller.abort(new Error('Stopped rebuild'))
    await stopped
    let rebuilt = false
    const rebuild = f.service.prepare('b', { documentId: 'document-b', rebuild: true }).then(() => { rebuilt = true })
    await turn()
    assert.equal(f.reads.length, 1, 'new native reads cannot overtake a still-pending old cache write')
    assert.equal(rebuilt, false)
    hold = false; gate.resolve()
    await Promise.all([original, rebuild])
    assert.equal(f.reads.length, 6)
    assert.equal(rebuilt, true)
    assert.equal(f.pins.get('a'), 0); assert.equal(f.pins.get('b'), 0)
  } finally { hold = false; gate.resolve(); await original.catch(() => undefined); await f.service.dispose() }
})

test('disposal cancels a waiting rebuild while retaining an old read lease until its real completion', async () => {
  const f = fixture(), entered = deferred(), gate = deferred()
  f.state.onRead = async () => { entered.resolve(); await gate.promise; return undefined }
  const original = f.service.prepare('a', { documentId: 'document-a' })
  const firstStopped = assert.rejects(original, { code: 'pdf/cancelled' })
  try {
    await entered.promise
    const rebuild = f.service.prepare('b', { documentId: 'document-b', rebuild: true })
    const rebuildStopped = assert.rejects(rebuild, { code: 'pdf/cancelled' })
    await turn()
    const closing = f.service.dispose()
    await rebuildStopped
    assert.equal(f.pins.get('a'), 1, 'cancelling the waiting caller cannot release another active native read')
    gate.resolve()
    await Promise.all([firstStopped, closing])
    assert.equal(f.pins.get('a'), 0)
  } finally { gate.resolve(); await firstStopped; await f.service.dispose() }
})

test('a denied caller cannot rebuild a shared source or invalidate its authorized ready index', async () => {
  const f = fixture()
  try {
    await f.service.prepare('a', { documentId: 'document-a' })
    const before = await f.service.search('a', input('a'))
    const reads = f.reads.length, embeddings = documentCalls(f).length
    f.revoked.add('b')
    await assert.rejects(f.service.prepare('b', { documentId: 'document-b', rebuild: true }), { code: 'pdf/access-denied' })
    assert.equal(f.reads.length, reads)
    assert.equal(documentCalls(f).length, embeddings)
    assert.equal((await f.service.search('a', input('a'))).indexGeneration, before.indexGeneration)
  } finally { await f.service.dispose() }
})

test('a ready index is shared without any persistent cache while results and query providers bind to each caller', { timeout: 30_000 }, async () => {
  const f = fixture()
  try {
    assert.notEqual(f.providers.get('a'), f.providers.get('b'), 'provider closures are Session-local')
    await f.service.prepare('a', { documentId: 'document-a' })
    const first = await f.service.search('a', input('a'))
    const readCount = f.reads.length, embedded = documentCalls(f).length
    const progress: RetrievalProgress[] = []
    await f.service.prepare('b', { documentId: 'document-b' }, undefined, value => { progress.push(value) })
    assert.deepEqual(progress, [{ indexedPages: 3, totalPages: 3, embeddedChunks: 3, totalChunks: 3,
      phase: 'ready', reusedChunks: 3, computedChunks: 0 }])
    const second = await f.service.search('b', input('b'))
    assert.equal(second.status, 'complete')
    assert.equal(second.indexGeneration, first.indexGeneration)
    assert.equal(f.reads.length, readCount, 'warm cross-Session reuse never re-extracts pages')
    assert.equal(documentCalls(f).length, embedded, 'warm cross-Session reuse never re-embeds document text')
    assert.deepEqual(second.document, f.documents.get('b'))
    assert.equal(f.calls.at(-1)!.session, 'b', 'query encoding must use the caller provider, not the first builder closure')
    assert.equal(f.calls.at(-1)!.purpose, 'query')
    assert.equal(JSON.stringify(second).includes('document-a'), false)
    f.service.validate('a', first); f.service.validate('b', second)
    assert.throws(() => f.service.validate('b', first), { code: 'pdf/stale-reader' })
  } finally { await f.service.dispose() }
})

test('ready data survives the original Session retirement without granting another caller document access', { timeout: 30_000 }, async () => {
  const f = fixture()
  try {
    await f.service.prepare('a', { documentId: 'document-a' })
    const first = await f.service.search('a', input('a'))
    f.service.cancelSession('a'); f.documents.delete('a')
    f.revoked.add('b')
    const before = { reads: f.reads.length, calls: f.calls.length }
    await assert.rejects(f.service.search('b', input('b')), { code: 'pdf/access-denied' })
    assert.deepEqual({ reads: f.reads.length, calls: f.calls.length }, before, 'shared data cannot authorize a denied working copy')
    f.revoked.delete('b')
    const second = await f.service.search('b', input('b'))
    assert.equal(second.indexGeneration, first.indexGeneration)
    assert.equal(second.status, 'complete')
    assert.equal(f.reads.length, before.reads)
    assert.equal(documentCalls(f).length, 3)
    assert.equal(f.calls.at(-1)!.session, 'b')
    assert.throws(() => f.service.validate('a', first), { code: 'pdf/stale-reader' })
    f.service.validate('b', second)
  } finally { await f.service.dispose() }
})

for (const cancellation of ['abort', 'retire'] as const) {
  test(`concurrent preparations share work and ${cancellation} of one Session keeps the real read lease until completion`, { timeout: 30_000 }, async () => {
    const f = fixture(), entered = deferred(), gate = deferred(), controller = new AbortController()
    f.state.onRead = async (session, page) => {
      if (session === 'a' && page === 1) { entered.resolve(); await gate.promise }
      return undefined
    }
    const first = f.service.prepare('a', { documentId: 'document-a' }, controller.signal)
    const firstRejected = assert.rejects(first, cancellation === 'abort' ? /Caller stopped/ : { code: 'pdf/cancelled' })
    try {
      await entered.promise
      const second = f.service.prepare('b', { documentId: 'document-b' })
      await turn()
      assert.equal(f.reads.length, 1, 'both callers join the same pending read')
      assert.equal(f.pins.get('a'), 1)
      if (cancellation === 'abort') controller.abort(new Error('Caller stopped'))
      else f.service.cancelSession('a')
      await firstRejected
      assert.equal(f.pins.get('a'), 1, 'aborting a subscriber must not release the build-owned lease during a non-cooperative read')
      assert.equal(f.reads[0]!.signal.aborted, false, 'the other subscriber still owns the shared step')
      gate.resolve(); await second
      assert.deepEqual(f.reads.map(read => read.page), [1, 2, 3])
      assert.equal(documentCalls(f).length, 3)
      assert.equal(f.pins.get('a'), 0); assert.equal(f.pins.get('b'), 0)
      assert.equal((await f.service.search('b', input('b'))).status, 'complete')
      assert.equal(f.calls.filter(call => call.purpose === 'document' && call.session === 'a').length, 0,
        'later model work cannot borrow the departed caller provider')
    } finally { gate.resolve(); await f.service.dispose(); await firstRejected }
  })
}

for (const invalidation of ['changed-source', 'revoked'] as const) {
  test(`a ${invalidation} source is replaced by another authorized Session without committing its late text`, { timeout: 30_000 }, async () => {
    const f = fixture(), entered = deferred(), gate = deferred()
    f.state.onRead = async (session, page) => {
      if (session === 'a' && page === 1) { entered.resolve(); await gate.promise; return 'POISON from an obsolete or unauthorized source' }
      return undefined
    }
    const first = f.service.prepare('a', { documentId: 'document-a' })
    const firstRejected = assert.rejects(first, { code: invalidation === 'revoked' ? 'pdf/access-denied' : 'pdf/stale-reader' })
    try {
      await entered.promise
      const second = f.service.prepare('b', { documentId: 'document-b' })
      await turn()
      if (invalidation === 'revoked') f.revoked.add('a')
      else f.documents.set('a', { ...f.documents.get('a')!, sourceDigest: 'replaced-source', contentVersion: 'replaced-content' })
      gate.resolve()
      await Promise.all([firstRejected, second])
      assert.deepEqual(f.reads.map(({ session, page }) => `${session}:${page}`), ['a:1', 'b:1', 'b:2', 'b:3'])
      assert.equal(documentCalls(f).length, 3)
      assert.ok(documentCalls(f).every(text => !text.includes('POISON')))
      const result = await f.service.search('b', input('b'))
      assert.equal(result.status, 'complete')
      assert.ok(result.chunks.every(chunk => !chunk.text.includes('POISON')))
      assert.equal(f.pins.get('a'), 0); assert.equal(f.pins.get('b'), 0)
    } finally { gate.resolve(); await f.service.dispose(); await firstRejected }
  })
}

test('continuation cursors and result fences stay Session-local while cancellation preserves another Session progress', { timeout: 30_000 }, async () => {
  const f = fixture()
  try {
    const a = await f.service.search('a', input('a'))
    const b = await f.service.search('b', input('b'))
    assert.equal(a.status, 'building'); assert.equal(b.status, 'building')
    assert.equal(a.indexGeneration, b.indexGeneration)
    await assert.rejects(f.service.search('b', input('b', { cursor: a.nextCursor })), { code: 'pdf/stale-reader' })
    assert.throws(() => f.service.validate('b', a), { code: 'pdf/stale-reader' })
    f.service.validate('a', a); f.service.validate('b', b)
    f.service.cancelSession('a')
    assert.throws(() => f.service.validate('a', a), { code: 'pdf/stale-reader' })
    await assert.rejects(f.service.search('a', input('a', { cursor: a.nextCursor })), { code: 'pdf/stale-reader' })
    f.service.validate('b', b)
    const completed = await f.service.search('b', input('b', { cursor: b.nextCursor }))
    assert.equal(completed.status, 'complete')
    assert.equal(completed.indexGeneration, b.indexGeneration)
    assert.deepEqual(f.reads.map(read => read.page), [1, 2, 3])
    assert.equal(documentCalls(f).length, 3)
    assert.equal((await f.service.search('a', input('a'))).indexGeneration, completed.indexGeneration,
      'a fresh authorized Session generation can reuse data without resurrecting old cursors')
  } finally { await f.service.dispose() }
})

test('different content, range, engine binding, dimensions, generation and chunk encoding cannot share an index', { timeout: 30_000 }, async t => {
  for (const distinction of ['digest', 'range', 'configuration', 'dimensions', 'generation', 'input-limit', 'page-count'] as const) {
    await t.test(distinction, async () => {
      const f = fixture({ cache: true })
      try {
        await f.service.prepare('a', { documentId: 'document-a' })
        const a = await f.service.search('a', input('a'))
        if (distinction === 'digest') f.documents.get('b')!.sourceDigest = 'another-source'
        if (distinction === 'configuration') f.providers.get('b')!.configurationIdentity = 'another-binding'
        if (distinction === 'dimensions') f.providers.get('b')!.dimensions = 3
        if (distinction === 'generation') f.providers.get('b')!.generation = 'another-registration'
        if (distinction === 'input-limit') f.providers.get('b')!.maxInputCharacters = 128
        if (distinction === 'page-count') f.documents.get('b')!.pageCount = 2
        const scope = distinction === 'range' ? { fromPage: 2, maxPages: 1 } : {}
        await f.service.prepare('b', { documentId: 'document-b', ...scope })
        const b = await f.service.search('b', input('b', scope))
        assert.notEqual(b.indexGeneration, a.indexGeneration)
        assert.equal(b.status, 'complete')
        assert.deepEqual(b.document, f.documents.get('b'))
        if (distinction === 'configuration') assert.equal(documentCalls(f).length, 6,
          'persistent vectors also include the binding identity when the provider fingerprint omits its config')
      } finally { await f.service.dispose() }
    })
  }
})

test('persistent vectors restore only within their exact engine configuration namespace', { timeout: 30_000 }, async () => {
  const f = fixture({ cache: true })
  try {
    await f.service.prepare('a', { documentId: 'document-a' })
    f.providers.get('b')!.configurationIdentity = 'another-binding'
    await f.service.prepare('b', { documentId: 'document-b' })
    assert.equal(documentCalls(f).length, 6)
    await f.service.dispose()
    const restored = createRetrievalService(f.ports)
    try {
      await restored.prepare('b', { documentId: 'document-b' })
      assert.equal(documentCalls(f).length, 6, 'the same saved binding can restore its own vectors after a service restart')
      assert.equal((await restored.search('b', input('b'))).status, 'complete')
    } finally { await restored.dispose() }
  } finally { await f.service.dispose() }
})

test('an attested document encoder reuses vectors across query and transport changes while keeping queries separate', async () => {
  const f = fixture({ cache: true })
  try {
    f.providers.get('a')!.documentFingerprint = 'document-encoding-v1'
    await f.service.prepare('a', { documentId: 'document-a' })
    const before = await f.service.search('a', input('a'))
    const second = f.providers.get('b')!
    second.documentFingerprint = 'document-encoding-v1'
    second.configurationIdentity = 'changed-query-and-batch-configuration'
    second.fingerprint = 'new-query-prefix-identity'
    second.maxBatchSize = 1
    const progress: RetrievalProgress[] = []
    await f.service.prepare('b', { documentId: 'document-b' }, undefined, value => progress.push(value))
    const after = await f.service.search('b', input('b'))
    assert.notEqual(before.indexGeneration, after.indexGeneration, 'query and continuation identities remain distinct')
    assert.equal(documentCalls(f).length, 3, 'all original document vectors were reused without encoding again')
    assert.equal(progress.at(-1)?.reusedChunks, 3); assert.equal(progress.at(-1)?.computedChunks, 0)
    assert.ok(f.calls.some(call => call.session === 'b' && call.purpose === 'query'), 'the new binding still computes its own query')
    f.service.validate('a', before)
    f.service.validate('b', after)
    second.documentFingerprint = 'different-document-encoding'
    assert.throws(() => f.service.validate('b', after), { code: 'pdf/stale-reader' })
    await f.service.prepare('b', { documentId: 'document-b' })
    assert.equal(documentCalls(f).length, 6, 'different weights cannot restore the previous document vectors')
  } finally { await f.service.dispose() }
})
