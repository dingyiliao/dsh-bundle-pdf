import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'
import { createRetrievalStore, type RetrievalStoreMetric } from '../../../../src/layers/derived/storage/retrieval-store.ts'

const hash = (key: string) => createHash('sha256').update(key).digest('hex')
const envelope = (key: string, payload: unknown) => JSON.stringify({ version: 1, key, payload, checksum: hash(JSON.stringify(payload)) })
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pdf-sqlite-index-')), directory = join(root, 'indexes')
  const stores: ReturnType<typeof createRetrievalStore>[] = []
  t.after(async () => { await Promise.all(stores.map(store => store.dispose())); await rm(root, { recursive: true, force: true }) })
  return {
    root, directory, database: join(directory, 'records.sqlite'),
    store(options: Omit<Parameters<typeof createRetrievalStore>[0], 'directory'> = {}) {
      const store = createRetrievalStore({ directory, ...options }); stores.push(store); return store
    },
    sql(run: (db: DatabaseSync) => void) { const db = new DatabaseSync(join(directory, 'records.sqlite')); try { run(db) } finally { db.close() } },
  }
}

test('records survive bounded eviction and reopening, with isolated input/output and private database files', async t => {
  const f = await fixture(t), store = f.store({ maxMemoryBytes: 600 })
  const value = { text: 'Original OCR', spans: [[1, 2, 3, 4]] }, saved = store.set('page_1', value)
  value.text = 'Changed after admission'; await saved
  const copy = await store.get('page_1') as typeof value
  copy.text = 'Changed by consumer'; copy.spans[0]![0] = 99
  assert.deepEqual(await store.get('page_1'), { text: 'Original OCR', spans: [[1, 2, 3, 4]] })
  await store.set('vector_1', { vector: 'abc'.repeat(200) })
  assert.ok(store.diagnostics().memoryBytes <= 600)
  assert.equal(store.diagnostics().sqliteCacheBytes, 64 * 1024)
  await store.dispose()
  assert.equal(store.diagnostics().memoryBytes, 0)
  const reopened = f.store({ maxMemoryBytes: 0 })
  assert.deepEqual(await reopened.get('page_1'), { text: 'Original OCR', spans: [[1, 2, 3, 4]] })
  assert.deepEqual(await reopened.get('vector_1'), { vector: 'abc'.repeat(200) })
  assert.equal(reopened.diagnostics().entries, 0); assert.equal(reopened.diagnostics().diskReads, 2)
  assert.equal(reopened.diagnostics().backend, 'sqlite')
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.directory)).mode & 0o777, 0o700)
    for (const name of (await readdir(f.directory)).filter(name => name.startsWith('records.sqlite'))) {
      assert.equal((await stat(join(f.directory, name))).mode & 0o777, 0o600)
    }
  }
})

test('hot cache LRU avoids repeated integrity work, never owns the corpus and detects external commits', async t => {
  const f = await fixture(t), metrics: RetrievalStoreMetric[] = [], store = f.store({ maxMemoryBytes: 1100, onMetric: event => { metrics.push(event) } })
  await store.set('first', 'one'); await store.set('second', 'two'); await store.get('first')
  const before = store.diagnostics().cacheHits
  await store.set('third', 'three'); await store.get('first')
  assert.equal(store.diagnostics().cacheHits, before + 1)
  const reads = store.diagnostics().diskReads
  assert.equal(await store.get('second'), 'two'); assert.equal(store.diagnostics().diskReads, reads + 1)
  assert.equal(await store.get('missing'), undefined)
  const verifies = metrics.filter(event => event.stage === 'store-verify').length
  await store.get('second')
  assert.equal(metrics.filter(event => event.stage === 'store-verify').length, verifies, 'a validated immutable hot record is only parsed, not rehashed')
  f.sql(db => { const text = envelope('second', 'external update'); db.prepare('UPDATE records SET envelope=?, bytes=? WHERE id=?').run(text, Buffer.byteLength(text), hash('second')) })
  assert.equal(await store.get('second'), 'external update', 'another connection invalidates stale hot values')
  await store.dispose()
  const cold = f.store(); await cold.get('missing')
  assert.equal(cold.diagnostics().entries, 0, 'opening SQLite does not load its rows into the hot cache')
})

