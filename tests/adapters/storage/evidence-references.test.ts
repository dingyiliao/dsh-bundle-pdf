import assert from 'node:assert/strict'
import test from 'node:test'
import { createEvidenceReferenceStore } from '../../../src/adapters/host/storage/evidence-references.ts'
import { savedReferenceSchema, type SavedReference } from '../../../src/modules/evidence/index.ts'

const digest = `sha256:${'a'.repeat(64)}`
function saved(refId: string, createdAt: number): SavedReference {
  return { sessionId: 'alice', createdAt, pageTextDigest: digest,
    evidence: { refId, documentId: 'document', sourcePath: '/paper.pdf', sourceDigest: digest,
      sourceVersion: 'fs-v1', contentVersion: 'content-v1', revision: 1, page: 2,
      source: 'pdf-text', snapshot: { text: 'source passage', sha256: digest },
      locator: { kind: 'text-window', startUtf16: 5, endUtf16: 19 },
      precision: 'exact-text', limitations: [] } }
}
function savedImage(refId: string, createdAt: number): SavedReference {
  return { sessionId: 'alice', createdAt,
    evidence: { refId, documentId: 'document', sourcePath: '/paper.pdf', sourceDigest: digest,
      sourceVersion: 'fs-v1', contentVersion: 'content-v1', revision: 1, page: 2,
      source: 'direct-image', renderedImageSha256: digest,
      snapshot: { kind: 'attachment', attachmentId: 'private-attachment-id', mediaType: 'image/png',
        bytes: 4096, width: 600, height: 800 },
      locator: { kind: 'page-only' }, precision: 'page-only', limitations: [] } }
}
function table() {
  const data = new Map<string, SavedReference>()
  return { data,
    get: (key: string) => data.get(key),
    async put(key: string, value: SavedReference) { data.set(key, structuredClone(value)) },
    async delete(key: string) { return data.delete(key) },
    entries: () => data.entries(),
  }
}

test('evidence records validate before entering a durable domain', () => {
  const value = saved(`pdfref_${'a'.repeat(8)}-${'a'.repeat(4)}-${'a'.repeat(4)}-${'a'.repeat(4)}-${'a'.repeat(12)}`, 1000)
  assert.deepEqual(savedReferenceSchema.parse(value), value)
  assert.equal(savedReferenceSchema.safeParse({ ...value, sessionId: '' }).success, false)
  assert.equal(savedReferenceSchema.safeParse({ ...value, evidence: { ...value.evidence,
    snapshot: { text: 'x'.repeat(8001), sha256: digest } } }).success, false)
  const image = savedImage(value.evidence.refId, 1000)
  assert.deepEqual(savedReferenceSchema.parse(image), image)
  assert.equal(savedReferenceSchema.safeParse({ ...image, evidence: { ...image.evidence,
    snapshot: { kind: 'attachment', attachmentId: 'id', mediaType: 'image/png',
      bytes: 4096, width: 600, height: 800, data: Buffer.alloc(4096).toString('base64') } } }).success, false,
  'image evidence cannot inline raw image bytes')
})

test('derived references survive a new adapter and expire without becoming access tokens', async () => {
  const records = table()
  const first = createEvidenceReferenceStore(records, () => 1000)
  await first.put('ref-1', saved('ref-1', 1000))
  const restarted = createEvidenceReferenceStore(records, () => 1001)
  const restored = restarted.get('ref-1')
  assert.equal(restored?.evidence.source, 'pdf-text')
  if (restored?.evidence.source !== 'pdf-text') assert.fail('Expected a saved text reference')
  assert.equal(restored.evidence.snapshot.text, 'source passage')
  await restarted.delete('ref-1')
  assert.equal(first.get('ref-1'), undefined)
  await first.put('old-ref', saved('old-ref', 1000))
  const expired = createEvidenceReferenceStore(records, () => 1000 + 30 * 24 * 60 * 60 * 1000 + 1)
  assert.equal(expired.get('old-ref'), undefined)
  await expired.put('new-ref', saved('new-ref', 1000 + 30 * 24 * 60 * 60 * 1000 + 1))
  assert.equal(records.data.has('old-ref'), false)
})

test('derived reference repository retains only the newest 256 entries', async () => {
  const records = table()
  let clock = 1
  const store = createEvidenceReferenceStore(records, () => clock)
  for (let index = 0; index < 257; index++) {
    clock = index + 1
    await store.put(`ref-${index}`, index % 2 === 0
      ? savedImage(`ref-${index}`, clock) : saved(`ref-${index}`, clock))
  }
  assert.equal(records.data.size, 256)
  assert.equal(store.get('ref-0'), undefined)
  assert.ok(store.get('ref-256'))
})

test('image references share the 30-day expiration with text references', async () => {
  const records = table()
  const store = createEvidenceReferenceStore(records, () => 1000)
  await store.put('image-ref', savedImage('image-ref', 1000))
  const expired = createEvidenceReferenceStore(records, () => 1000 + 30 * 24 * 60 * 60 * 1000 + 1)
  assert.equal(expired.get('image-ref'), undefined)
  await expired.put('new-image', savedImage('new-image', 1000 + 30 * 24 * 60 * 60 * 1000 + 1))
  assert.equal(records.data.has('image-ref'), false)
})

test('session disposal removes only references belonging to that session', async () => {
  const records = table()
  const store = createEvidenceReferenceStore(records, () => 1000)
  await store.put('alice-ref', saved('alice-ref', 1000))
  await store.put('bob-ref', { ...saved('bob-ref', 1000), sessionId: 'bob' })
  await store.deleteSession('alice')
  assert.equal(store.get('alice-ref'), undefined)
  assert.ok(store.get('bob-ref'))
})
