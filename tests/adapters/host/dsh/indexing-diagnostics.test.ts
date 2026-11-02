import assert from 'node:assert/strict'
import test from 'node:test'
import { EmbeddingError } from '../../../../src/embedding/types.ts'
import { OcrError } from '../../../../src/ocr/types.ts'
import { ImageUnderstandingError } from '../../../../src/modules/image-understanding/service.ts'
import { createIndexingDiagnostics, type PrefetchDiagnosticEvent } from '../../../../src/adapters/host/dsh/indexing-diagnostics.ts'
import { indexingDiagnosticsResultSchema } from '../../../../src/contracts/indexing-diagnostics.ts'
import { recordIndexPerformance } from '../../../../src/modules/retrieval/performance.ts'

const base = { sessionId: 'session', documentId: 'document', occurrence: 1 }

test('disposal releases async scopes and history without admitting late observation', async () => {
  const f = fixture()
  f.record({ event: 'started' })
  await f.diagnostics.run('session', 'document', async () => {
    f.diagnostics.dispose()
    await Promise.resolve()
    f.diagnostics.activity('session', 'document', { page: 1, layer: 'native', event: 'ready' })
    f.diagnostics.failure('session', 'document', new Error('late'))
    f.record({ event: 'ready' })
  })
  f.diagnostics.dispose()
  assert.equal(await f.diagnostics.run('session', 'document', async () => 9), 9)
  assert.equal(f.events.length, 1)
  assert.throws(() => f.diagnostics.read('session', 'document', 1), { code: 'pdf/index-diagnostics-unavailable' })
})

test('a maximum-detail current attempt and previous history fit the diagnostic transport budget', async () => {
  const f = fixture()
  let error: Error | undefined
  for (let depth = 0; depth < 4; depth++) error = Object.assign(new Error('private', { cause: error }),
    { code: `pdf/${'x'.repeat(124)}`, status: 503 })
  for (let occurrence = 1; occurrence <= 7; occurrence++) {
    f.diagnostics.record({ ...base, occurrence, event: 'started' })
    await f.diagnostics.run('session', 'document', async () => {
      for (let page = 1; page <= 40; page++) f.diagnostics.activity('session', 'document', { page, layer: 'image', event: 'failed', error })
      for (let index = 0; index < 32; index++) recordIndexPerformance({ stage: `stage-${index}-${'x'.repeat(54)}`,
        durationMs: Number.MAX_SAFE_INTEGER, bytes: Number.MAX_SAFE_INTEGER, records: Number.MAX_SAFE_INTEGER,
        requests: Number.MAX_SAFE_INTEGER, cacheHit: true })
    })
    f.diagnostics.record({ ...base, occurrence, event: 'failed', error })
  }
  const value = f.diagnostics.read('session', 'document', 7)
  assert.equal(value.task.events.length, 32)
  assert.equal(value.previousAttempts.length, 5)
  assert.ok(value.previousAttempts.every(attempt => attempt.events.length === 8))
  const report = JSON.stringify(value, null, 2)
  assert.ok(indexingDiagnosticsResultSchema.safeParse({ directory: value.logDirectory, report, canOpen: true }).success)
})
const progress = { indexedPages: 2, totalPages: 10, embeddedChunks: 1, totalChunks: 20, phase: 'extracting' as const }
function fixture() {
  let time = Date.parse('2026-10-31T00:00:00Z'), failure: string | undefined
  const events: Readonly<Record<string, unknown>>[] = []
  const diagnostics = createIndexingDiagnostics({ log: { directory: '/test/logs', append: event => events.push(event), failureCode: () => failure }, now: () => time })
  return { diagnostics, events, tick: (delta: number) => { time += delta }, failLog: () => { failure = 'pdf/index-log-unavailable' },
    record: (event: Omit<PrefetchDiagnosticEvent, keyof typeof base>) => diagnostics.record({ ...base, ...event }) }
}