test('a batch commits once, freezes admitted values and resolves duplicate keys in order', async t => {
  const f = await fixture(t), store = f.store()
  await store.get('missing')
  const before = store.diagnostics().commits, value = { ready: 1 }
  const write = store.setMany([['first', value], ['second', [1, 2]], ['first', { ready: 2 }]])
  value.ready = 99; await write
  assert.equal(store.diagnostics().commits, before + 1)
  assert.deepEqual(await store.get('first'), { ready: 2 }); assert.deepEqual(await store.get('second'), [1, 2])
  f.sql(db => { assert.equal(db.prepare('SELECT count(*) AS count FROM records').get()!.count, 2) })
  await store.setMany([])
  assert.equal(store.diagnostics().commits, before + 1, 'an empty batch has no transaction')
})

test('conditional repair writes preserve newer checkpoints across independent stores and reopening', async t => {
  const f = await fixture(t), first = f.store(), second = f.store()
  const initial = { generation: 'same', reference: 'old' }, repaired = { generation: 'same', reference: 'fixed' }
  assert.equal(await first.compareAndSet('checkpoint', undefined, initial), true)
  assert.equal(await second.compareAndSet('checkpoint', undefined, repaired), false)
  assert.deepEqual(await second.get('checkpoint'), initial)
  const before = first.diagnostics().diskWrites
  await second.set('checkpoint', { generation: 'newer', reference: 'current' })
  assert.equal(await first.compareAndSet('checkpoint', initial, repaired), false)
  assert.equal(first.diagnostics().diskWrites, before, 'a stale comparison writes no records')
  assert.deepEqual(await first.get('checkpoint'), { generation: 'newer', reference: 'current' })
  assert.equal(await first.compareAndSet('missing', initial, repaired), false)
  await first.dispose(); await second.dispose()
  assert.deepEqual(await f.store().get('checkpoint'), { generation: 'newer', reference: 'current' })
})

test('competing repairs have one winner and cannot change completed OCR or vector records', async t => {
  const f = await fixture(t), first = f.store(), second = f.store()
  const original = { reference: 'old' }, ocr = { text: 'completed OCR', spans: [[1, 2, 3, 4]] }, vector = { data: 'completed vector' }
  await first.setMany([['checkpoint', original], ['ocr', ocr], ['vector', vector]])
  const changed = { reference: 'one' }
  const one = first.compareAndSet('checkpoint', original, changed)
  changed.reference = 'mutated after admission'
  const winners = await Promise.all([one, second.compareAndSet('checkpoint', original, { reference: 'two' })])
  assert.equal(winners.filter(Boolean).length, 1)
  assert.deepEqual(await first.get('checkpoint'), { reference: winners[0] ? 'one' : 'two' })
  assert.deepEqual(await second.get('ocr'), ocr); assert.deepEqual(await second.get('vector'), vector)
})

test('a rejected conditional repair rolls back and a corrupt checkpoint is never silently overwritten', async t => {
  const f = await fixture(t), store = f.store(), original = { reference: 'old' }
  await store.set('checkpoint', original)
  f.sql(db => { db.exec("CREATE TRIGGER refuse_repair BEFORE INSERT ON records WHEN NEW.key='checkpoint' BEGIN SELECT RAISE(ABORT,'repair refused'); END") })
  await assert.rejects(store.compareAndSet('checkpoint', original, { reference: 'fixed' }), { code: 'pdf/index-storage-write-failed' })
  assert.deepEqual(await store.get('checkpoint'), original)
  f.sql(db => {
    db.exec('DROP TRIGGER refuse_repair')
    const bad = JSON.stringify({ version: 1, key: 'checkpoint', payload: original, checksum: 'invalid' })
    db.prepare('UPDATE records SET envelope=?,bytes=? WHERE id=?').run(bad, Buffer.byteLength(bad), hash('checkpoint'))
  })
  await assert.rejects(store.compareAndSet('checkpoint', original, { reference: 'fixed' }), { code: 'pdf/index-storage-corrupt' })
  await assert.rejects(store.get('checkpoint'), { code: 'pdf/index-storage-corrupt' })
})

test('conditional repair rejects an externally changed row identity without overwriting it', async t => {
  const f = await fixture(t), store = f.store(), original = { generation: 1 }
  await store.set('checkpoint', original)
  f.sql(db => { db.prepare('UPDATE records SET key=? WHERE id=?').run('different-key', hash('checkpoint')) })

  await assert.rejects(store.compareAndSet('checkpoint', original, { generation: 2 }), { code: 'pdf/index-storage-corrupt' })
  f.sql(db => {
    const row = db.prepare('SELECT key, envelope FROM records WHERE id=?').get(hash('checkpoint'))!
    assert.equal(row.key, 'different-key')
    assert.equal(row.envelope, envelope('checkpoint', original))
  })
})

