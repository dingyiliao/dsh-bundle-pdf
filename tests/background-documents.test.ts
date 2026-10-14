import assert from 'node:assert/strict'
import test from 'node:test'
import { createBackgroundDocuments } from '../src/host/background-documents.ts'

test('background documents evict oldest per session, release native handles, and preserve UI copies', async () => {
  const owners = new Map<string, 'agent' | 'ui'>()
  const closed: string[] = []
  const workspaces = {
    isUiOwned(_sessionId: string, id: string) { return owners.get(id) === 'ui' },
    async releaseBackground(_sessionId: string, id: string) {
      if (owners.get(id) === 'ui') return 'retained-ui' as const
      return owners.delete(id) ? 'released' as const : 'already-closed' as const
    },
  }
  const pdfService = { async releaseDocument(id: string) { closed.push(id) } }
  let time = 1
  const background = createBackgroundDocuments(workspaces as never, pdfService as never,
    { now: () => time, schedule: false })
  try {
    for (const id of ['a', 'b', 'c', 'd']) {
      owners.set(id, 'agent')
      await background.adopt('first', id, 1024)
      time++
    }
    assert.equal(background.diagnostics().documents, 4)
    background.touch('first', 'a')
    owners.set('e', 'agent')
    await background.adopt('first', 'e', 1024)
    assert.deepEqual(closed, ['b'], 'LRU eviction must keep the recently used document')
    assert.equal(background.diagnostics().documents, 4)
    owners.set('a', 'ui')
    assert.equal(await background.close('first', 'a'), 'retained-ui')
    assert.equal(owners.get('a'), 'ui')
    assert.equal(await background.close('first', 'c'), 'released')
    assert.deepEqual(closed, ['b', 'c'])
    assert.equal(await background.close('first', 'c'), 'already-closed')
    await background.closeSession('first')
    assert.equal(background.diagnostics().documents, 0)
    assert.equal(owners.get('a'), 'ui')
  } finally { background.dispose() }
})

test('oversized background copy is released and idle session copies expire', async () => {
  const live = new Set(['huge', 'idle'])
  const closed: string[] = []
  let time = 1
  const background = createBackgroundDocuments({
    isUiOwned: () => false,
    async releaseBackground(_sessionId: string, id: string) {
      return live.delete(id) ? 'released' as const : 'already-closed' as const
    },
  } as never, { async releaseDocument(id: string) { closed.push(id) } } as never,
  { now: () => time, schedule: false })
  try {
    await assert.rejects(background.adopt('one', 'huge', 129 * 1024 * 1024), { code: 'pdf/background-size' })
    assert.equal(live.has('huge'), false)
    await background.adopt('one', 'idle', 1024)
    time += 11 * 60 * 1000
    // Admission sweeps expired entries; the new UI copy is never counted.
    live.add('ui')
    await background.adopt('one', 'ui', 1024)
    assert.equal(live.has('idle'), false)
    assert.deepEqual(closed, ['huge', 'idle'])
  } finally { background.dispose() }
})

test('a session disposed during background open cannot admit its late working copy', async () => {
  const released: string[] = []
  const background = createBackgroundDocuments({
    isUiOwned: () => false,
    async releaseBackground(_sessionId: string, id: string) { released.push(id); return 'released' as const },
  } as never, { async releaseDocument() {} } as never, { schedule: false })
  try {
    const oldEpoch = background.epoch('session')
    await background.closeSession('session')
    await assert.rejects(background.adopt('session', 'late', 100, oldEpoch), { code: 'pdf/session-disposed' })
    assert.deepEqual(released, ['late'])
    await background.adopt('session', 'new', 100, background.epoch('session'))
    assert.equal(background.diagnostics().documents, 1)
  } finally { background.dispose() }
})