test('each retry has a unique diagnostic ID and keeps the earlier failure without provider or document content', () => {
  const f = fixture()
  f.record({ event: 'queued' }); f.record({ event: 'started' }); f.tick(500)
  f.record({ event: 'progress', progress }); f.tick(250)
  const cause = Object.assign(new Error('Bearer secret-token; private PDF words; /private/document.pdf'), { code: 'ECONNRESET', statusCode: 503 })
  f.record({ event: 'failed', error: new Error('API key: private', { cause }) })
  const failure = f.diagnostics.read('session', 'document', 1)
  assert.equal(failure.task.state, 'failed')
  assert.equal(failure.task.elapsedMs, 750)
  assert.equal(failure.task.updatedAt, '2026-10-31T00:00:00.750Z')
  assert.deepEqual(failure.task.progress, progress)
  assert.equal(failure.task.failure?.category, 'network')
  assert.equal(failure.task.failure?.code, 'ECONNRESET')
  assert.deepEqual(failure.task.failure?.causes, [{ name: 'Error' }, { name: 'Error', code: 'ECONNRESET', status: 503 }])
  f.diagnostics.record({ ...base, occurrence: 2, event: 'queued' })
  f.diagnostics.record({ ...base, occurrence: 2, event: 'started' })
  f.diagnostics.record({ ...base, occurrence: 2, event: 'ready' })
  const retry = f.diagnostics.read('session', 'document', 2)
  assert.notEqual(retry.task.runId, failure.task.runId)
  assert.deepEqual(retry.previousAttempts, [failure.task])
  const serialized = JSON.stringify({ report: retry, events: f.events })
  for (const secret of ['secret-token', 'private PDF', 'document.pdf', 'API key']) assert.ok(!serialized.includes(secret))
  assert.ok(f.events.every(event => !('sessionId' in event) && !('documentId' in event)))
  assert.equal(String(f.events[0]!.sessionKey).length, 64)
  retry.task.events.length = 0
  assert.equal(f.diagnostics.read('session', 'document', 2).task.events.length, 3, 'copying diagnostics cannot mutate history')
})

test('progress is retained live but phase changes cannot bypass the disk write interval', () => {
  const f = fixture()
  f.record({ event: 'queued' }); f.record({ event: 'started' }); f.record({ event: 'progress', progress })
  f.tick(100)
  f.record({ event: 'progress', progress: { ...progress, indexedPages: 3 } })
  assert.equal(f.events.length, 3)
  assert.equal(f.diagnostics.read('session', 'document', 1).task.progress?.indexedPages, 3)
  f.record({ event: 'progress', progress: { ...progress, phase: 'embedding' } })
  assert.equal(f.events.length, 3)
  f.tick(2000); f.record({ event: 'progress', progress: { ...progress, phase: 'embedding' } })
  assert.equal(f.events.length, 4)
  f.record({ event: 'cancelled', reason: 'user' })
  assert.equal(f.events.length, 5)
  const report = f.diagnostics.read('session', 'document', 1)
  assert.equal(report.task.cancellationReason, 'user')
  assert.equal(report.task.events.at(-1)?.event, 'cancelled')
  f.record({ event: 'failed', error: new Error('late rejection') })
  f.record({ event: 'progress', progress })
  assert.equal(f.events.length, 5, 'late completion cannot overwrite the original terminal state')
})

test('page activity records bounded structural causes and ignores work outside a running occurrence', async () => {
  const f = fixture()
  f.diagnostics.activity('session', 'document', { page: 1, layer: 'ocr', event: 'started' })
  assert.equal(f.events.length, 0)
  f.record({ event: 'started' })
  await f.diagnostics.run('session', 'document', async () => {
    f.diagnostics.activity('foreign', 'document', { page: 1, layer: 'ocr', event: 'started' })
    assert.equal(f.events.length, 1)
    f.diagnostics.activity('session', 'document', { page: 3, layer: 'ocr', event: 'failed',
      error: Object.assign(new Error('private model reply'), { name: 'TimeoutError', code: 'ocr/timeout' }) })
  })
  const report = f.diagnostics.read('session', 'document', 1)
  assert.deepEqual(report.task.events.at(-1)?.activity, { page: 3, layer: 'ocr', event: 'failed' })
  assert.equal(report.task.events.at(-1)?.failure?.category, 'timeout')
  await f.diagnostics.run('session', 'document', async () => {
    for (let index = 0; index < 40; index++) { f.tick(2000); f.diagnostics.activity('session', 'document', { page: index + 1, layer: 'native', event: 'ready' }) }
  })
  const bounded = f.diagnostics.read('session', 'document', 1)
  assert.equal(bounded.task.events.length, 32)
  assert.equal(bounded.task.events[0]?.event, 'started')
  assert.equal(bounded.task.events.at(-1)?.activity?.page, 40)
})

