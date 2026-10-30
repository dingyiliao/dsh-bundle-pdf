import assert from 'node:assert/strict'
import test from 'node:test'
import { createPdfRetrieval } from '../../../../src/adapters/host/dsh/retrieval.ts'
import { EmbeddingRegistry } from '../../../../src/embedding/index.ts'
import { createMemoryEvidenceReferenceStore } from '../../../../src/modules/evidence/index.ts'
import type { HostWorkspaceSnapshot } from '../../../../src/modules/working-copy/index.ts'
import { defaultSettings } from '../../../../src/shared/contracts.ts'

const signal = new AbortController().signal
function fixture() {
  const snapshots = new Map(['a', 'b'].map(owner => [owner, {
    id: `document-${owner}`, path: `/session-${owner}/same-content.pdf`, bytes: new Uint8Array([1, 2, 3]),
    sourceVersion: `source-${owner}`, contentVersion: 'content-v1', revision: owner === 'a' ? 3 : 17,
    dirty: owner === 'b', conflict: false, canUndo: owner === 'b', canRedo: false,
    document: { pageCount: 1, pages: [], annotations: [], signed: false, encrypted: false, readOnly: false },
  } satisfies HostWorkspaceSnapshot]))
  const state = { resolution: 'matching' as 'matching' | 'missing' | 'foreign' | 'revoked',
    configuration: 'first', events: [] as string[], metadata: [] as string[], reads: [] as string[], documents: 0, queries: 0, pins: 0 }
  const registry = new EmbeddingRegistry(), references = createMemoryEvidenceReferenceStore()
  registry.register({
    descriptor: { id: 'fixture', name: 'Fixture', version: '1', execution: 'local',
      configurationFields: [{ key: 'variant', label: 'Variant', type: 'string' }] },
    describe: () => ({ engineId: 'fixture', engineVersion: '1', model: 'fixture', modelRevision: '1',
      dimensions: 2, maxBatchSize: 8, maxInputCharacters: 16000, encoding: 'fixture', fingerprint: 'shared-auth-fixture' }),
    async availability() { state.events.push('probe'); return { status: 'available' } },
    async embed(request) {
      state[request.purpose === 'document' ? 'documents' : 'queries'] += request.texts.length
      return request.texts.map(() => [1, 0])
    },
  })
  const snapshot = (sessionId: string, id: string) => {
    const value = snapshots.get(sessionId)
    assert.equal(id, value?.id, 'only the current Session document reference may be resolved')
    if (!value) throw new Error('Unknown session')
    state.metadata.push(sessionId)
    return value
  }
  const retrieval = createPdfRetrieval({ readSnapshot: snapshot }, {
    async readPageText(sessionId, id) {
      state.reads.push(sessionId)
      return { snapshot: snapshot(sessionId, id), content: { items: [{ str: 'Atomic changes either commit or roll back.',
        transform: [1, 0, 0, 1, 0, 0], width: 100, height: 10, dir: 'ltr', fontName: 'Helvetica', hasEOL: false }],
      styles: {}, lang: null } }
    },
  }, references, { embeddings: registry, settings: () => ({ ...defaultSettings, embeddingEngine: 'fixture',
    engineConfigurations: { embedding: { fixture: { variant: state.configuration } } } }),
    async retain(sessionId, id, active) {
      active.throwIfAborted()
      state.events.push(`retain:${sessionId}`)
      assert.equal(id, snapshots.get(sessionId)?.id)
      if (sessionId === 'b') {
        if (state.resolution === 'missing') throw new Error('Session was retired')
        if (state.resolution === 'foreign') throw new Error('PDF retrieval session identity mismatch')
        if (state.resolution === 'revoked') throw Object.assign(new Error('File access revoked'), { code: 'FS_SANDBOX_DENIED' })
      }
      state.pins++
      return () => { state.pins--; state.events.push(`release:${sessionId}`) }
    },
  })
  return { retrieval, state, snapshots, references, registry }
}

