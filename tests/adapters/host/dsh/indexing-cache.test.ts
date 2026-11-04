import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createIndexingCache } from '../../../../src/adapters/host/dsh/indexing/cache.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('index cache gates concurrent readers and writers on one migration, then reuses disk data after restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pdf-index-cache-'))
  const lifetime = new AbortController(), opened = deferred(), release = deferred()
  let opens = 0, closes = 0
  const legacy = new Map([
    ['page_old', { createdAt: 0, payload: 'existing OCR' }],
    ['vector_old', { createdAt: 0, payload: [1, 0] }],
  ])
  const storage = { async open() {
    opens++; opened.resolve(); await release.promise
    return { table: () => ({ entries: () => legacy.entries() }), async close() { closes++ } }
  } } as unknown as Parameters<typeof createIndexingCache>[0]
  const first = createIndexingCache(storage, { directory, suffix: 'test', lifetime: lifetime.signal })
  const secondaries: ReturnType<typeof createIndexingCache>[] = []
  t.after(async () => {
    release.resolve(); lifetime.abort()
    await first.dispose()
    for (const cache of secondaries) await cache.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  let published = false
  const read = first.cache.get('page_old')
  const write = first.cache.set('new_page', 'new OCR').then(() => { published = true })
  await opened.promise
  assert.equal(opens, 1)
  assert.equal(published, false, 'writes cannot bypass a pending migration')
  const caller = new AbortController()
  const waiting = first.waitForMigration(caller.signal)
  caller.abort(new Error('caller cancelled'))
  await assert.rejects(waiting, /caller cancelled/)
  release.resolve()
  assert.equal(await read, 'existing OCR')
  await write
  assert.equal(closes, 1)
  assert.deepEqual(await first.cache.get('vector_old'), [1, 0])
  await first.dispose()
  const reopened = createIndexingCache(storage, { directory, suffix: 'test', lifetime: lifetime.signal })
  secondaries.push(reopened)
  assert.equal(await reopened.cache.get('new_page'), 'new OCR')
  assert.deepEqual(await reopened.cache.get('vector_old'), [1, 0])
  assert.equal(opens, 1, 'a completed migration does not reopen legacy storage')
  lifetime.abort(new Error('host unloading'))
  await assert.rejects(reopened.cache.get('page_old'), /host unloading/)
})

test('a failed migration remains a read barrier and can be retried without clearing reusable results', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pdf-index-cache-retry-'))
  const lifetime = new AbortController()
  let failing = true, opens = 0
  const storage = { async open() {
    opens++
    if (failing) throw new Error('legacy temporarily unavailable')
    return { table: () => ({ entries: () => new Map([
      ['existing', { createdAt: 0, payload: 'retained result' }],
    ]).entries() }), async close() {} }
  } } as unknown as Parameters<typeof createIndexingCache>[0]
  const index = createIndexingCache(storage, { directory, suffix: 'test', lifetime: lifetime.signal })
  t.after(async () => { lifetime.abort(); await index.dispose(); await rm(directory, { recursive: true, force: true }) })
  await assert.rejects(index.waitForMigration(), { code: 'pdf/index-storage-migration-failed' })
  assert.equal(opens, 1)
  failing = false
  assert.equal(await index.cache.get('existing'), 'retained result')
  assert.equal(opens, 2)
})