test('failure classification uses safe codes, statuses and bounded causes, not arbitrary errors or accessors', () => {
  const f = fixture()
  const cases = [
    { error: Object.assign(new Error(''), { code: 'embedding/unavailable' }), category: 'engine' },
    { error: Object.assign(new Error(''), { code: 'pdf/stale-source' }), category: 'source' },
    { error: Object.assign(new Error(''), { code: 'pdf/native-worker-failed' }), category: 'native' },
    { error: Object.assign(new Error(''), { code: 'invalid code secret', name: 'private name', status: 999 }), category: 'unknown' },
    { error: undefined, category: 'unknown' },
    { error: new DOMException('private timeout', 'TimeoutError'), category: 'timeout' },
    { error: new TypeError('private failure'), category: 'unknown' },
    { error: new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private trap') } }), category: 'unknown' },
  ]
  cases.forEach(({ error, category }, index) => {
    f.diagnostics.record({ ...base, occurrence: index + 1, event: 'failed', error })
    const failure = f.diagnostics.read('session', 'document', index + 1).task.failure!
    assert.equal(failure.category, category)
    assert.ok(!JSON.stringify(failure).includes('private'))
  })
  const cycle = Object.assign(new Error('private'), { code: 'pdf/retrieval-failed', cause: undefined as unknown })
  cycle.cause = cycle
  f.diagnostics.record({ ...base, occurrence: 9, event: 'failed', error: cycle })
  assert.equal(f.diagnostics.read('session', 'document', 9).task.failure?.causes.length, 1)
  let nested: unknown
  for (let index = 0; index < 9; index++) nested = new Error('private', { cause: nested })
  f.diagnostics.record({ ...base, occurrence: 10, event: 'failed', error: nested })
  assert.equal(f.diagnostics.read('session', 'document', 10).task.failure?.causes.length, 4)
})

test('resource and storage failures retain bounded numeric budget evidence without raw payloads', () => {
  const f = fixture()
  const budget = { kind: 'memory' as const, limit: 64 * 1024 * 1024, used: 67_000_000, requested: 107_446 }
  f.record({ event: 'failed', error: Object.assign(new Error('private document and storage path'),
    { code: 'pdf/retrieval-budget', budget: { ...budget, documentText: 'private content' } }) })
  const failure = f.diagnostics.read('session', 'document', 1).task.failure!
  assert.equal(failure.category, 'resource')
  assert.deepEqual(failure.budget, budget)
  assert.ok(!JSON.stringify(failure).includes('private'))
  for (const [index, kind] of ['page', 'chunks', 'record', 'indexes'].entries()) {
    f.diagnostics.record({ ...base, occurrence: index + 2, event: 'failed', error: Object.assign(new Error(''),
      { code: `pdf/retrieval-${kind}-budget`, budget: { kind, limit: 1, used: 1, requested: 1 } }) })
    assert.equal(f.diagnostics.read('session', 'document', index + 2).task.failure!.category, 'resource')
  }
  f.diagnostics.record({ ...base, occurrence: 6, event: 'failed', error: Object.assign(new Error('private filename'),
    { code: 'pdf/index-storage-write-failed', cause: Object.assign(new Error('private drive'), { code: 'ENOSPC' }) }) })
  const storage = f.diagnostics.read('session', 'document', 6).task.failure!
  assert.equal(storage.category, 'storage')
  assert.deepEqual(storage.causes, [{ name: 'Error', code: 'pdf/index-storage-write-failed' }, { name: 'Error', code: 'ENOSPC' }])
})

test('invalid or accessor-backed budget metadata is ignored instead of leaking arbitrary properties', () => {
  const f = fixture()
  const invalid: unknown[] = [undefined, null, 'private', { kind: 'private', limit: 1, used: 0, requested: 1 },
    { kind: 'memory', limit: -1, used: 0, requested: 1 }, { kind: 'memory', limit: 1.5, used: 0, requested: 1 },
    { kind: 'memory', limit: 1, used: Infinity, requested: 1 }, { kind: 'memory', limit: 1, used: 0, requested: NaN },
    { kind: 'memory', limit: Number.MAX_SAFE_INTEGER + 1, used: 0, requested: 1 },
    Object.defineProperty({}, 'kind', { get() { throw new Error('must not evaluate private getters') } })]
  for (const [index, budget] of invalid.entries()) {
    f.diagnostics.record({ ...base, occurrence: index + 1, event: 'failed', error: Object.assign(new Error(''), { code: 'pdf/retrieval-budget', budget }) })
    assert.equal(f.diagnostics.read('session', 'document', index + 1).task.failure!.budget, undefined)
  }
})

test('history is bounded, session scoped and reports storage failure without allowing the logger to own execution', () => {
  const f = fixture()
  for (let occurrence = 1; occurrence <= 70; occurrence++) f.diagnostics.record({ ...base, occurrence, event: 'ready' })
  assert.throws(() => f.diagnostics.read('session', 'document', 1), { code: 'pdf/index-diagnostics-unavailable' })
  assert.equal(f.diagnostics.read('session', 'document', 70).previousAttempts.length, 5)
  assert.throws(() => f.diagnostics.read('foreign', 'document', 70), { code: 'pdf/index-diagnostics-unavailable' })
  f.failLog()
  assert.equal(f.diagnostics.read('session', 'document', 70).logFailureCode, 'pdf/index-log-unavailable')
  const failing = createIndexingDiagnostics({ log: { directory: '/logs', append() { throw new Error('storage failed') },
    failureCode() { throw new Error('private storage failure') } } })
  assert.doesNotThrow(() => failing.record({ ...base, event: 'started' }))
  assert.equal(failing.read('session', 'document', 1).logFailureCode, 'pdf/index-log-unavailable')
  // The bound also applies when all 64 retained owners are still running.
  for (let occurrence = 2; occurrence <= 65; occurrence++) failing.record({ ...base, occurrence, event: 'started' })
  assert.throws(() => failing.read('session', 'document', 1), { code: 'pdf/index-diagnostics-unavailable' })
})


test('rapid native page activity does not flood the log and terminal snapshots retain the latest page', async () => {
  const f = fixture()
  f.record({ event: 'started' })
  await f.diagnostics.run('session', 'document', async () => {
    for (let page = 1; page <= 1151; page++) {
      f.diagnostics.activity('session', 'document', { page, layer: 'native', event: 'started' })
      f.diagnostics.activity('session', 'document', { page, layer: 'native', event: 'ready' })
    }
  })
  assert.equal(f.events.length, 2)
  const current = { page: 1151, layer: 'native', event: 'ready' }
  assert.deepEqual(f.diagnostics.read('session', 'document', 1).task.currentActivity, current)
  await f.diagnostics.run('session', 'document', async () => {
    f.diagnostics.activity('session', 'document', { page: 1151, layer: 'native', event: 'failed',
      error: Object.assign(new Error('private detail'), { code: 'pdf/native-failed' }) })
  })
  assert.equal(f.events.length, 3, 'failures bypass activity throttling')
  f.record({ event: 'failed', error: new DOMException('private timeout', 'TimeoutError') })
  assert.equal(f.events.length, 4)
  assert.deepEqual(f.events.at(-1)?.activity, { ...current, event: 'failed' })
  assert.equal(f.diagnostics.read('session', 'document', 1).task.failure?.category, 'timeout')
})


test('real embedding, OCR and image errors preserve their public code and typed failure category', () => {
  const f = fixture()
  const cases = [
    { error: new EmbeddingError('timeout', 'private input'), name: 'EmbeddingError', code: 'timeout', category: 'timeout' },
    { error: new EmbeddingError('invalid-result', 'private response'), name: 'EmbeddingError', code: 'invalid-result', category: 'engine' },
    { error: new OcrError('recognition-failed', 'private recognized text', { cause: Object.assign(new Error('private socket address'), { code: 'ECONNRESET' }) }),
      name: 'OcrError', code: 'recognition-failed', category: 'network' },
    { error: new ImageUnderstandingError('image/engine-unavailable', 'private prompt'), name: 'ImageUnderstandingError', code: 'image/engine-unavailable', category: 'engine' },
    { error: Object.assign(new EmbeddingError('engine-unavailable', 'private HTTP body'), { status: 503 }), name: 'EmbeddingError', code: 'engine-unavailable', category: 'network' },
  ]
  cases.forEach(({ error, name, code, category }, index) => {
    f.diagnostics.record({ ...base, occurrence: index + 1, event: 'failed', error })
    const failure = f.diagnostics.read('session', 'document', index + 1).task.failure!
    assert.equal(failure.category, category)
    assert.equal(failure.code, code)
    assert.equal(failure.causes[0]?.name, name)
    assert.ok(!JSON.stringify(failure).includes('private'))
  })
})

test('Host failure details preserve structural causes across shared sanitization without overriding an unrelated final failure', async () => {
  const f = fixture()
  f.diagnostics.failure('session', 'document', new Error('ignored before task start'))
  assert.equal(f.events.length, 0)
  f.record({ event: 'started' })
  await f.diagnostics.run('session', 'document', async () => {
    f.diagnostics.failure('session', 'document', new EmbeddingError('engine-unavailable', 'private input', { cause:
      Object.assign(new Error('private endpoint'), { code: 'ECONNRESET' }) }))
  })
  f.record({ event: 'failed', error: Object.assign(new Error('The shared PDF indexing step could not complete.'), { code: 'engine-unavailable' }) })
  const report = f.diagnostics.read('session', 'document', 1)
  assert.equal(report.task.failure?.category, 'network')
  assert.ok(report.task.failure?.causes.some(cause => cause.code === 'ECONNRESET'))
  assert.equal(report.task.events.at(-2)?.event, 'failure-detail')
  assert.ok(!JSON.stringify(report).includes('private'))
  f.diagnostics.record({ ...base, occurrence: 2, event: 'started' })
  await f.diagnostics.run('session', 'document', async () => {
    f.diagnostics.failure('session', 'document', new OcrError('recognition-failed', 'private content'))
  })
  f.diagnostics.record({ ...base, occurrence: 2, event: 'failed', error: Object.assign(new Error('Source changed'), { code: 'pdf/stale-reader' }) })
  assert.equal(f.diagnostics.read('session', 'document', 2).task.failure?.category, 'source')
})


test('availability wrapper failures retain the scoped engine probe cause', async () => {
  const f = fixture()
  f.record({ event: 'started' })
  await f.diagnostics.run('session', 'document', async () => {
    f.diagnostics.activity('session', 'document', { page: 4, layer: 'embedding', event: 'started' })
    f.diagnostics.failure('session', 'document', new EmbeddingError('engine-unavailable', 'private response', { cause:
      Object.assign(new Error('private endpoint'), { status: 503 }) }))
  })
  f.record({ event: 'failed', error: Object.assign(new Error('Selected embedding engine unavailable'), { code: 'pdf/retrieval-engine-unavailable' }) })
  const report = f.diagnostics.read('session', 'document', 1)
  assert.equal(report.task.failure?.category, 'network')
  assert.equal(report.task.failure?.causes[1]?.status, 503)
  assert.deepEqual(report.task.events.at(-2)?.activity, { page: 4, layer: 'embedding', event: 'started' })
})

test('async diagnostic scope cannot attach retired or foreground work to another attempt', async () => {
  const f = fixture()
  f.record({ event: 'started' })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const original = f.diagnostics.run('session', 'document', async () => {
    f.diagnostics.activity('session', 'document', { page: 1, layer: 'native', event: 'started' })
    await gate
    f.diagnostics.activity('session', 'document', { page: 2, layer: 'ocr', event: 'failed', error: new Error('old operation') })
    f.diagnostics.failure('session', 'document', Object.assign(new Error('old operation'), { code: 'ECONNRESET' }))
  })
  f.record({ event: 'cancelled', reason: 'replaced' })
  f.diagnostics.record({ ...base, occurrence: 2, event: 'started' })
  f.diagnostics.activity('session', 'document', { page: 99, layer: 'image', event: 'started' })
  f.diagnostics.failure('session', 'document', new Error('unrelated foreground request'))
  f.diagnostics.record({ ...base, sessionId: 'other', occurrence: 3, event: 'started' })
  await f.diagnostics.run('session', 'document', async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    f.diagnostics.activity('session', 'document', { page: 9, layer: 'image', event: 'started' })
    f.diagnostics.activity('other', 'document', { page: 99, layer: 'ocr', event: 'started' })
    f.diagnostics.failure('other', 'document', new Error('wrong session'))
    await f.diagnostics.run('other', 'document', async () => {
      f.diagnostics.activity('other', 'document', { layer: 'image', event: 'failed', error: new Error('engine resolution') })
      f.diagnostics.activity('session', 'document', { page: 100, layer: 'ocr', event: 'started' })
    })
    release()
    await original
  })
  const first = f.diagnostics.read('session', 'document', 1).task
  const second = f.diagnostics.read('session', 'document', 2).task
  assert.equal(first.state, 'cancelled')
  assert.deepEqual(first.currentActivity, { page: 1, layer: 'native', event: 'started' })
  assert.deepEqual(second.currentActivity, { page: 9, layer: 'image', event: 'started' })
  assert.equal(second.events.some(event => event.event === 'failure-detail'), false)
  assert.deepEqual(f.diagnostics.read('other', 'document', 3).task.currentActivity, { layer: 'image', event: 'failed' })
  f.diagnostics.record({ ...base, occurrence: 2, event: 'progress', progress })
  assert.deepEqual(f.diagnostics.read('session', 'document', 2).task.progress, progress,
    'owned queue/progress/terminal records do not require the optional activity scope')
})

