import assert from 'node:assert/strict'
import { posix } from 'node:path'
import test from 'node:test'
import { createDocumentIndexPolicies, indexPolicy, resolveIndexPlan, settingsForIndexPlan,
  documentIndexRecordSchema } from '../../../src/modules/retrieval/document-policy.ts'
import { defaultSettings, type PdfSettings } from '../../../src/shared/contracts.ts'

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
  const policy = indexPolicy(f.defaults()), plan = resolveIndexPlan(policy, f.defaults())
  assert.deepEqual(Object.keys(plan.configurations).sort(), ['embedding', 'ocr'])
  assert.deepEqual(plan.configurations.embedding, { 'embed-a': { model: 'alpha' } })
  Object.assign(f.defaults().engineConfigurations!.embedding!['embed-a']!, { model: 'mutated' })
  assert.equal(plan.configurations.embedding!['embed-a']!.model, 'alpha')
  const enabled = resolveIndexPlan({ ...policy, indexScanPages: false, indexImageDescriptions: true }, f.defaults())
  assert.deepEqual(Object.keys(enabled.configurations).sort(), ['embedding', 'image'])
  const disabled = resolveIndexPlan({ ...policy, indexScanPages: false }, { ...f.defaults(), embeddingEngine: 'none' })
  assert.deepEqual(disabled.configurations, {})
  const runtimeSettings = settingsForIndexPlan(plan)
  assert.equal(runtimeSettings.translationEngine, defaultSettings.translationEngine)
  Object.assign(runtimeSettings.engineConfigurations!.embedding!['embed-a']!, { model: 'another mutation' })
  assert.equal(plan.configurations.embedding!['embed-a']!.model, 'alpha')
  const fallback = indexPolicy({ indexScanPages: undefined, indexImageDescriptions: undefined })
  assert.deepEqual(fallback, { indexScanPages: true, indexImageDescriptions: false })
  assert.equal(resolveIndexPlan(fallback, { ...defaultSettings, embeddingEngine: undefined }).policy.embeddingEngine, 'none')
  assert.deepEqual(resolveIndexPlan({ ...fallback, indexScanPages: false }, defaultSettings).configurations, {})
})

test('one canonical resource retains defaults and policy across sessions, saves and service recreation', async () => {
  const f = fixture(), path = '/books/shared.pdf'
  try {
    const first = f.api.snapshot(path, 'document-in-session-a')
    assert.equal(first.pending, false); assert.equal(first.impact, 'none')
    await f.api.settled(path)
    f.updateDefaults({ embeddingEngine: 'embed-b', indexScanPages: false, indexImageDescriptions: true })
    const same = f.api.snapshot('/books/./shared.pdf', 'document-in-session-b')
    assert.deepEqual(same.policy, first.policy, 'later defaults never overwrite an existing PDF policy')
    assert.equal(same.documentId, 'document-in-session-b')
    const changed = { ...first.policy, indexImageDescriptions: true }
    await f.api.configure(path, first.revision, changed)
    const afterSave = f.api.snapshot(path, 'replacement-working-copy-after-save')
    assert.deepEqual(afterSave.policy, changed, 'neither working-copy IDs nor a new source digest is the preference key')
    assert.deepEqual(afterSave.activePolicy, first.policy)
    assert.equal(afterSave.pending, true); assert.equal(afterSave.impact, 'embedding')
    await f.api.dispose()
    const restored = f.create()
    try {
      assert.deepEqual(restored.snapshot(path, 'reopened').policy, changed)
      assert.deepEqual(indexPolicy(restored.active(path).policy), first.policy)
      assert.equal(restored.active(path).policy.embeddingEngine, 'embed-a')
      assert.equal(f.state.writes.length, 2, 'reading a saved policy does not rewrite it')
      assert.equal(restored.desired('/books/new.pdf').policy.embeddingEngine, 'embed-b')
      await restored.settled('/books/new.pdf')
    } finally { await restored.dispose() }
  } finally { await f.api.dispose() }
})