test('a ready shared index still authorizes the new Session before any probe and signs only its own document evidence', async () => {
  const f = fixture()
  try {
    await f.retrieval.prepare('a', { documentId: 'document-a' }, signal)
    assert.equal(f.state.documents, 1)
    const metadata = f.state.metadata.length, reads = f.state.reads.length
    f.state.events.length = 0
    const result = await f.retrieval.search('b', { documentId: 'document-b', query: 'atomic', mode: 'semantic' }, signal)
    assert.equal(f.state.events[0], 'retain:b', 'a warm index must not skip the caller authorization boundary')
    assert.equal(f.state.events.at(-1), 'release:b')
    assert.equal(f.state.events.filter(event => event === 'retain:b').length, 1, 'a ready index needs no new build-owned lease')
    assert.equal(f.state.pins, 0)
    assert.equal(f.state.documents, 1, 'the shared ready index avoids document re-embedding')
    assert.equal(f.state.queries, 1)
    assert.deepEqual(new Set(f.state.metadata.slice(metadata)), new Set(['b']))
    assert.deepEqual(f.state.reads.slice(reads), ['b'], 'candidate text is revalidated against the current caller document')
    assert.equal(result.documentId, 'document-b')
    assert.equal(result.path, '/session-b/same-content.pdf')
    assert.equal(result.revision, 17)
    assert.equal(result.sourceVersion, 'source-b')
    assert.equal(result.candidates.length, 1)
    const evidence = result.candidates[0]!.evidence
    assert.equal(evidence.documentId, 'document-b')
    assert.equal(evidence.sourcePath, result.path)
    assert.equal(evidence.revision, 17)
    assert.equal(f.references.get(evidence.refId)?.sessionId, 'b')
    assert.equal(JSON.stringify(result).includes('document-a'), false)
    assert.equal(JSON.stringify(result).includes('/session-a/'), false)
  } finally { await f.retrieval.dispose(); f.registry.dispose() }
})

test('missing, foreign and revoked callers cannot consume a ready shared index or contact its engine', async () => {
  const f = fixture()
  try {
    await f.retrieval.prepare('a', { documentId: 'document-a' }, signal)
    for (const resolution of ['missing', 'foreign', 'revoked'] as const) {
      f.state.resolution = resolution; f.state.events.length = 0
      const before = { metadata: f.state.metadata.length, reads: f.state.reads.length, queries: f.state.queries }
      await assert.rejects(f.retrieval.search('b', { documentId: 'document-b', query: 'atomic', mode: 'semantic' }, signal),
        resolution === 'missing' ? /Session was retired/ : resolution === 'foreign' ? /identity mismatch/ : /access revoked/)
      assert.deepEqual(f.state.events, ['retain:b'])
      assert.deepEqual({ metadata: f.state.metadata.length, reads: f.state.reads.length, queries: f.state.queries }, before)
      assert.equal(f.state.pins, 0)
    }
    f.state.resolution = 'matching'
    const ready = await f.retrieval.search('b', { documentId: 'document-b', query: 'atomic', mode: 'semantic' }, signal)
    assert.equal(ready.status, 'complete', 'one caller rejection must not invalidate the shared data')
    assert.equal(f.state.documents, 1)
  } finally { await f.retrieval.dispose(); f.registry.dispose() }
})

test('a caller lease is released when availability fails, and pre-aborted calls never acquire authority', async () => {
  const f = fixture()
  try {
    f.registry.dispose()
    await assert.rejects(f.retrieval.search('b', { documentId: 'document-b', query: 'atomic', mode: 'semantic' }, signal),
      { code: 'pdf/retrieval-engine-unavailable' })
    assert.equal(f.state.pins, 0)
    assert.deepEqual(f.state.events, ['retain:b', 'release:b'])
    const controller = new AbortController(); controller.abort(new Error('Closed caller'))
    f.state.events.length = 0
    await assert.rejects(f.retrieval.search('b', { documentId: 'document-b', query: 'atomic' }, controller.signal), /Closed caller/)
    assert.deepEqual(f.state.events, [])
  } finally { await f.retrieval.dispose(); f.registry.dispose() }
})

test('Host binding configurations stay isolated even when a contributor returns the same model fingerprint', async () => {
  const f = fixture()
  try {
    await f.retrieval.prepare('a', { documentId: 'document-a' }, signal)
    const first = await f.retrieval.search('a', { documentId: 'document-a', query: 'atomic', mode: 'semantic' }, signal)
    f.state.configuration = 'second'
    const second = await f.retrieval.search('a', { documentId: 'document-a', query: 'atomic', mode: 'semantic' }, signal)
    assert.notEqual(second.indexGeneration, first.indexGeneration)
    assert.equal(f.state.documents, 2, 'a distinct saved configuration cannot consume the first binding vectors')
    const shared = await f.retrieval.search('b', { documentId: 'document-b', query: 'atomic', mode: 'semantic' }, signal)
    assert.equal(shared.indexGeneration, second.indexGeneration)
    assert.equal(f.state.documents, 2)
    assert.equal(shared.documentId, 'document-b')
  } finally { await f.retrieval.dispose(); f.registry.dispose() }
})