test('failed SQLite batch transactions roll back all records and never publish partial hot entries', async t => {
  const f = await fixture(t), store = f.store()
  await store.setMany([['first', 'previous'], ['second', 'previous']])
  f.sql(db => { db.exec("CREATE TRIGGER refuse_second BEFORE INSERT ON records WHEN NEW.key='second' BEGIN SELECT RAISE(ABORT,'private database failure'); END") })
  const before = store.diagnostics().commits
  await assert.rejects(store.setMany([['first', 'replacement'], ['second', 'secret payload']]), error => {
    assert.equal((error as { code: string }).code, 'pdf/index-storage-write-failed')
    assert.ok(!String(error).includes('private')); assert.ok(!String(error).includes('secret')); assert.ok(!String(error).includes(f.directory))
    return true
  })
  assert.equal(store.diagnostics().commits, before)
  assert.equal(await store.get('first'), 'previous'); assert.equal(await store.get('second'), 'previous')
  f.sql(db => { db.exec('DROP TRIGGER refuse_second') })
  await store.set('next', 'queue released'); assert.equal(await store.get('next'), 'queue released')
  await store.dispose()
  assert.equal(await f.store().get('first'), 'previous', 'rollback is durable after reopening')
})

test('durable transactions survive abrupt writer termination without dispose or a checkpoint', async t => {
  const f = await fixture(t)
  const script = `import { createRetrievalStore } from ${JSON.stringify(new URL('../../../../src/layers/derived/storage/retrieval-store.ts', import.meta.url).href)}; const s=createRetrievalStore({directory:${JSON.stringify(f.directory)}}); await s.setMany([['ocr',{text:'already computed'}],['vectors',[1,0,1]]]); process.kill(process.pid,'SIGKILL')`
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), encoding: 'utf8', timeout: 15_000 })
  assert.equal(child.error, undefined)
  if (process.platform === 'win32') assert.ok(child.status !== null && child.status !== 0, child.stderr)
  else assert.equal(child.signal, 'SIGKILL', child.stderr)
  assert.deepEqual(await f.store().get('ocr'), { text: 'already computed' })
  assert.deepEqual(await f.store().get('vectors'), [1, 0, 1])
})

test('admission order spans batches, reads, deletes and clear, and disposal drains accepted work', async t => {
  const f = await fixture(t), store = f.store()
  const one = store.setMany([['checkpoint', { done: 1 }], ['retired', true]])
  const two = store.set('checkpoint', { done: 2 }), snapshot = store.get('checkpoint')
  const remove = store.delete('retired'), absent = store.get('retired'), clear = store.clear()
  const final = store.set('checkpoint', { done: 3 }), disposal = store.dispose()
  assert.equal(store.dispose(), disposal)
  await Promise.all([one, two, remove, clear, final, disposal])
  assert.deepEqual(await snapshot, { done: 2 }); assert.equal(await absent, undefined)
  assert.deepEqual(await f.store().get('checkpoint'), { done: 3 })
  for (const call of [() => store.get('checkpoint'), () => store.has('checkpoint'), () => store.set('checkpoint', null), () => store.setMany([]), () => store.delete('checkpoint'), () => store.clear()]) {
    await assert.rejects(call(), { code: 'pdf/index-storage-closed' })
  }
})

test('invalid keys, non-JSON values, batch limits and oversized payloads are rejected before SQL admission', async t => {
  const f = await fixture(t)
  for (const options of [{ maxMemoryBytes: -1 }, { maxMemoryBytes: NaN }, { maxRecordBytes: 0 }, { maxRecordBytes: Infinity }]) {
    assert.throws(() => f.store(options), /Invalid PDF index storage limits/)
  }
  const store = f.store({ maxRecordBytes: 200 })
  for (const key of ['', '../private', 'x/y', 'x\\y', '\0', 'a'.repeat(513)]) {
    await assert.rejects(store.get(key), { code: 'pdf/index-storage-key' })
    await assert.rejects(store.has(key), { code: 'pdf/index-storage-key' })
    await assert.rejects(store.set(key, null), { code: 'pdf/index-storage-key' })
    await assert.rejects(store.delete(key), { code: 'pdf/index-storage-key' })
  }
  for (const value of [undefined, NaN, { token: () => 'secret' }, BigInt(1)]) {
    await assert.rejects(store.set('valid', value), error => {
      assert.equal((error as { code: string }).code, 'pdf/index-storage-invalid-record'); assert.ok(!String(error).includes('secret')); return true
    })
  }
  await assert.rejects(store.set('valid', 'secret'.repeat(100)), { code: 'pdf/index-storage-record-too-large' })
  await assert.rejects(store.setMany([['must_not_write', true], ['invalid', undefined]]), { code: 'pdf/index-storage-invalid-record' })
  assert.equal(await store.get('must_not_write'), undefined)
  await assert.rejects(store.setMany(Array.from({ length: 257 }, (_, i) => [`key${i}`, null] as const)), { code: 'pdf/index-storage-busy' })
})