test('scoping without a running attempt preserves operation results and does not borrow an outer owner', async () => {
  const f = fixture()
  assert.equal(await f.diagnostics.run('session', 'document', async () => {
    f.diagnostics.activity('session', 'document', { layer: 'ocr', event: 'started' })
    f.diagnostics.failure('session', 'document', new Error('no attempt'))
    return 7
  }), 7)
  assert.deepEqual(f.events, [])
  f.record({ event: 'started' })
  const error = new Error('operation failed')
  await assert.rejects(f.diagnostics.run('session', 'document', async () => {
    await f.diagnostics.run('not-running', 'document', async () => {
      f.diagnostics.activity('session', 'document', { page: 999, layer: 'image', event: 'started' })
    })
    throw error
  }), value => value === error)
  assert.equal(f.diagnostics.read('session', 'document', 1).task.currentActivity, undefined)
  assert.equal(f.events.length, 1)
})

test('performance aggregates active slices, excludes queue time and snapshots the terminal summary', async () => {
  const f = fixture(); f.record({ event: 'started' })
  let release!: () => void, late!: Promise<void>
  const gate = new Promise<void>(resolve => { release = resolve })
  await f.diagnostics.run('session', 'document', async () => {
    late = gate.then(() => recordIndexPerformance({ stage: 'retired-slice', durationMs: 999 }))
    f.tick(10)
    recordIndexPerformance({ stage: 'native-render', durationMs: 3, records: 1, bytes: 16, cacheHit: true })
    recordIndexPerformance({ stage: 'native-render', durationMs: 5, records: 2, bytes: 32 })
    assert.equal(f.diagnostics.read('session', 'document', 1).task.performance.activeMs, 10)
  })
  f.tick(1000)
  await f.diagnostics.run('session', 'document', async () => {
    release(); await late
    f.tick(10)
    await f.diagnostics.run('session', 'document', async () => {
      f.tick(10)
      recordIndexPerformance({ stage: 'embedding-http', durationMs: 8, records: 3, requests: 1 })
    })
  })
  f.record({ event: 'ready' })
  const report = f.diagnostics.read('session', 'document', 1)
  assert.equal(report.task.elapsedMs, 1030)
  assert.deepEqual(report.task.performance, { activeMs: 30, stages: {
    'native-render': { calls: 2, totalMs: 8, maxMs: 5, records: 3, bytes: 48, cacheHits: 1, requests: 0 },
    'embedding-http': { calls: 1, totalMs: 8, maxMs: 8, records: 3, bytes: 0, cacheHits: 0, requests: 1 },
  } })
  assert.deepEqual(f.events.at(-1)?.performance, report.task.performance)
  report.task.performance.activeMs = 9999
  report.task.performance.stages['native-render']!.bytes = 9999
  assert.equal(f.diagnostics.read('session', 'document', 1).task.performance.activeMs, 30)
  assert.equal(f.diagnostics.read('session', 'document', 1).task.performance.stages['native-render']!.bytes, 48)
})

