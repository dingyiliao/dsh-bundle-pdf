import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createV1DraftRepository } from '../../../src/adapters/host/storage/v1-drafts.ts'
import { digestPdfBytes, encodePdfBaseline } from '../../../src/modules/document/index.ts'
import type { DraftRecord, V1DraftPort, WorkspaceRecord } from '../../../src/modules/working-copy/index.ts'

const bytes = Uint8Array.from([37, 80, 68, 70])
const sourceHash = digestPdfBytes(bytes)
const draft: WorkspaceRecord = {
  format: 1, sessionId: 'session', path: '/a/book.pdf', sourceHash,
  sourceVersion: 'fs-1', contentVersion: 'logical-1', revision: 3,
  groups: [[{ type: 'delete', id: 'annotation-1' }]], groupDates: ['2026-10-18T00:00:00.000Z'], cursor: 1,
}

function table() {
  const values = new Map<string, DraftRecord>()
  const writes: string[] = []
  const adapter: V1DraftPort = {
    get: key => values.get(key),
    async put(key, value) { writes.push(key); values.set(key, structuredClone(value)) },
    async delete(key) { values.delete(key) },
  }
  return { adapter, values, writes }
}

test('V1 repository keeps the published key, baseline-first write order and redo record shape', async () => {
  const state = table()
  const repository = createV1DraftRepository(state.adapter)
  const sourceKey = createHash('sha256').update(JSON.stringify(['session', '/a/book.pdf'])).digest('hex')
  assert.equal(repository.key('session', '/a/book.pdf'), sourceKey)
  const active = await repository.persist(draft, sourceKey, bytes)
  const baseKey = `base_${sourceKey}_${sourceHash.slice(7)}`
  assert.deepEqual(state.writes, [baseKey, sourceKey])
  assert.equal(state.values.get(baseKey)?.original, encodePdfBaseline(bytes))
  assert.equal(active.baseKey, baseKey)
  assert.equal(state.values.get(sourceKey)?.original, undefined)
  assert.deepEqual(repository.hydrate(active).groupDates, draft.groupDates)
  await repository.persist(active, sourceKey, bytes, sourceHash)
  assert.deepEqual(state.writes, [baseKey, sourceKey, sourceKey], 'later writes never duplicate the baseline')
  assert.equal(state.values.get(sourceKey)?.renderedHash, sourceHash)
  await repository.deleteBaseline(active)
  assert.equal(state.values.has(baseKey), false)
})

test('V1 repository rejects a baseline from another source and observes live storage methods', async () => {
  const state = table()
  const repository = createV1DraftRepository(state.adapter)
  const key = repository.key(draft.sessionId, draft.path)
  const saved = await repository.persist(draft, key, bytes)
  const baseline = state.values.get(saved.baseKey!)!
  state.values.set(saved.baseKey!, { ...baseline, path: '/elsewhere/book.pdf' })
  assert.throws(() => repository.hydrate(saved), { code: 'pdf/draft-damaged' })
  let called = false
  state.adapter.delete = async () => { called = true }
  await repository.delete(key)
  assert.equal(called, true)
})