test('corrupt JSON, checksums, row identities and byte lengths fail explicitly instead of becoming cache misses', async t => {
  const f = await fixture(t), initial = f.store()
  await initial.set('record', { result: 'success' }); await initial.dispose()
  const original = envelope('record', { result: 'success' })
  const variants = [
    ['broken JSON', 'record', 11], ['{}', 'record', 2],
    [original.replace('success', 'changed'), 'record', Buffer.byteLength(original)],
    [original.replace('"record"', '"other"'), 'record', Buffer.byteLength(original.replace('"record"', '"other"'))],
    [original, 'other', Buffer.byteLength(original)], [original, 'record', 1],
  ] as const
  for (const [text, key, bytes] of variants) {
    f.sql(db => { db.prepare('UPDATE records SET key=?,envelope=?,bytes=? WHERE id=?').run(key, text, bytes, hash('record')) })
    const store = f.store()
    await assert.rejects(store.get('record'), { code: 'pdf/index-storage-corrupt' }); await store.dispose()
  }
  f.sql(db => { db.prepare('UPDATE records SET key=?,envelope=?,bytes=? WHERE id=?').run('record', 'x'.repeat(1000), 1, hash('record')) })
  const limited = f.store({ maxRecordBytes: 200 })
  await assert.rejects(limited.get('record'), { code: 'pdf/index-storage-record-too-large' }, 'actual SQL length is checked even when the stored byte count lies')
})

test('damaged databases, unsupported versions and invalid schemas fail closed', async t => {
  const f = await fixture(t)
  await mkdir(f.directory); await writeFile(f.database, 'not a SQLite database')
  const broken = f.store(); await assert.rejects(broken.get('missing'), { code: 'pdf/index-storage-corrupt' }); await broken.dispose()
  await rm(f.database)
  f.sql(db => { db.exec('PRAGMA user_version=99') })
  const future = f.store(); await assert.rejects(future.get('missing'), { code: 'pdf/index-storage-corrupt' }); await future.dispose()
  f.sql(db => { db.exec('PRAGMA user_version=1; CREATE TABLE records(id TEXT PRIMARY KEY, wrong TEXT)') })
  const schema = f.store(); await assert.rejects(schema.get('missing'), { code: 'pdf/index-storage-corrupt' }); await schema.dispose()
  f.sql(db => { db.exec('DROP TABLE records; PRAGMA user_version=0') })
  const valid = f.store(); await valid.get('missing'); await valid.dispose()
})

test('preset root and database sidecar symlinks never redirect or chmod unrelated files', async t => {
  if (process.platform === 'win32') { t.skip('symlink creation requires extra Windows privileges'); return }
  const f = await fixture(t), outside = join(f.root, 'outside'), target = join(f.root, 'preserve')
  await mkdir(outside); await writeFile(target, 'preserve', { mode: 0o644 })
  await symlink(outside, f.directory, 'dir')
  const root = f.store()
  for (const call of [() => root.get('record'), () => root.set('record', true), () => root.delete('record'), () => root.clear()]) {
    await assert.rejects(call(), { code: 'pdf/index-storage-unsafe' })
  }
  await root.dispose(); await rm(f.directory); await mkdir(f.directory)
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    await symlink(target, f.database + suffix)
    const store = f.store(); await assert.rejects(store.get('record'), { code: 'pdf/index-storage-unsafe' }); await store.dispose()
    await rm(f.database + suffix)
    assert.equal(await readFile(target, 'utf8'), 'preserve'); assert.equal((await stat(target)).mode & 0o777, 0o644)
  }
})

test('actual SQLite delete failure preserves the record, reports safely and releases the queue', async t => {
  const f = await fixture(t), store = f.store()
  await store.set('retired', 'private payload')
  f.sql(db => { db.exec("CREATE TRIGGER refuse_delete BEFORE DELETE ON records BEGIN SELECT RAISE(ABORT,'private deletion error'); END") })
  await assert.rejects(store.delete('retired'), error => {
    assert.equal((error as { code: string }).code, 'pdf/index-storage-delete-failed')
    assert.ok(!String(error).includes('private')); assert.ok(!String(error).includes(f.directory)); return true
  })
  assert.equal(await store.get('retired'), 'private payload')
  f.sql(db => { db.exec('DROP TRIGGER refuse_delete') })
  await store.delete('retired'); await store.delete('retired')
  assert.equal(await store.get('retired'), undefined)
  await store.set('next', true); assert.equal(await store.get('next'), true)
})

