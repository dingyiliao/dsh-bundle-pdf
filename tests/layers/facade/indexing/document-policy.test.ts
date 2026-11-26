import assert from 'node:assert/strict'
import { posix } from 'node:path'
import test from 'node:test'
import { createDocumentIndexPolicies, indexPolicy, resolveRetrievalBinding, settingsForRetrievalBinding, documentIndexRecordSchema } from '../../../../src/layers/facade/indexing/document-policy.ts'
import { defaultSettings, type PdfSettings } from '../../../../src/shared/contracts.ts'

const turn = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
type Store = Parameters<typeof createDocumentIndexPolicies>[0]
function fixture(data = new Map<string, unknown>()) {
  let defaults: PdfSettings = { ...defaultSettings, embeddingEngine: 'embed-a', ocrEngine: 'ocr-a', imageEngine: 'image-a',
    indexScanPages: true, indexImageDescriptions: false, engineConfigurations: {
      embedding: { 'embed-a': { model: 'alpha' }, 'embed-b': { model: 'beta' }, unrelated: { model: 'unused' } },
      ocr: { 'ocr-a': { language: 'auto' } }, image: { 'image-a': { model: 'visual' } },
    } }
  const state = { reads: 0, writes: [] as Array<{ key: string; record: unknown }>,
    onPut: undefined as ((key: string, record: Parameters<Store['put']>[1]) => Promise<void> | void) | undefined }
  const store: Store = { key: path => posix.normalize(path), get: key => { state.reads++; return structuredClone(data.get(key)) },
    async put(key, record) {
      await state.onPut?.(key, record)
      state.writes.push({ key, record: structuredClone(record) }); data.set(key, structuredClone(record))
    } }
  const create = () => createDocumentIndexPolicies(store, () => defaults)
  return { api: create(), create, state, data, defaults: () => defaults,
    updateDefaults(change: Partial<PdfSettings>) { defaults = { ...defaults, ...change } } }
}

test('plan resolution captures only enabled selected bindings and defensively copies configuration', () => {
  const f = fixture()
  const policy = indexPolicy(f.defaults()), plan = resolveRetrievalBinding(policy, f.defaults())
  assert.deepEqual(Object.keys(plan.configurations).sort(), ['embedding', 'ocr'])
  assert.deepEqual(plan.configurations.embedding, { 'embed-a': { model: 'alpha' } })
  Object.assign(f.defaults().engineConfigurations!.embedding!['embed-a']!, { model: 'mutated' })
  assert.equal(plan.configurations.embedding!['embed-a']!.model, 'alpha')
  const enabled = resolveRetrievalBinding({ ...policy, indexScanPages: false, indexImageDescriptions: true }, f.defaults())
  assert.deepEqual(Object.keys(enabled.configurations).sort(), ['embedding', 'image'])
  const disabled = resolveRetrievalBinding({ ...policy, indexScanPages: false }, { ...f.defaults(), embeddingEngine: 'none' })
  assert.deepEqual(disabled.configurations, {})
  const runtimeSettings = settingsForRetrievalBinding(plan)
  assert.equal(runtimeSettings.translationEngine, defaultSettings.translationEngine)
  Object.assign(runtimeSettings.engineConfigurations!.embedding!['embed-a']!, { model: 'another mutation' })
  assert.equal(plan.configurations.embedding!['embed-a']!.model, 'alpha')
  const fallback = indexPolicy({ indexScanPages: undefined, indexImageDescriptions: undefined })
  assert.deepEqual(fallback, { indexScanPages: true, indexImageDescriptions: false })
  assert.equal(resolveRetrievalBinding(fallback, { ...defaultSettings, embeddingEngine: undefined }).policy.embeddingEngine, 'none')
  assert.deepEqual(resolveRetrievalBinding({ ...fallback, indexScanPages: false }, defaultSettings).configurations, {})
})

