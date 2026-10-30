import assert from 'node:assert/strict'
import test from 'node:test'
import { createSharedRetrievalSource, type RetrievalBinding } from '../../../src/modules/retrieval/shared-source.ts'
import { createRetrievalService } from '../../../src/modules/retrieval/service.ts'
import type { RetrievalPorts } from '../../../src/modules/retrieval/types.ts'

function binding(sessionId: string): RetrievalBinding {
  return { sessionId, document: { id: sessionId, path: `/private/${sessionId}.pdf`, sourceDigest: 'same',
    contentVersion: `version-${sessionId}`, pageCount: 2 }, selectionIdentity: 'lexical', extractionIdentity: '',
    lifetime: { valid: true, id: sessionId }, signal: new AbortController().signal }
}

test('exhausted source candidates never reveal the previous Session authority error', async () => {
  const a = binding('a'), b = binding('b'), denied = new Set<string>()
  const check = (value: RetrievalBinding) => {
    if (denied.has(value.sessionId)) throw new Error(`Denied ${value.document.path}`)
  }
  const ports: RetrievalPorts = {
    documents: { snapshot: () => a.document, async retain() {
      denied.add('b')
      throw Object.assign(new Error('A permission denied /private/a.pdf'), { code: 'pdf/access-denied' })
    } },
    pages: { async read() { throw new Error('No authorized source can be read') } },
  }
  const source = createSharedRetrievalSource(ports, new Set([a, b]), new AbortController().signal, () => {}, check, check)
  try {
    await assert.rejects(source.read(1), (error: unknown) => {
      assert.equal((error as { code: string }).code, 'pdf/stale-reader')
      assert.doesNotMatch(String(error), /private|permission denied/)
      return true
    })
  } finally { source.dispose() }
})

test('a replacement source keeps its own lease instead of repeatedly retrying a denied owner', async () => {
  const a = binding('a'), b = binding('b'), acquisitions: string[] = [], releases: string[] = []
  const ports: RetrievalPorts = {
    documents: { snapshot: () => a.document, async retain(sessionId) {
      acquisitions.push(sessionId)
      if (sessionId === 'a') throw Object.assign(new Error('A denied'), { code: 'pdf/access-denied' })
      return () => { releases.push(sessionId) }
    } },
    pages: { async read(sessionId, _id, page) { return { text: `${sessionId}:${page}`, source: 'pdf-text' } } },
  }
  const source = createSharedRetrievalSource(ports, new Set([a, b]), new AbortController().signal, () => {}, () => {}, () => {})
  try {
    assert.equal((await source.read(1)).text, 'b:1')
    assert.equal((await source.read(2)).text, 'b:2')
    assert.deepEqual(acquisitions, ['a', 'b'])
    assert.deepEqual(releases, [])
  } finally { source.dispose() }
  assert.deepEqual(releases, ['b'])
})

test('shared provider failures retain their code without broadcasting another Session error details', async () => {
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const provider = { fingerprint: 'shared-error-fixture', dimensions: 2, maxBatchSize: 2,
    async embed() {
      entered(); await gate
      throw Object.assign(new Error('Provider failed for /private/a.pdf with secret account details'),
        { code: 'pdf/retrieval-engine-unavailable' })
    } }
  const service = createRetrievalService({
    documents: { snapshot(sessionId) { return { ...binding(sessionId).document, pageCount: 1 } } },
    pages: { async read() { return { text: 'One shared page', source: 'pdf-text' } } },
    embedding: { select: () => provider },
  })
  try {
    const first = service.prepare('a', { documentId: 'a' })
    await started
    const second = service.prepare('b', { documentId: 'b' })
    const settled = Promise.allSettled([first, second])
    await new Promise<void>(resolve => setImmediate(resolve)); release()
    for (const result of await settled) {
      assert.equal(result.status, 'rejected')
      if (result.status !== 'rejected') continue
      assert.equal(result.reason.code, 'pdf/retrieval-engine-unavailable')
      assert.doesNotMatch(result.reason.message, /private|secret|account/)
    }
  } finally { release(); await service.dispose() }
})