test('pending call and payload budgets bound memory without dropping admitted transactions', async t => {
  const f = await fixture(t), store = f.store()
  const results = await Promise.allSettled(Array.from({ length: 257 }, () => store.get('missing')))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 256)
  assert.equal((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code, 'pdf/index-storage-busy')
  await store.dispose()
  const small = f.store({ maxMemoryBytes: 0, maxRecordBytes: 512 })
  const first = small.set('first', 'a'.repeat(200)), second = small.set('second', 'b'.repeat(200))
  await assert.rejects(second, { code: 'pdf/index-storage-busy' }); await first
  assert.equal(await small.get('first'), 'a'.repeat(200)); assert.equal(await small.get('second'), undefined)
  await assert.rejects(small.setMany([['oversubscribed', 'a'.repeat(200)], ['oversubscribed2', 'b'.repeat(200)]]), { code: 'pdf/index-storage-busy' })
})

test('passive metrics report real work and cannot make successful IO fail', async t => {
  const f = await fixture(t), events: RetrievalStoreMetric[] = []
  let calls = 0
  const store = f.store({ onMetric: event => {
    events.push(event); if (++calls % 2) throw new Error('observer failure')
    return Promise.reject(new Error('async observer failure')) as unknown as void
  } })
  await store.setMany([['first', 1], ['second', 2]]); await store.dispose()
  const cold = f.store({ onMetric: event => { events.push(event) } })
  assert.equal(await cold.get('first'), 1); assert.equal(await cold.get('first'), 1)
  assert.ok(events.some(event => event.stage === 'store-write' && event.records === 2))
  assert.ok(events.some(event => event.stage === 'store-serialize')); assert.ok(events.some(event => event.stage === 'store-verify'))
  assert.ok(events.some(event => event.stage === 'store-read' && event.cacheHit === false)); assert.ok(events.some(event => event.stage === 'store-read' && event.cacheHit === true))
  assert.ok(events.every(event => Number.isFinite(event.durationMs) && event.durationMs >= 0))
})

test('presence checks read only row metadata, retain lifecycle fences and leave full content validation to get', async t => {
  const f = await fixture(t), events: RetrievalStoreMetric[] = [], store = f.store({ onMetric: event => { events.push(event) } })
  assert.equal(await store.has('missing'), false)
  await store.set('geometry', { text: 'large geometry', spans: new Array(1000).fill([1, 2, 3, 4]) })
  events.length = 0
  assert.equal(await store.has('geometry'), true)
  assert.equal(events.some(event => event.stage === 'store-verify'), false)
  assert.equal(events[0]!.bytes, 0, 'has does not materialize the envelope into JS')
  f.sql(db => { db.prepare('UPDATE records SET envelope=?,bytes=? WHERE id=?').run('broken', 6, hash('geometry')) })
  assert.equal(await store.has('geometry'), true, 'existence does not claim content integrity')
  await assert.rejects(store.get('geometry'), { code: 'pdf/index-storage-corrupt' })
  f.sql(db => { db.prepare('UPDATE records SET key=? WHERE id=?').run('different', hash('geometry')) })
  await assert.rejects(store.has('geometry'), { code: 'pdf/index-storage-corrupt' })
  f.sql(db => { db.prepare('UPDATE records SET key=?,bytes=? WHERE id=?').run('geometry', 0, hash('geometry')) })
  await assert.rejects(store.has('geometry'), { code: 'pdf/index-storage-corrupt' })
  f.sql(db => { db.prepare('UPDATE records SET bytes=? WHERE id=?').run(20 * 1024 * 1024, hash('geometry')) })
  await assert.rejects(store.has('geometry'), { code: 'pdf/index-storage-record-too-large' })
  await store.delete('geometry'); assert.equal(await store.has('geometry'), false)
})

test('a long sequence of hot reads yields the Host event loop without weakening operation ordering', async t => {
  const f = await fixture(t), store = f.store()
  const text = 'cached text'.repeat(10_000)
  await store.set('large', text)
  let interactiveTurn = false
  const turn = new Promise<void>(resolve => setImmediate(() => { interactiveTurn = true; resolve() }))
  for (let index = 0; index < 1000; index++) assert.equal(await store.get('large'), text)
  assert.equal(interactiveTurn, true, 'queued cache/SQL work must not monopolize one uninterrupted Host microtask turn')
  await turn
})
