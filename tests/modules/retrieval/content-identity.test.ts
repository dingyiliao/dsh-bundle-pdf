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

test('invalid and inconsistent page digests fail before reading any page', async () => {
  const f = fixture(), input = { documentId: f.document.id }
  try {
    for (const pageDigests of [[], ['not-a-digest'], [null]]) {
      f.document.indexPageDigests = pageDigests
      await assert.rejects(f.service.prepare('first', input), { code: 'pdf/retrieval-extraction-failed' })
      assert.equal(f.state.reads, 0)
    }
    delete f.document.indexContentDigest
    await f.service.prepare('first', input)
    assert.equal(f.state.reads, 1, 'a partial page digest vector is usable without a whole-document proof')
  } finally { await f.service.dispose() }
})

test('exact-source legacy pages are reused and seeded for the next partial PDF edit', async () => {
  const sha = (part: string) => `sha256:${part.repeat(64)}`
  const document: RetrievalDocument = { id: 'doc', path: '/fixture/legacy.pdf', sourceDigest: sha('1'),
    contentVersion: 'open-1', pageCount: 2 }
  const records = new Map<string, unknown>(), reads: number[] = []
  const service = createRetrievalService({ documents: { snapshot: () => ({ ...document }) },
    cache: { async get(key) { return records.get(key) }, async set(key, value) { records.set(key, value) } },
    pages: { async read(_session, _id, page) {
      reads.push(page)
      return { source: 'pdf-text', text: `Content of page ${page}.` }
    } } })
  try {
    const input = { documentId: document.id, query: 'content', mode: 'lexical' as const }
    await service.search('session', input)
    assert.deepEqual(reads, [1, 2])
    document.indexContentDigest = sha('a')
    document.indexPageDigests = [sha('b'), sha('c')]
    await service.search('session', input)
    assert.deepEqual(reads, [1, 2], 'an old byte-key index can seed page keys without extraction')
    Object.assign(document, { sourceDigest: sha('2'), contentVersion: 'open-2', indexContentDigest: sha('d'),
      indexPageDigests: [sha('b'), sha('e')] })
    await service.search('session', input)
    assert.deepEqual(reads, [1, 2, 2], 'unchanged page key survives the whole-document version change')
  } finally { await service.dispose() }
})

test('restoring a legacy ready index records page proof for a later edit without rewriting the old pages', async () => {
  const sha = (part: string) => `sha256:${part.repeat(64)}`
  const document: RetrievalDocument = { id: 'doc', path: '/fixture/ready.pdf', sourceDigest: sha('1'),
    indexContentDigest: sha('a'), contentVersion: 'open-1', pageCount: 2 }
  const records = new Map<string, unknown>(), reads: number[] = []
  const ports: RetrievalPorts = { documents: { snapshot: () => ({ ...document }) },
    cache: { async get(key) { return records.get(key) }, async set(key, value) { records.set(key, value) } },
    pages: { async read(_session, _id, page) {
      reads.push(page)
      return { source: 'pdf-text', text: `Content of page ${page} (${document.contentVersion}).` }
    } } }
  const input = { documentId: document.id, query: 'content', mode: 'lexical' as const }
  async function search() {
    const service = createRetrievalService(ports)
    try { return await service.search('session', input) }
    finally { await service.dispose() }
  }
  const old = await search(), stored = records.size
  document.indexPageDigests = [sha('b'), sha('c')]
  const restored = await search()
  assert.equal(restored.indexGeneration, old.indexGeneration)
  assert.deepEqual(reads, [1, 2])
  assert.equal(records.size, stored + 1, 'restoring adds one small manifest, not rewritten content records')
  Object.assign(document, { sourceDigest: sha('2'), contentVersion: 'open-2', indexContentDigest: sha('d'),
    indexPageDigests: [sha('b'), sha('e')] })
  const updated = await search()
  assert.notEqual(updated.indexGeneration, old.indexGeneration)
  assert.deepEqual(reads, [1, 2, 2])
  assert.ok(updated.chunks.some(chunk => chunk.page === 2 && chunk.text.includes('open-2')))
})

test('changed fingerprint algorithms reuse OCR and vectors only for identical source bytes', async () => {
  const sha = (part: string) => `sha256:${part.repeat(64)}`
  const document: RetrievalDocument = {
    id: 'doc', path: '/fixture/scanned.pdf', sourceDigest: sha('1'), contentVersion: 'original', pageCount: 1,
    indexContentDigest: sha('a'), indexPageDigests: [sha('b')],
  }
  const records = new Map<string, unknown>()
  const ocrReads: string[] = [], documentEmbeddings: string[] = []
  const ports: RetrievalPorts = {
    documents: { snapshot: () => ({ ...document }) },
    cache: { async get(key) { return records.get(key) }, async set(key, value) { records.set(key, value) } },
    pages: { indexIdentity: () => 'configured-ocr', async read() {
      ocrReads.push(document.sourceDigest)
      return { source: 'ocr', text: `Scanned evidence from the ${document.contentVersion} document.` }
    } },
    embedding: { select: () => ({ fingerprint: 'fixture-encoder', dimensions: 2, maxBatchSize: 8,
      async embed(texts, purpose) {
        if (purpose === 'document') documentEmbeddings.push(...texts)
        return texts.map(() => [1, 0])
      },
    }) },
  }
  const input = { documentId: document.id, query: 'scanned evidence', mode: 'semantic' as const }
  async function search() {
    const service = createRetrievalService(ports)
    try { return await service.search('session', input) }
    finally { await service.dispose() }
  }

  const first = await search()
  assert.equal(first.status, 'complete')
  assert.deepEqual(first.coverage.ocrPages, [1])
  assert.deepEqual(ocrReads, [sha('1')])
  assert.equal(documentEmbeddings.length, 1)

  Object.assign(document, { contentVersion: 'upgraded', indexContentDigest: sha('c'), indexPageDigests: [sha('d')] })
  const upgraded = await search()
  assert.equal(upgraded.status, 'complete')
  assert.notEqual(upgraded.indexGeneration, first.indexGeneration)
  assert.equal(upgraded.coverage.embeddedChunks, first.coverage.embeddedChunks)
  assert.deepEqual(upgraded.chunks, first.chunks)
  assert.deepEqual(ocrReads, [sha('1')])
  assert.equal(documentEmbeddings.length, 1)

  delete document.indexContentDigest
  document.indexPageDigests = [null]
  const withoutFingerprint = await search()
  assert.equal(withoutFingerprint.status, 'complete')
  assert.deepEqual(withoutFingerprint.chunks, first.chunks)
  assert.deepEqual(ocrReads, [sha('1')])
  assert.equal(documentEmbeddings.length, 1)

  Object.assign(document, { sourceDigest: sha('2'), contentVersion: 'changed', indexContentDigest: sha('e'),
    indexPageDigests: [sha('f')] })
  const changed = await search()
  assert.equal(changed.status, 'complete')
  assert.match(changed.chunks[0]!.text, /changed document/)
  assert.deepEqual(ocrReads, [sha('1'), sha('2')])
  assert.equal(documentEmbeddings.length, 2)
})
