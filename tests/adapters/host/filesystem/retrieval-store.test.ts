import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, mkdir, open, readFile, readdir, rm, stat, symlink, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'
import { createRetrievalStore, type RetrievalStoreMetric } from '../../../../src/adapters/host/filesystem/retrieval-store.ts'

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
    record(key: string) { const id = hash(key); return join(directory, id.slice(0, 2), `${id}.json`) },
    async legacy(key: string, value: unknown) {
      const id = hash(key), bucket = join(directory, id.slice(0, 2)); await mkdir(bucket, { recursive: true })
      const path = join(bucket, `${id}.json`); await writeFile(path, envelope(key, value), { mode: 0o600 }); return path
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
  const script = `import { createRetrievalStore } from ${JSON.stringify(new URL('../../../../src/adapters/host/filesystem/retrieval-store.ts', import.meta.url).href)}; const s=createRetrievalStore({directory:${JSON.stringify(f.directory)}}); await s.setMany([['ocr',{text:'already computed'}],['vectors',[1,0,1]]]); process.kill(process.pid,'SIGKILL')`
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

test('damaged databases, unsupported versions, invalid schemas and malformed migration metadata fail closed', async t => {
  const f = await fixture(t)
  await mkdir(f.directory); await writeFile(f.database, 'not a SQLite database')
  const broken = f.store(); await assert.rejects(broken.get('missing'), { code: 'pdf/index-storage-corrupt' }); await broken.dispose()
  await rm(f.database)
  f.sql(db => { db.exec('PRAGMA user_version=99') })
  const future = f.store(); await assert.rejects(future.get('missing'), { code: 'pdf/index-storage-corrupt' }); await future.dispose()
  f.sql(db => { db.exec('PRAGMA user_version=1; CREATE TABLE records(id TEXT PRIMARY KEY, wrong TEXT)') })
  const schema = f.store(); await assert.rejects(schema.get('missing'), { code: 'pdf/index-storage-corrupt' }); await schema.dispose()
  f.sql(db => { db.exec('DROP TABLE records; DROP TABLE meta; PRAGMA user_version=0') })
  const valid = f.store(); await valid.get('missing'); await valid.dispose()
  f.sql(db => { db.exec("UPDATE meta SET value='not complete' WHERE name='file-v1-imported'") })
  const metadata = f.store(); await assert.rejects(metadata.get('missing'), { code: 'pdf/index-storage-corrupt' })
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

test('clear removes owned legacy records, symlinks and temporary files while preserving unrelated files', async t => {
  const f = await fixture(t), store = f.store(), path = await f.legacy('owned', true), bucket = join(f.directory, hash('owned').slice(0, 2))
  await writeFile(join(bucket, 'notes.txt'), 'unrelated'); await writeFile(join(f.directory, 'notes.txt'), 'root notes')
  await writeFile(join(bucket, `${hash('owned')}.00000000-0000-0000-0000-000000000000.tmp`), 'partial')
  if (process.platform !== 'win32') {
    const target = join(f.root, 'outside.json'); await writeFile(target, 'preserve'); await rm(path); await symlink(target, path)
  }
  await store.clear()
  assert.deepEqual(await readdir(bucket), ['notes.txt']); assert.equal(await readFile(join(f.directory, 'notes.txt'), 'utf8'), 'root notes')
  if (process.platform !== 'win32') assert.equal(await readFile(join(f.root, 'outside.json'), 'utf8'), 'preserve')
  assert.equal(await store.get('owned'), undefined)
  await store.dispose()
  await f.legacy('owned', 'old source returned')
  const reopened = f.store(); let opened = false
  await reopened.migrateLegacy(async () => { opened = true; throw new Error('cleared data must not return') })
  assert.equal(opened, false); assert.equal(await reopened.get('owned'), undefined, 'both file migration and StorageDomain migration remain retired')
})

test('V1 JSON records and completion markers migrate incrementally without recomputing OCR or vectors', async t => {
  const f = await fixture(t), paths = [await f.legacy('page', { text: 'cached OCR', spans: [[1, 2, 3, 4]] }), await f.legacy('vector', [1, 0])]
  await writeFile(join(f.directory, 'legacy-v1-complete.json'), '{"version":1}')
  const store = f.store()
  assert.deepEqual(await store.get('page'), { text: 'cached OCR', spans: [[1, 2, 3, 4]] })
  assert.deepEqual(await store.get('vector'), [1, 0]); assert.equal(store.diagnostics().importedRecords, 2)
  for (const path of paths) await assert.rejects(stat(path), { code: 'ENOENT' })
  await store.migrateLegacy(async () => { throw new Error('completed StorageDomain must not reopen') })
  assert.equal(store.diagnostics().entries, 2)
  await store.dispose()
  const cold = f.store(); await cold.get('absent')
  assert.equal(cold.diagnostics().entries, 0); assert.equal(cold.diagnostics().importedRecords, 0)
  assert.deepEqual(await cold.get('vector'), [1, 0])
})

test('V1 migration rejects corrupt records, unsafe directories/records and growing files rather than losing them', async t => {
  const f = await fixture(t), path = await f.legacy('record', { ready: true }), original = await readFile(path, 'utf8')
  for (const text of ['broken JSON', original.replace('true', 'null'), envelope('wrong_key', true)]) {
    await writeFile(path, text)
    const store = f.store(); await assert.rejects(store.get('record'), { code: 'pdf/index-storage-corrupt' }); await store.dispose()
    assert.equal(await readFile(path, 'utf8'), text)
  }
  await writeFile(path, original)
  const handle = await open(path, 'r'), prototype = Object.getPrototypeOf(handle) as { read: (...args: unknown[]) => Promise<unknown> }
  const originalRead = prototype.read; await handle.close()
  let changed = false
  t.mock.method(prototype, 'read', async function(this: FileHandle, ...args: unknown[]) {
    if (!changed) { changed = true; await appendFile(path, ' ') }
    return originalRead.apply(this, args)
  })
  const growing = f.store()
  try { await assert.rejects(growing.get('record'), { code: 'pdf/index-storage-corrupt' }) }
  finally { t.mock.restoreAll(); await growing.dispose() }
  if (process.platform === 'win32') return
  const target = join(f.root, 'outside.json'); await writeFile(target, 'preserve'); await rm(path); await symlink(target, path)
  const linked = f.store(); await assert.rejects(linked.get('record'), { code: 'pdf/index-storage-unsafe' }); await linked.dispose()
  assert.equal(await readFile(target, 'utf8'), 'preserve')
  await rm(join(f.directory, hash('record').slice(0, 2)), { recursive: true })
  const outside = join(f.root, 'outside'); await mkdir(outside); await symlink(outside, join(f.directory, hash('record').slice(0, 2)), 'dir')
  await assert.rejects(f.store().get('record'), { code: 'pdf/index-storage-unsafe' })
})

test('partial V1 imports persist progress, cancel promptly and retry without rewriting verified records', async t => {
  const f = await fixture(t), controller = new AbortController(), reason = new Error('Host is unloading')
  await f.legacy('page_1', { text: 'already computed' }); await f.legacy('page_2', [1, 0]); await f.legacy('page_3', true)
  let cancelled = false
  const store = f.store({ onMetric: event => {
    if (!cancelled && event.stage === 'store-write' && event.records === 1) { cancelled = true; controller.abort(reason) }
  } })
  await assert.rejects(store.migrateLegacy(async () => { throw new Error('not yet') }, controller.signal), error => error === reason)
  assert.equal(store.diagnostics().diskWrites, 1); assert.equal(store.diagnostics().entries, 0)
  await store.dispose()
  const resumed = f.store()
  await resumed.migrateLegacy(async () => ({ entries: () => new Map<string, { payload: unknown }>().entries(), async close() {} }))
  assert.equal(resumed.diagnostics().importedRecords, 2, 'the already committed V1 row is verified and reused')
  assert.deepEqual(await resumed.get('page_1'), { text: 'already computed' }); assert.deepEqual(await resumed.get('page_2'), [1, 0])
})

test('StorageDomain migration streams once, closes its source and never revives deleted or cleared data', async t => {
  const f = await fixture(t), store = f.store(); let opens = 0, closes = 0
  const loader = async () => { opens++; return {
    entries: () => new Map<string, { payload: unknown }>([['page_old', { payload: { text: 'OCR already computed' } }], ['vector_old', { payload: [1, 0] }]]).entries(),
    async close() { closes++ },
  } }
  await Promise.all([store.migrateLegacy(loader), store.migrateLegacy(loader)])
  assert.equal(opens, 1); assert.equal(closes, 1); assert.equal(store.diagnostics().entries, 0)
  assert.deepEqual(await store.get('page_old'), { text: 'OCR already computed' })
  await store.delete('vector_old'); await store.dispose()
  const reopened = f.store(); await reopened.migrateLegacy(loader)
  assert.equal(opens, 1); assert.equal(await reopened.get('vector_old'), undefined)
  await reopened.clear(); await reopened.dispose()
  const cleared = f.store(); await cleared.migrateLegacy(loader)
  assert.equal(opens, 1); assert.equal(await cleared.get('page_old'), undefined)
  assert.equal(await readFile(join(f.directory, 'legacy-v1-complete.json'), 'utf8'), '{"version":1}')
})

test('partial source failures resume idempotently and close errors cannot publish a completion marker', async t => {
  const f = await fixture(t), store = f.store(); let fail = true, opens = 0, closes = 0
  const loader = async () => { opens++; return {
    *entries(): Iterable<[string, { payload: unknown }]> {
      yield ['page', { payload: 'cached OCR' }]
      if (fail) throw new Error('private migration failure')
      yield ['vector', { payload: [1, 0] }]
    }, async close() { closes++ },
  } }
  await assert.rejects(store.migrateLegacy(loader), { code: 'pdf/index-storage-migration-failed' })
  assert.equal(closes, 1); assert.equal(await store.get('page'), 'cached OCR')
  assert.equal((await readdir(f.directory)).includes('legacy-v1-complete.json'), false)
  fail = false
  await assert.rejects(store.migrateLegacy(async () => ({ ...await loader(), async close() { closes++; throw new Error('close failed') } })), { code: 'pdf/index-storage-migration-failed' })
  assert.equal((await readdir(f.directory)).includes('legacy-v1-complete.json'), false)
  await store.migrateLegacy(loader)
  assert.equal(opens, 3); assert.equal(closes, 3); assert.equal(store.diagnostics().diskWrites, 2)
  assert.deepEqual(await store.get('vector'), [1, 0])
})

test('corrupt migration markers fail closed rather than importing old data again', async t => {
  const f = await fixture(t); await mkdir(f.directory)
  for (const text of ['broken', '{"version":2}']) {
    await writeFile(join(f.directory, 'legacy-v1-complete.json'), text)
    const store = f.store()
    await assert.rejects(store.migrateLegacy(async () => { throw new Error('loader must not run') }), { code: 'pdf/index-storage-corrupt' })
    await store.dispose()
  }
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

test('migration cancellation before admission, while queued and during acquisition always closes acquired sources', async t => {
  const f = await fixture(t), store = f.store(), reason = new Error('cancelled migration'); let opens = 0, closes = 0
  const loader = async () => { opens++; return { entries: () => new Map<string, { payload: unknown }>().entries(), async close() { closes++ } } }
  const before = new AbortController(); before.abort(reason)
  await assert.rejects(store.migrateLegacy(loader, before.signal), error => error === reason); assert.equal(opens, 0)
  const queued = new AbortController(), write = store.set('queued_first', true), pending = store.migrateLegacy(loader, queued.signal)
  queued.abort(reason); await assert.rejects(pending, error => error === reason); await write; assert.equal(opens, 0)
  const acquired = new AbortController()
  await assert.rejects(store.migrateLegacy(async () => { const source = await loader(); acquired.abort(reason); return source }, acquired.signal), error => error === reason)
  assert.equal(opens, 1); assert.equal(closes, 1); assert.equal((await readdir(f.directory)).includes('legacy-v1-complete.json'), false)
})

test('cancellation during source iteration or source close preserves completed rows and allows a later process to resume', async t => {
  const f = await fixture(t), store = f.store(), controller = new AbortController(), reason = new Error('Host unloading'); let closes = 0
  await assert.rejects(store.migrateLegacy(async () => ({
    *entries(): Iterable<[string, { payload: unknown }]> {
      yield ['ready', { payload: { text: 'OCR already done' } }]
      controller.abort(reason); yield ['pending', { payload: [1, 0] }]
    }, async close() { closes++ },
  }), controller.signal), error => error === reason)
  assert.equal(closes, 1); assert.equal(store.diagnostics().diskWrites, 1)
  const beforeMarker = new AbortController()
  await assert.rejects(store.migrateLegacy(async () => ({
    entries: () => new Map([['ready', { payload: { text: 'OCR already done' } }]]).entries(), async close() { beforeMarker.abort(reason) },
  }), beforeMarker.signal), error => error === reason)
  assert.equal((await readdir(f.directory)).includes('legacy-v1-complete.json'), false)
  await store.dispose()
  const resumed = f.store()
  await resumed.migrateLegacy(async () => ({
    entries: () => new Map<string, { payload: unknown }>([['ready', { payload: { text: 'OCR already done' } }], ['pending', { payload: [1, 0] }]]).entries(),
    async close() { closes++ },
  }))
  assert.equal(resumed.diagnostics().diskWrites, 1); assert.equal(closes, 2)
  assert.deepEqual(await resumed.get('ready'), { text: 'OCR already done' }); assert.deepEqual(await resumed.get('pending'), [1, 0])
})

test('source migration repairs corrupt committed rows without pinning the old store in memory', async t => {
  const f = await fixture(t), initial = f.store()
  await initial.set('repair', 'old'); await initial.dispose()
  f.sql(db => { db.prepare('UPDATE records SET envelope=?,bytes=? WHERE id=?').run('broken JSON', 11, hash('repair')) })
  const repair = f.store()
  await repair.migrateLegacy(async () => ({ entries: () => new Map([['repair', { payload: 'valid legacy OCR' }]]).entries(), async close() {} }))
  assert.equal(repair.diagnostics().diskWrites, 1); assert.equal(repair.diagnostics().entries, 0)
  assert.equal(await repair.get('repair'), 'valid legacy OCR')
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

test('clear in another store retires an acquired legacy source before it can resurrect old records', async t => {
  const f = await fixture(t), importing = f.store(), resetting = f.store()
  let entered!: () => void, release!: () => void, closed = false
  const acquired = new Promise<void>(resolve => { entered = resolve }), barrier = new Promise<void>(resolve => { release = resolve })
  const migration = importing.migrateLegacy(async () => {
    entered(); await barrier
    return { entries: () => new Map([['old_record', { payload: 'must not return' }]]).entries(), async close() { closed = true } }
  })
  try {
    await acquired; await resetting.clear(); release(); await migration
    assert.equal(closed, true); assert.equal(await importing.get('old_record'), undefined)
    assert.equal(importing.diagnostics().diskWrites, 0)
  } finally { release(); await migration }
})

test('clear also fences a V1 file that was already opened by another importing store', async t => {
  const f = await fixture(t), path = await f.legacy('opened_old_record', 'must not return')
  const importing = f.store(), resetting = f.store(), handle = await open(path, 'r')
  const prototype = Object.getPrototypeOf(handle) as { read: (...args: unknown[]) => Promise<unknown> }
  const originalRead = prototype.read; await handle.close()
  let reset = false
  t.mock.method(prototype, 'read', async function(this: FileHandle, ...args: unknown[]) {
    if (!reset) { reset = true; await resetting.clear() }
    return originalRead.apply(this, args)
  })
  try {
    assert.equal(await importing.get('opened_old_record'), undefined)
    assert.equal(reset, true); assert.equal(importing.diagnostics().diskWrites, 0)
    assert.equal(await resetting.has('opened_old_record'), false)
  } finally { t.mock.restoreAll() }
})

test('completed migration accepts a valid formatted marker but never overwrites a corrupt control marker', async t => {
  const f = await fixture(t), store = f.store(), marker = join(f.directory, 'legacy-v1-complete.json')
  await store.clear()
  const loader = async () => { throw new Error('a completed migration must not reopen its source') }
  await writeFile(marker, '{ "version": 1 }')
  await store.migrateLegacy(loader)
  assert.equal(await readFile(marker, 'utf8'), '{ "version": 1 }')
  for (const text of ['broken marker', '{"version":2}']) {
    await writeFile(marker, text)
    await assert.rejects(store.migrateLegacy(loader), { code: 'pdf/index-storage-corrupt' })
    assert.equal(await readFile(marker, 'utf8'), text, 'failure preserves the corrupt control file for diagnosis')
  }
})

test('an external SQLite reset committed during source serialization fences the legacy write transaction', async t => {
  const f = await fixture(t)
  let reset = false, closed = false
  const store = f.store({ onMetric: event => {
    if (reset || event.stage !== 'store-serialize') return
    reset = true
    // A second process can commit between this instance's optimistic check and
    // its BEGIN IMMEDIATE. Exercise that race with a real SQLite connection.
    f.sql(db => { db.exec("BEGIN IMMEDIATE; DELETE FROM records; INSERT OR REPLACE INTO meta(name,value) VALUES ('legacy-v1-complete','1'); COMMIT") })
  } })
  await store.migrateLegacy(async () => ({
    entries: () => new Map([['retired_after_read', { payload: 'must not return' }]]).entries(), async close() { closed = true },
  }))
  assert.equal(reset, true); assert.equal(closed, true)
  assert.equal(store.diagnostics().diskWrites, 0); assert.equal(await store.get('retired_after_read'), undefined)
})

test('bounded prefix scans page in binary key order, preserve payload isolation and use an indexed key range', async t => {
  const f = await fixture(t), store = f.store()
  const records: [string, unknown][] = [
    ['pagecontent_b', { text: 'Second' }], ['pagecontent_A', ['First']], ['pagecontent_a', { text: 'Lower case' }],
    ['pagecontent_', null], ['pagecontent.c', 'different prefix'], ['pagecontentZ', 'not an underscore wildcard match'],
    ['vector_1', [1, 0]],
  ]
  await store.setMany(records)
  await store.dispose()
  const cold = f.store()
  const first = await cold.scan('pagecontent_', undefined, 2)
  assert.deepEqual(first, { entries: [['pagecontent_', null], ['pagecontent_A', ['First']]], nextKey: 'pagecontent_A' })
  ;(first.entries[1]![1] as string[]).push('Changed by consumer')
  const second = await cold.scan('pagecontent_', first.nextKey, 2)
  assert.deepEqual(second, { entries: [['pagecontent_a', { text: 'Lower case' }], ['pagecontent_b', { text: 'Second' }]] })
  assert.deepEqual(await cold.scan('pagecontent_A'), { entries: [['pagecontent_A', ['First']]] })
  assert.deepEqual(await cold.scan('missing'), { entries: [] })
  assert.deepEqual(await cold.scan('pagecontent_', 'pagecontent_z'), { entries: [] })
  assert.equal(cold.diagnostics().entries, 0, 'enumeration does not load a corpus page into the hot cache')
  f.sql(db => {
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT key FROM records WHERE key COLLATE BINARY >= ? AND key COLLATE BINARY < ? AND key COLLATE BINARY > ? ORDER BY key COLLATE BINARY LIMIT ?')
      .all('pagecontent_', 'pagecontent_\u007f', '', 3)
    assert.ok(plan.some(row => String(row.detail).includes('records_key')), 'prefix pagination uses the ordered key index')
  })
})

test('scan defaults and row/byte budgets guarantee progress without retaining unbounded output or hot entries', async t => {
  const f = await fixture(t), writer = f.store()
  for (let index = 0; index < 70; index++) await writer.set(`page_${String(index).padStart(2, '0')}`, { text: 'x'.repeat(100) })
  await writer.dispose()
  const defaults = f.store({ maxMemoryBytes: 100_000 })
  const first = await defaults.scan('page_')
  assert.equal(first.entries.length, 16); assert.equal(first.nextKey, 'page_15')
  const maximum = await defaults.scan('page_', undefined, 64)
  assert.equal(maximum.entries.length, 64); assert.equal(maximum.nextKey, 'page_63')
  const exactEnvelopeBytes = Buffer.byteLength(envelope('page_00', { text: 'x'.repeat(100) }))
  const bounded = f.store({ maxMemoryBytes: exactEnvelopeBytes * 2, maxRecordBytes: 1024 })
  const two = await bounded.scan('page_', undefined, 64)
  assert.equal(two.entries.length, 2); assert.equal(two.nextKey, 'page_01')
  const tiny = f.store({ maxMemoryBytes: 0, maxRecordBytes: 1024 })
  const seen: string[] = []
  let cursor: string | undefined
  do {
    const page = await tiny.scan('page_', cursor, 64)
    assert.equal(page.entries.length, 1, 'one legal large record remains readable with no hot-cache budget')
    seen.push(page.entries[0]![0]); cursor = page.nextKey
  } while (cursor)
  assert.equal(seen.length, 70); assert.equal(new Set(seen).size, 70)
  assert.equal(tiny.diagnostics().entries, 0); assert.equal(tiny.diagnostics().memoryBytes, 0)
  assert.equal(bounded.diagnostics().entries, 0)
})

test('scan rejects unsafe prefixes, foreign cursors and invalid page limits before creating storage', async t => {
  const f = await fixture(t), store = f.store()
  for (const prefix of ['', '../private', 'x/y', 'x\\y', 'x%', '\0', 'a'.repeat(513), undefined, 12]) {
    await assert.rejects(store.scan(prefix as string), { code: 'pdf/index-storage-key' })
  }
  for (const cursor of ['', '../private', 'other_prefix', '\0', 42]) {
    await assert.rejects(store.scan('page_', cursor as string), { code: 'pdf/index-storage-key' })
  }
  for (const limit of [0, -1, 65, 1.5, NaN, Infinity, '2', null]) {
    await assert.rejects(store.scan('page_', undefined, limit as number), { code: 'pdf/index-storage-limit' })
  }
  await assert.rejects(stat(f.directory), { code: 'ENOENT' })
  await store.dispose()
  await assert.rejects(store.scan('page_'), { code: 'pdf/index-storage-closed' })
})

test('scans revalidate all returned envelopes and row identities instead of trusting populated hot records', async t => {
  const f = await fixture(t), store = f.store()
  const key = 'pagecontent_1', original = envelope(key, { ready: true })
  await store.set(key, { ready: true })
  const variants: [string, string, string, number][] = [
    [hash(key), key, 'broken JSON', 11],
    [hash(key), key, '{}', 2],
    [hash(key), key, original.replace('true', 'null'), Buffer.byteLength(original)],
    [hash(key), key, envelope('different-key', { ready: true }), Buffer.byteLength(envelope('different-key', { ready: true }))],
    [hash('wrong-id'), key, original, Buffer.byteLength(original)],
    [hash(key), 'pagecontent_/unsafe', original, Buffer.byteLength(original)],
    [hash(key), key, original, 0],
    [hash(key), key, original, 1.5],
  ]
  for (const [id, rowKey, text, bytes] of variants) {
    f.sql(db => { db.exec('DELETE FROM records'); db.prepare('INSERT INTO records(id,key,envelope,bytes) VALUES (?,?,?,?)').run(id, rowKey, text, bytes) })
    await assert.rejects(store.scan('pagecontent_'), { code: 'pdf/index-storage-corrupt' })
  }
  f.sql(db => { db.exec('DELETE FROM records'); db.prepare('INSERT INTO records(id,key,envelope,bytes) VALUES (?,?,?,?)').run(hash(key), key, 'x'.repeat(1000), 1000) })
  const limited = f.store({ maxRecordBytes: 200 })
  await assert.rejects(limited.scan('pagecontent_'), { code: 'pdf/index-storage-record-too-large' })
  f.sql(db => { db.exec('DELETE FROM records') })
  await store.set(key, { repaired: true })
  assert.deepEqual(await store.scan('pagecontent_'), { entries: [[key, { repaired: true }]] }, 'a failed read releases its snapshot and the operation queue')
})

test('scan pages are consistent snapshots while later pages observe external updates, deletion and clear', async t => {
  const f = await fixture(t)
  let change = false
  const reader = f.store({ onMetric: event => {
    if (!change || event.stage !== 'store-verify') return
    change = false
    f.sql(db => {
      const changed = envelope('page_2', { value: 'new' })
      db.prepare('UPDATE records SET envelope=?,bytes=? WHERE id=?').run(changed, Buffer.byteLength(changed), hash('page_2'))
      db.prepare('DELETE FROM records WHERE id=?').run(hash('page_3'))
    })
  } })
  await reader.setMany([['page_1', { value: 'one' }], ['page_2', { value: 'old' }], ['page_3', { value: 'three' }]])
  change = true
  const snapshot = await reader.scan('page_', undefined, 3)
  assert.deepEqual(snapshot.entries, [['page_1', { value: 'one' }], ['page_2', { value: 'old' }], ['page_3', { value: 'three' }]],
    'one returned page is from one SQLite read transaction')
  assert.deepEqual(await reader.scan('page_', 'page_1'), { entries: [['page_2', { value: 'new' }]] })
  assert.deepEqual(await reader.get('page_2'), { value: 'new' }, 'a scan does not preserve an obsolete hot value')
  const resetting = f.store()
  await resetting.clear()
  assert.deepEqual(await reader.scan('page_'), { entries: [] })
  await resetting.set('page_4', { value: 'after clear' })
  assert.deepEqual(await reader.scan('page_', 'page_2'), { entries: [['page_4', { value: 'after clear' }]] })
})

test('scan observes admitted writes and deletes in queue order and disposal drains accepted pages', async t => {
  const f = await fixture(t), store = f.store()
  const write = store.set('page_1', { value: 1 }), first = store.scan('page_')
  const remove = store.delete('page_1'), empty = store.scan('page_'), close = store.dispose()
  await Promise.all([write, remove, close])
  assert.deepEqual(await first, { entries: [['page_1', { value: 1 }]] })
  assert.deepEqual(await empty, { entries: [] })
  await assert.rejects(store.scan('page_'), { code: 'pdf/index-storage-closed' })
})

test('scan key-index schema cannot be substituted with an index over a different column', async t => {
  const f = await fixture(t), initial = f.store()
  await initial.set('page_1', true); await initial.dispose()
  f.sql(db => { db.exec('DROP INDEX records_key; CREATE INDEX records_key ON records(bytes)') })
  await assert.rejects(f.store().scan('page_'), { code: 'pdf/index-storage-corrupt' })
})
