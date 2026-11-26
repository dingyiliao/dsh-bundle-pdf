import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createIndexingCache } from '../../../../src/surfaces/host/io/indexing-cache.ts'

test('index cache persists checkpoints across host restarts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pdf-index-cache-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const first = createIndexingCache({ directory })
  try { await first.cache.set('page', { text: 'cached page' }) }
  finally { await first.dispose() }
  const reopened = createIndexingCache({ directory })
  try { assert.deepEqual(await reopened.cache.get('page'), { text: 'cached page' }) }
  finally { await reopened.dispose() }
})

test('index cache exposes atomic checkpoint repair', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pdf-index-cache-repair-'))
  const index = createIndexingCache({ directory })
  t.after(async () => { await index.dispose(); await rm(directory, { recursive: true, force: true }) })
  assert.equal(await index.cache.compareAndSet('checkpoint', undefined, { generation: 1 }), true)
  assert.equal(await index.cache.compareAndSet('checkpoint', undefined, { generation: 2 }), false)
  assert.deepEqual(await index.cache.get('checkpoint'), { generation: 1 })
})