test('performance scopes reject unowned work and freeze cancellation before late async completions', async () => {
  const f = fixture(); f.record({ event: 'started' })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  recordIndexPerformance({ stage: 'foreground', durationMs: 999 })
  const old = f.diagnostics.run('session', 'document', async () => {
    recordIndexPerformance({ stage: 'ocr', durationMs: 1, records: 1 })
    f.tick(10); await gate
    recordIndexPerformance({ stage: 'ocr', durationMs: 999, records: 99 })
  })
  f.record({ event: 'cancelled', reason: 'user' }); f.tick(2000)
  f.diagnostics.record({ ...base, occurrence: 2, event: 'started' })
  await f.diagnostics.run('session', 'document', async () => {
    await f.diagnostics.run('unowned', 'document', async () => {
      recordIndexPerformance({ stage: 'foreground', durationMs: 999 })
    })
    recordIndexPerformance({ stage: 'ocr', durationMs: 2, records: 1 })
    release(); await old
    f.tick(5)
  })
  assert.equal(f.diagnostics.read('session', 'document', 1).task.performance.activeMs, 10)
  assert.equal(f.diagnostics.read('session', 'document', 1).task.performance.stages.ocr!.totalMs, 1)
  const current = f.diagnostics.read('session', 'document', 2).task.performance
  assert.equal(current.activeMs, 5)
  assert.deepEqual(Object.keys(current.stages), ['ocr'])
  assert.equal(current.stages.ocr!.totalMs, 2)
})