test('desired and active plans stay separate until activation and changes have actionable impact', async () => {
  const f = fixture(), path = '/a.pdf'
  try {
    const initial = f.api.snapshot(path, 'a')
    await f.api.settled(path)
    f.updateDefaults({ embeddingEngine: 'embed-b' })
    const next = { ...initial.policy, indexImageDescriptions: true }
    await f.api.configure(path, 0, next)
    assert.equal(f.api.snapshot(path, 'a').impact, 'embedding')
    assert.equal(f.api.active(path).policy.embeddingEngine, 'embed-a')
    const pending = f.api.desired(path)
    const copied = f.api.active(path)
    copied.policy.embeddingEngine = 'do-not-mutate-host'
    assert.equal(f.api.active(path).policy.embeddingEngine, 'embed-a')
    await f.api.activate(path, pending)
    assert.equal(f.api.snapshot(path, 'a').revision, 2)
    assert.equal(f.api.snapshot(path, 'a').pending, false)
    await f.api.activate(path, pending)
    assert.equal(f.api.snapshot(path, 'a').revision, 2, 'promoting the same ready plan is idempotent')
    f.updateDefaults({ engineConfigurations: { ...f.defaults().engineConfigurations,
      embedding: { 'embed-b': { model: 'updated-beta' } } } })
    assert.equal(f.api.snapshot(path, 'a').impact, 'configuration')
    assert.equal(f.api.active(path).configurations.embedding!['embed-b']!.model, 'beta')
    assert.equal(f.api.desired(path).configurations.embedding!['embed-b']!.model, 'updated-beta')
  } finally { await f.api.dispose() }
})

test('configuration edits to unrelated or disabled engines do not mark a ready plan stale', async () => {
  const f = fixture(), path = '/a.pdf'
  try {
    f.api.snapshot(path, 'a'); await f.api.settled(path)
    f.updateDefaults({ engineConfigurations: { ...f.defaults().engineConfigurations,
      image: { 'image-a': { model: 'changed but disabled' } },
      embedding: { ...f.defaults().engineConfigurations!.embedding, unrelated: { model: 'another unused model' } },
    } })
    assert.equal(f.api.snapshot(path, 'a').pending, false)
  } finally { await f.api.dispose() }
})

test('CAS prevents concurrent preference overwrites and a superseded build cannot activate', async () => {
  const f = fixture(), path = '/a.pdf'
  try {
    const initial = f.api.snapshot(path, 'a'); await f.api.settled(path)
    const oldBuild = f.api.desired(path)
    const results = await Promise.allSettled([
      f.api.configure(path, initial.revision, { ...initial.policy, indexImageDescriptions: true }),
      f.api.configure(path, initial.revision, { ...initial.policy, indexScanPages: false }),
    ])
    assert.equal(results[0]!.status, 'fulfilled')
    assert.equal(results[1]!.status, 'rejected')
    if (results[1]!.status === 'rejected') assert.equal(results[1].reason.code, 'pdf/index-settings-stale')
    assert.equal(f.api.snapshot(path, 'b').revision, 1)
    await assert.rejects(f.api.activate(path, oldBuild), { code: 'pdf/index-settings-stale' })
    assert.equal(f.api.active(path).policy.indexImageDescriptions, false)
    await f.api.configure(path, 1, f.api.snapshot(path, 'a').policy)
    assert.equal(f.api.snapshot(path, 'a').revision, 1, 'a no-op update does not consume a revision')
  } finally { await f.api.dispose() }
})