test('document preferences persist only content flags and current engine settings resolve at use time', async () => {
  const f = fixture(), path = '/books/shared.pdf'
  try {
    const original = f.api.snapshot(path, 'first')
    assert.deepEqual(original.policy, { indexScanPages: true, indexImageDescriptions: false })
    f.updateDefaults({ embeddingEngine: 'embed-b', engineConfigurations: {
      embedding: { 'embed-b': { model: 'beta' } } } })
    assert.equal(f.api.current(path).policy.embeddingEngine, 'embed-b')
    assert.deepEqual(f.api.current(path).configurations.embedding, { 'embed-b': { model: 'beta' } })
    const policy = { indexScanPages: false, indexImageDescriptions: true }
    await f.api.configure(path, original.revision, policy)
    assert.deepEqual(f.data.get(path), { version: 3, revision: 1, policy })
    await f.api.dispose()
    const reopened = f.create()
    try { assert.deepEqual(reopened.snapshot(path, 'next').policy, policy) }
    finally { await reopened.dispose() }
  } finally { await f.api.dispose() }
})

test('old plan records are ignored and a new policy is written on explicit configuration', async () => {
  const path = '/old.pdf', f = fixture(new Map([[path, { version: 2, revision: 9,
    desired: { indexScanPages: false, indexImageDescriptions: true }, active: { policy: {}, configurations: {} } }]]))
  try {
    assert.equal(f.api.snapshot(path, 'doc').revision, 0)
    assert.equal(f.api.current(path).policy.embeddingEngine, 'embed-a')
    await f.api.configure(path, 0, { indexScanPages: false, indexImageDescriptions: true })
    assert.deepEqual(f.data.get(path), { version: 3, revision: 1,
      policy: { indexScanPages: false, indexImageDescriptions: true } })
  } finally { await f.api.dispose() }
})

test('concurrent edits use the document revision and saved policy remains after a failed write', async () => {
  const f = fixture(), path = '/book.pdf'
  try {
    const first = { indexScanPages: false, indexImageDescriptions: false }
    await f.api.configure(path, 0, first)
    await assert.rejects(f.api.configure(path, 0, { ...first, indexImageDescriptions: true }),
      { code: 'pdf/index-settings-stale' })
    f.state.onPut = () => { throw new Error('disk failure') }
    await assert.rejects(f.api.configure(path, 1, { ...first, indexImageDescriptions: true }), /disk failure/)
    assert.deepEqual(f.api.snapshot(path, 'doc').policy, first)
    f.state.onPut = undefined
    await f.api.configure(path, 1, { ...first, indexImageDescriptions: true })
    assert.equal(f.api.snapshot(path, 'doc').revision, 2)
  } finally { await f.api.dispose() }
})

test('failed durable writes keep accepted preferences and active queries intact, and a later retry can succeed', async () => {
  const f = fixture(), path = '/a.pdf'
  try {
    const initial = f.api.snapshot(path, 'a'); await f.api.settled(path)
    const next = { ...initial.policy, indexImageDescriptions: true }
    f.state.onPut = () => { throw new Error('disk full') }
    await assert.rejects(f.api.configure(path, 0, next), /disk full/)
    assert.deepEqual(f.api.snapshot(path, 'a').policy, initial.policy)
    assert.equal(f.api.snapshot(path, 'a').revision, 0)
    f.state.onPut = undefined
    await f.api.configure(path, 0, next)
    assert.deepEqual(f.api.snapshot(path, 'a').policy, next)
    assert.deepEqual(indexPolicy(f.api.current(path).policy), next)
  } finally { await f.api.dispose() }
})


test('observers cannot break persistence, unsubscribe is effective and disposal drains admitted storage', async () => {
  const f = fixture(), path = '/a.pdf', entered = deferred(), gate = deferred()
  f.api.snapshot(path, 'a'); await f.api.settled(path)
  let events = 0
  f.api.subscribe(() => { throw new Error('a passive observer failed') })
  const stop = f.api.subscribe(() => { events++ })
  f.state.onPut = async () => { entered.resolve(); await gate.promise }
  const save = f.api.configure(path, 0, { ...f.api.snapshot(path, 'a').policy, indexImageDescriptions: true })
  await entered.promise
  const closing = f.api.dispose()
  assert.equal(f.api.dispose(), closing)
  let finished = false
  void closing.then(() => { finished = true })
  await turn(); assert.equal(finished, false)
  assert.throws(() => f.api.snapshot(path, 'a'), /closed/)
  stop(); gate.resolve(); await Promise.all([save, closing])
  assert.equal(events, 0, 'closing detaches observers while keeping admitted writes durable')
  assert.equal(documentIndexRecordSchema.parse(f.data.get(path)).policy.indexImageDescriptions, true)
})