test('metric summaries are bounded structural counters and cannot serialize private payloads', async () => {
  const f = fixture(); f.record({ event: 'started' })
  await f.diagnostics.run('session', 'document', async () => {
    recordIndexPerformance({ stage: '/private/file.pdf', durationMs: 1 })
    recordIndexPerformance({ stage: 'invalid-duration', durationMs: Number.NaN })
    recordIndexPerformance({ stage: 'constructor', durationMs: 1, bytes: -1, records: Infinity,
      requests: 1.5, cacheHit: true, message: 'Bearer secret-token; private PDF text' } as Parameters<typeof recordIndexPerformance>[0])
    for (let index = 0; index < 40; index++) recordIndexPerformance({ stage: `stage-${index}`, durationMs: 1, records: 1 })
    recordIndexPerformance({ stage: 'stage-0', durationMs: Number.MAX_VALUE, bytes: Number.MAX_SAFE_INTEGER })
    recordIndexPerformance({ stage: 'stage-0', durationMs: 5, bytes: 2 })
  })
  f.record({ event: 'failed', error: new Error('private failure') })
  const summary = f.diagnostics.read('session', 'document', 1).task.performance
  assert.equal(Object.keys(summary.stages).length, 32)
  const constructorStage: string = 'constructor'
  assert.equal(summary.stages[constructorStage]!.bytes, 0)
  assert.equal(summary.stages[constructorStage]!.cacheHits, 1)
  assert.equal(summary.stages['stage-0']!.bytes, Number.MAX_SAFE_INTEGER)
  assert.equal(summary.stages['stage-0']!.totalMs, Number.MAX_SAFE_INTEGER)
  for (const secret of ['private', 'Bearer', 'secret-token', 'file.pdf']) {
    assert.ok(!JSON.stringify(f.events).includes(secret))
  }
})