test('restoring current defaults is explicit and still leaves a changed index pending', async () => {
  const f = fixture(), path = '/a.pdf'
  try {
    f.api.snapshot(path, 'a'); await f.api.settled(path)
    f.updateDefaults({ embeddingEngine: 'embed-b', indexScanPages: false })
    await f.api.defaults(path, 0)
    const snapshot = f.api.snapshot(path, 'a')
    assert.equal(snapshot.policy.indexScanPages, false)
    assert.equal(f.api.desired(path).policy.embeddingEngine, 'embed-b')
    assert.equal(f.api.active(path).policy.embeddingEngine, 'embed-a')
    assert.equal(snapshot.pending, true)
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
    assert.deepEqual(indexPolicy(f.api.active(path).policy), initial.policy)
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
  assert.equal(documentIndexRecordSchema.parse(f.data.get(path)).desired.indexImageDescriptions, true)
})

test('malformed stored policies fail explicitly instead of silently overwriting saved preferences', async () => {
  const f = fixture(new Map([['/broken.pdf', { revision: -1 }]]))
  try {
    assert.throws(() => f.api.snapshot('/broken.pdf', 'a'))
    assert.equal(f.state.writes.length, 0)
  } finally { await f.api.dispose() }
})

test('concurrent explicit requests share one retry after an initial durable-store failure', async () => {
  const f = fixture(), entered = deferred(), gate = deferred(), path = '/retry.pdf'
  let attempts = 0
  f.state.onPut = async () => {
    if (++attempts === 1) throw new Error('temporary initial write failure')
    entered.resolve(); await gate.promise
  }
  try {
    f.api.snapshot(path, 'a')
    const first = f.api.settled(path), second = f.api.settled(path)
    await entered.promise
    assert.equal(attempts, 2, 'one failed creation plus exactly one shared retry')
    gate.resolve(); await Promise.all([first, second])
    assert.equal(documentIndexRecordSchema.parse(f.data.get(path)).revision, 0)
  } finally { gate.resolve(); await f.api.dispose() }
})

test('closing after a failed initial write does not admit another retry', async () => {
  const f = fixture(), entered = deferred(), gate = deferred(), path = '/close-failed.pdf'
  let attempts = 0
  f.state.onPut = async () => { attempts++; entered.resolve(); await gate.promise; throw new Error('initial write failed') }
  f.api.snapshot(path, 'a')
  const settled = f.api.settled(path), failed = assert.rejects(settled, /initial write failed/)
  await entered.promise
  const closing = f.api.dispose()
  gate.resolve(); await Promise.all([failed, closing])
  assert.equal(attempts, 1)
  assert.equal(f.data.size, 0)
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
    assert.equal(f.api.desired(path).policy.embeddingEngine, 'embed-b')
    assert.equal(f.api.active(path).policy.embeddingEngine, 'embed-a')
    assert.equal(reopened.policy.indexImageDescriptions, true)
    assert.equal(reopened.pending, true)
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


test('legacy document engine overrides are removed once while frozen ready plans and content flags survive migration', async () => {
  const seed = fixture(), path = '/legacy.pdf'
  const active = resolveIndexPlan({ indexScanPages: true, indexImageDescriptions: false }, seed.defaults())
  const legacy = { revision: 7, desired: { ...active.policy, embeddingEngine: 'document-only-embedding',
    ocrEngine: 'document-only-ocr', imageEngine: 'document-only-image', indexScanPages: false, indexImageDescriptions: true }, active }
  const f = fixture(new Map([[path, legacy]]))
  try {
    const status = f.api.snapshot(path, 'migrated')
    assert.deepEqual(status.policy, { indexScanPages: false, indexImageDescriptions: true })
    assert.deepEqual(status.activePolicy, { indexScanPages: true, indexImageDescriptions: false })
    assert.equal(status.revision, 7)
    assert.equal(status.enabled, true); assert.equal(status.activeEnabled, true)
    assert.equal(JSON.stringify(status).includes('Engine'), false, 'the public response never leaks frozen engine selectors')
    assert.equal(f.api.desired(path).policy.embeddingEngine, 'embed-a')
    assert.equal(f.api.desired(path).policy.ocrEngine, 'ocr-a')
    assert.equal(f.api.desired(path).policy.imageEngine, 'image-a')
    assert.deepEqual(f.api.active(path), active)
    await f.api.settled(path)
    const stored = f.data.get(path) as { version: number; desired: unknown; active: unknown }
    assert.equal(stored.version, 2); assert.deepEqual(stored.desired, status.policy); assert.deepEqual(stored.active, active)
    assert.equal(f.state.writes.length, 1)
    await f.api.dispose()
    const reopened = f.create()
    try { reopened.snapshot(path, 'another-session'); await reopened.settled(path) }
    finally { await reopened.dispose() }
    assert.equal(f.state.writes.length, 1, 'new-format reads do not rewrite migrated records')
  } finally { await seed.api.dispose(); await f.api.dispose() }
})

test('global disable is reversible and never rewrites or loses the ready engine configuration', async () => {
  const f = fixture(), path = '/ready.pdf'
  try {
    f.api.snapshot(path, 'ready'); await f.api.settled(path)
    const accepted = f.api.active(path), writes = f.state.writes.length
    f.updateDefaults({ embeddingEngine: 'none' })
    const disabled = f.api.snapshot(path, 'disabled')
    assert.equal(disabled.enabled, false); assert.equal(disabled.activeEnabled, false)
    assert.equal(f.api.active(path).policy.embeddingEngine, 'none')
    assert.deepEqual((f.data.get(path) as { active: unknown }).active, accepted)
    assert.equal(f.state.writes.length, writes)
    f.updateDefaults({ embeddingEngine: 'embed-a' })
    assert.equal(f.api.snapshot(path, 'restored').pending, false)
    assert.deepEqual(f.api.active(path), accepted)
  } finally { await f.api.dispose() }
})

test('document configuration rejects engine selectors instead of retaining a hidden per-file override', async () => {
  const f = fixture(), path = '/selectors.pdf'
  try {
    const initial = f.api.snapshot(path, 'a'); await f.api.settled(path)
    assert.throws(() => f.api.configure(path, initial.revision,
      { ...initial.policy, embeddingEngine: 'forbidden' } as typeof initial.policy), /Unrecognized key/)
    assert.deepEqual(f.api.snapshot(path, 'a').policy, initial.policy)
    assert.equal(f.api.desired(path).policy.embeddingEngine, 'embed-a')
  } finally { await f.api.dispose() }
})
