import assert from 'node:assert/strict'
import test from 'node:test'
import { createRetrievalService } from '../../../src/modules/retrieval/service.ts'
import type { RetrievalDocument, RetrievalPorts } from '../../../src/modules/retrieval/types.ts'

function fixture() {
  const document: RetrievalDocument = { id: 'document', path: '/fixture/content.pdf', sourceDigest: 'raw-source-one',
    indexContentDigest: `sha256:${'a'.repeat(64)}`, contentVersion: 'opening-one', pageCount: 1 }
  const state = { runtime: 'runtime-model-a', policy: 'accepted-policy', reads: 0, duringRead: undefined as (() => void) | undefined }
  const ports: RetrievalPorts = {
    documents: { snapshot() { return { ...document } } },
    embedding: { select: () => ({ fingerprint: 'fixture-encoder', dimensions: 2, maxBatchSize: 8,
      async embed(texts) { return texts.map(() => [1, 0]) } }) },
    pages: { identity: () => state.runtime, indexIdentity: () => state.policy,
      async read() { state.reads++; state.duringRead?.(); return { source: 'pdf-text', text: 'Accepted document content.' } } },
  }
  const service = createRetrievalService(ports)
  return { service, document, state }
}

test('persistent index identity reuses an accepted artifact while runtime and raw-file fences stay fresh', async () => {
  const f = fixture(), query = { documentId: 'document', query: 'content', mode: 'semantic' as const }
  try {
    await f.service.prepare('first', { documentId: 'document' })
    const first = await f.service.search('first', query)
    f.state.runtime = 'runtime-model-b'
    f.document.sourceDigest = 'raw-source-with-annotations'
    f.document.contentVersion = 'opening-two'
    await f.service.prepare('second', { documentId: 'document' })
    const second = await f.service.search('second', query)
    assert.equal(second.indexGeneration, first.indexGeneration)
    assert.equal(f.state.reads, 1)
    assert.equal(second.document.sourceDigest, f.document.sourceDigest)
    assert.throws(() => f.service.validate('first', first), { code: 'pdf/stale-reader' })
    f.service.validate('second', second)
    f.state.policy = 'different-saved-policy'
    assert.throws(() => f.service.validate('second', second), { code: 'pdf/stale-reader' })
    await f.service.prepare('second', { documentId: 'document' })
    assert.notEqual((await f.service.search('second', query)).indexGeneration, first.indexGeneration)
    assert.equal(f.state.reads, 2)
  } finally { await f.service.dispose() }
})

test('a changed accepted-index policy cannot publish an in-flight read under its former policy', async () => {
  const f = fixture()
  f.state.duringRead = () => { f.state.policy = 'changed-policy' }
  try { await assert.rejects(f.service.prepare('first', { documentId: 'document' }), { code: 'pdf/stale-reader' }) }
  finally { await f.service.dispose() }
})

test('malformed content and persistent-policy identities are rejected before page extraction', async () => {
  for (const malformed of ['', 'not-a-digest', `sha256:${'G'.repeat(64)}`]) {
    const f = fixture(); f.document.indexContentDigest = malformed
    try {
      await assert.rejects(f.service.prepare('first', { documentId: 'document' }), { code: 'pdf/retrieval-extraction-failed' })
      assert.equal(f.state.reads, 0)
    } finally { await f.service.dispose() }
  }
  const f = fixture(); f.state.policy = 'x'.repeat(16385)
  try {
    await assert.rejects(f.service.prepare('first', { documentId: 'document' }), { code: 'pdf/retrieval-extraction-failed' })
    assert.equal(f.state.reads, 0)
  } finally { await f.service.dispose() }
})