test('successful preference writes notify live observers even when another observer throws', async () => {
  const f = fixture(), path = '/a.pdf'
  let notifications = 0
  f.api.subscribe(() => { throw new Error('observer failed') })
  const stop = f.api.subscribe(() => { notifications++ })
  try {
    const initial = f.api.snapshot(path, 'a'); await f.api.settled(path)
    await f.api.configure(path, 0, { ...initial.policy, indexImageDescriptions: true })
    assert.equal(notifications, 1)
    stop()
    await f.api.configure(path, 1, initial.policy)
    assert.equal(notifications, 1)
  } finally { await f.api.dispose() }
})


test('releasing unused preferences evicts only the in-memory copy and preserves durable settings on reopen', async () => {
  const f = fixture(), path = '/closed.pdf'
  try {
    const initial = f.api.snapshot(path, 'a'); await f.api.settled(path)
    await f.api.configure(path, 0, { ...initial.policy, indexImageDescriptions: true })
    f.api.releaseUnused(new Set(['/./closed.pdf'])); await turn()
    f.api.snapshot(path, 'a'); assert.equal(f.state.reads, 1, 'a canonical path with an owner stays resident')
    f.api.releaseUnused(new Set()); await turn()
    assert.equal(f.data.size, 1, 'closing never removes the durable preference record')
    f.updateDefaults({ embeddingEngine: 'embed-b' })
    const reopened = f.api.snapshot(path, 'new-document')
    assert.equal(f.state.reads, 2, 'a fully closed resource is reloaded from the durable store')
    assert.equal(f.api.current(path).policy.embeddingEngine, 'embed-b')
    assert.equal(reopened.policy.indexImageDescriptions, true)
  } finally { await f.api.dispose() }
})


test('a pending write is not evicted early and touching the resource before it settles cancels release', async () => {
  const f = fixture(), path = '/writing.pdf', entered = deferred(), gate = deferred()
  try {
    const initial = f.api.snapshot(path, 'a'); await f.api.settled(path)
    f.state.onPut = async () => { entered.resolve(); await gate.promise }
    const saving = f.api.configure(path, 0, { ...initial.policy, indexImageDescriptions: true })
    await entered.promise
    f.api.releaseUnused(new Set()); await turn()
    const reopened = f.api.snapshot(path, 'reopened-before-commit')
    assert.equal(reopened.revision, 0)
    assert.equal(f.state.reads, 1, 'the active write keeps the old entry alive')
    gate.resolve(); await saving; await turn()
    assert.equal(f.api.snapshot(path, 'a').revision, 1)
    assert.equal(f.state.reads, 1, 'reopening retained the entry across the queued release callback')
  } finally { gate.resolve(); await f.api.dispose() }
})


test('release callbacks for an older pending write cannot evict a newer admitted write', async () => {
  const f = fixture(), path = '/queued.pdf', first = deferred(), second = deferred(), firstGate = deferred(), secondGate = deferred()
  let writes = 0
  try {
    const initial = f.api.snapshot(path, 'a'); await f.api.settled(path)
    f.state.onPut = async () => {
      if (++writes === 1) { first.resolve(); await firstGate.promise }
      else { second.resolve(); await secondGate.promise }
    }
    const one = f.api.configure(path, 0, { ...initial.policy, indexImageDescriptions: true })
    await first.promise
    f.api.releaseUnused(new Set())
    const two = f.api.configure(path, 1, { ...initial.policy, indexScanPages: false })
    f.api.releaseUnused(new Set())
    firstGate.resolve(); await one; await second.promise; await turn()
    assert.equal(f.api.snapshot(path, 'still-writing').revision, 1)
    assert.equal(f.state.reads, 1)
    f.api.releaseUnused(new Set())
    secondGate.resolve(); await two; await turn()
    assert.equal(f.api.snapshot(path, 'after-close').policy.indexScanPages, false)
    assert.equal(f.state.reads, 2, 'the final entry is evicted only after its newest commit')
  } finally { firstGate.resolve(); secondGate.resolve(); await f.api.dispose() }
})