test('hostile error prototypes cannot execute or leak arbitrary failure detail', () => {
  const f = fixture(), error = new Proxy({}, { getPrototypeOf() { throw new Error('private prototype payload') } })
  f.record({ event: 'failed', error })
  assert.deepEqual(f.diagnostics.read('session', 'document', 1).task.failure?.causes, [{ name: 'Error' }])
  assert.ok(!JSON.stringify(f.events).includes('private prototype'))
})

test('alternating extraction and embedding phases or layers cannot flood progress logs', async () => {
  const f = fixture(); f.record({ event: 'started' })
  await f.diagnostics.run('session', 'document', async () => {
    for (let page = 1; page <= 1151; page++) {
      for (const layer of ['native', 'render', 'ocr', 'image', 'embedding'] as const) {
        f.diagnostics.activity('session', 'document', { page, layer, event: 'ready' })
      }
      for (const phase of ['extracting', 'embedding'] as const) f.record({ event: 'progress', progress: { ...progress, totalPages: 1151, phase, indexedPages: page } })
    }
    f.diagnostics.activity('session', 'document', { page: 1151, layer: 'ocr', event: 'failed', error: new Error('private') })
  })
  assert.equal(f.events.length, 4, 'start, first activity, first progress and immediate failure only')
  assert.equal(f.diagnostics.read('session', 'document', 1).task.progress?.indexedPages, 1151)
  assert.deepEqual(f.diagnostics.read('session', 'document', 1).task.currentActivity, { page: 1151, layer: 'ocr', event: 'failed' })
})
