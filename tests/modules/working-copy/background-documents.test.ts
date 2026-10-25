import assert from 'node:assert/strict'
import test from 'node:test'
import { createBackgroundDocuments } from '../../../src/modules/working-copy/index.ts'
import type { DocumentResidency, DocumentRelease } from '../../../src/modules/working-copy/background-documents.ts'

function fixture(schedule = false) {
  const documents = new Map<string, DocumentResidency>()
  const closed: string[] = []
  const listeners = new Set<() => void>()
  let time = 1
  async function suspend(sessionId: string, id: string, evict?: () => Promise<unknown>): Promise<DocumentRelease> {
    const entry = documents.get(id)
    if (!entry) return 'already-closed'
    assert.equal(entry.sessionId, sessionId)
    if (entry.uiReferences) return 'retained-ui'
    if (entry.pins) return 'retained-operation'
    if (!entry.resident) return 'already-closed'
    await evict?.()
    entry.resident = false; entry.bytes = 0
    return 'released'
  }
  const workspaces = {
    listDocuments: () => [...documents.values()].map(entry => ({ ...entry })),
    isUiOwned(_session: string, id: string) { return Boolean(documents.get(id)?.uiReferences) },
    touch(_session: string, id: string) { const entry = documents.get(id); if (entry) entry.touched = time },
    onIdle(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    suspend,
    async releaseBackground(sessionId: string, id: string, evict?: () => Promise<unknown>, expectedReferenceId?: string | null): Promise<DocumentRelease> {
      const entry = documents.get(id)
      if (entry && expectedReferenceId !== undefined && (entry.modelReferenceId ?? null) !== expectedReferenceId) return 'retained-model'
      if (entry) entry.modelOwned = false
      return suspend(sessionId, id, evict)
    },
  }
  const policy = createBackgroundDocuments(workspaces, { async releaseDocument(id) { closed.push(id) } },
    { now: () => time, schedule })
  return { policy, documents, closed, listeners,
    advance(ms: number) { time += ms },
    add(id: string, options: Partial<DocumentResidency> = {}) {
      documents.set(id, { sessionId: 'one', id, bytes: 1024, touched: time, resident: true,
        uiReferences: 0, modelOwned: true, pins: 0, ...options })
    },
  }
}

test('LRU reclaims resident bytes/native handles without deleting logical identities or model references', async () => {
  const f = fixture()
  try {
    for (const id of ['a', 'b', 'c', 'd']) {
      f.add(id); await f.policy.adopt('one', id, 1024); f.advance(1)
    }
    f.policy.touch('one', 'a')
    f.advance(1); f.add('e'); await f.policy.adopt('one', 'e', 1024)
    assert.deepEqual(f.closed, ['b'])
    assert.equal(f.policy.diagnostics().documents, 4)
    assert.equal(f.documents.size, 5, 'The registry remains the only identity table')
    assert.equal(f.documents.get('b')!.modelOwned, true)
    assert.equal(f.documents.get('b')!.resident, false)
    f.documents.get('a')!.uiReferences = 1
    assert.equal(await f.policy.close('one', 'a'), 'retained-ui')
    assert.equal(f.documents.get('a')!.modelOwned, false, 'UI and model ownership are independent')
    assert.equal(await f.policy.close('one', 'c'), 'released')
    assert.equal(await f.policy.close('one', 'c'), 'already-closed')
    await f.policy.closeSession('one')
    assert.equal(f.policy.diagnostics().documents, 0)
    assert.equal(f.documents.get('a')!.resident, true)
    assert.equal(f.documents.get('a')!.uiReferences, 1)
  } finally { await f.policy.dispose() }
})

test('idle/oversize eviction preserves registry identity and final UI release reclaims unowned resources', async () => {
  const f = fixture()
  try {
    f.add('huge', { bytes: 129 * 1024 * 1024 })
    await assert.rejects(f.policy.adopt('one', 'huge', 129 * 1024 * 1024), { code: 'pdf/background-size' })
    assert.equal(f.documents.get('huge')!.resident, false)
    f.add('idle'); await f.policy.adopt('one', 'idle', 1024)
    f.advance(11 * 60_000)
    await f.policy.sweep()
    assert.equal(f.documents.get('idle')!.resident, false)
    assert.equal(f.documents.get('idle')!.modelOwned, true)
    f.add('ui', { uiReferences: 1, modelOwned: false })
    await f.policy.sweep()
    assert.equal(f.documents.get('ui')!.resident, true)
    f.documents.get('ui')!.uiReferences = 0
    for (const listener of f.listeners) listener()
    await f.policy.sweep()
    assert.equal(f.documents.get('ui')!.resident, false)
    assert.deepEqual(f.closed, ['huge', 'idle', 'ui'])
  } finally { await f.policy.dispose() }
})

test('in-flight operations survive close and capacity pressure; final unpin retries reclamation', async () => {
  const f = fixture()
  try {
    for (let n = 0; n < 5; n++) f.add(`p${n}`, { pins: 1 })
    await f.policy.adopt('one', 'p4', 1024)
    assert.equal(f.policy.diagnostics().documents, 5, 'Temporary over-budget pins must not spin or evict')
    assert.equal(await f.policy.close('one', 'p0'), 'retained-operation')
    f.advance(11 * 60_000); await f.policy.sweep()
    assert.deepEqual(f.closed, [])
    f.documents.get('p0')!.pins = 0
    for (const listener of f.listeners) listener()
    await f.policy.sweep()
    assert.deepEqual(f.closed, ['p0'])
    assert.equal(f.documents.get('p0')!.resident, false)
  } finally { await f.policy.dispose() }
})

test('global pressure evicts eligible oldest across sessions without counting UI resources', async () => {
  const f = fixture()
  try {
    for (const [id, sessionId] of [['a', 'one'], ['b', 'two'], ['c', 'three']]) {
      f.add(id, { sessionId, bytes: 100 * 1024 * 1024 }); f.advance(1)
    }
    f.add('ui', { bytes: 100 * 1024 * 1024, uiReferences: 1 })
    await f.policy.sweep()
    assert.deepEqual(f.closed, ['a'])
    assert.equal(f.policy.diagnostics().bytes, 200 * 1024 * 1024)
  } finally { await f.policy.dispose() }
})

test('session epoch fences late admission while preserving IDs for future authorized reopen', async () => {
  const f = fixture()
  try {
    const epoch = f.policy.epoch('one')
    await f.policy.closeSession('one')
    f.add('late')
    await assert.rejects(f.policy.adopt('one', 'late', 1024, epoch), { code: 'pdf/session-disposed' })
    assert.equal(f.documents.has('late'), true)
    assert.equal(f.documents.get('late')!.modelOwned, false)
    f.add('new'); await f.policy.adopt('one', 'new', 1024)
    assert.equal(f.policy.diagnostics().documents, 1)
    await f.policy.dispose()
    await assert.rejects(f.policy.adopt('one', 'new', 1024), { code: 'pdf/unavailable' })
  } finally { await f.policy.dispose() }
})

test('delayed close and detached-generation cleanup cannot clear a later model reference', async () => {
  const f = fixture()
  try {
    f.add('shared', { modelReferenceId: 'old-model' })
    const cleanup = f.policy.closeSession('one')
    f.documents.get('shared')!.modelReferenceId = 'new-model'
    await cleanup
    assert.equal(f.documents.get('shared')!.modelOwned, true)
    assert.deepEqual(f.closed, [])
    const close = f.policy.close('one', 'shared')
    f.documents.get('shared')!.modelReferenceId = 'newest-model'
    assert.equal(await close, 'retained-model')
    assert.equal(f.documents.get('shared')!.resident, true)
    assert.equal(await f.policy.close('one', 'shared'), 'released')
  } finally { await f.policy.dispose() }
})

test('scheduled sweep and disposer release policy subscriptions without deleting registry entries', async t => {
  let sweep: (() => void) | undefined
  let unrefs = 0, clears = 0
  const timer = { unref() { unrefs++ } } as unknown as ReturnType<typeof setInterval>
  t.mock.method(globalThis, 'setInterval', (callback: () => void, delay?: number) => {
    assert.equal(delay, 60_000); sweep = callback; return timer
  })
  t.mock.method(globalThis, 'clearInterval', (active: ReturnType<typeof setInterval>) => {
    assert.equal(active, timer); clears++
  })
  const f = fixture(true)
  try {
    assert.equal(unrefs, 1)
    f.add('idle'); f.advance(11 * 60_000); sweep!()
    await f.policy.sweep()
    assert.deepEqual(f.closed, ['idle'])
    await f.policy.dispose()
    assert.equal(clears, 1); assert.equal(f.listeners.size, 0)
    sweep!(); await f.policy.sweep()
    assert.equal(f.documents.has('idle'), true)
  } finally { await f.policy.dispose() }
})
