import assert from 'node:assert/strict'
import test from 'node:test'
import { createEvidenceReferenceStore } from '../../../src/adapters/host/storage/evidence-references.ts'
import { captureOcrPageEvidence, captureRenderedPageEvidence, createImageEvidenceRegistry,
  evidenceSha256, savedReferenceSchema, type DerivedPageValue, type ImageEvidenceCapture,
  type OcrPageEvidenceValue, type RenderedPageValue, type SavedReference,
} from '../../../src/modules/evidence/index.ts'
import type { HostWorkspaceSnapshot } from '../../../src/modules/working-copy/index.ts'

const signal = new AbortController().signal
const png = Buffer.from('a rendered PNG, never to be stored in an evidence record')

function fixture(verify = true) {
  let documentId = 'document-1'
  let path = '/paper.pdf'
  let bytes = Buffer.from('%PDF-original')
  let sourceBytes = bytes
  let revision = 1
  let pageCount = 2
  let changeDuringPut = false
  let changeDuringVerify = false
  const records = new Map<string, SavedReference>()
  const snapshot = (): HostWorkspaceSnapshot => ({ id: documentId, path,
    sourceVersion: 'fs-v1', contentVersion: 'content-v1', revision, dirty: false,
    canUndo: false, canRedo: false, conflict: false, bytes,
    document: { pageCount } as HostWorkspaceSnapshot['document'] })
  const workspaces = { readSnapshot(sessionId: string, requested: string) {
    if (sessionId !== 'alice' || requested !== documentId) {
      throw Object.assign(new Error('Not owned by this session'), { code: 'pdf/session-mismatch' })
    }
    return snapshot()
  } }
  const store = createEvidenceReferenceStore({
    get: key => records.get(key),
    async put(key, value) {
      records.set(key, savedReferenceSchema.parse(structuredClone(value)))
      if (changeDuringPut) revision++
    },
    async delete(key) { return records.delete(key) },
    entries: () => records.entries(),
  })
  const attachment = { mediaType: 'image/png' as const, bytes: png.length, width: 600, height: 800,
    storedImageSha256: evidenceSha256(png) }
  let attachmentAvailable = true
  const verifyAttachment = async (sessionId: string, expected: { attachmentId: string }) => {
    assert.equal(sessionId, 'alice')
    if (changeDuringVerify) revision++
    return attachmentAvailable && expected.attachmentId === 'attachment-1' ? attachment : undefined
  }
  const create = () => createImageEvidenceRegistry(workspaces, store, verify ? verifyAttachment : undefined)
  const capture = (source: 'direct-image' | 'ocr-text' | 'auxiliary-vision' = 'direct-image'): ImageEvidenceCapture => ({
    documentId, sourcePath: path, sourceDigest: evidenceSha256(bytes), sourceVersion: 'fs-v1',
    contentVersion: 'content-v1', revision, page: 2, renderedImageSha256: evidenceSha256(png),
    locator: { kind: 'page-only' }, precision: 'page-only', limitations: [], source,
    snapshot: source === 'direct-image'
      ? { kind: 'attachment', attachmentId: 'attachment-1', ...attachment }
      : { kind: 'derived-text', text: 'Recognized chart labels',
        sha256: evidenceSha256('Recognized chart labels'), backendId: source === 'ocr-text' ? 'ocr-local' : 'vision-cheap',
        backendVersion: '1.0' },
  })
  const readSource = async (sessionId: string, current: HostWorkspaceSnapshot, currentSignal: AbortSignal) => {
    currentSignal.throwIfAborted()
    assert.equal(sessionId, 'alice')
    return { path: current.path, digest: evidenceSha256(sourceBytes) }
  }
  return { create, capture, records, store, snapshot, workspaces, attachment, readSource,
    reopen() { documentId = 'document-2' }, changeRevision() { revision++ },
    changeBytes() { bytes = Buffer.from('%PDF-different'); sourceBytes = bytes },
    overwriteSource() { sourceBytes = Buffer.from('%PDF-external-overwrite') },
    movePath(next: string) { path = next },
    removePage() { pageCount = 1 }, setAttachmentAvailable(value: boolean) { attachmentAvailable = value },
    changeAttachmentWidth(width: number) { attachment.width = width },
    changeDuringPut(value: boolean) { changeDuringPut = value },
    changeDuringVerify(value: boolean) { changeDuringVerify = value },
  }
}

test('page render/OCR adapters preserve source provenance without persisting image bytes', () => {
  const common = { documentId: 'document-1', path: '/paper.pdf', page: 2, pageCount: 3,
    revision: 1, sourceVersion: 'fs-v1', contentVersion: 'content-v1' }
  const evidenceSource = { kind: 'direct-image' as const, sourceDigest: evidenceSha256('source'),
    renderedImageSha256: evidenceSha256(png), storedImageSha256: evidenceSha256(png),
    precision: 'page-only' as const, limitations: ['No draft overlays'] }
  const direct: RenderedPageValue = { ...common, evidenceSource,
    image: { attachmentId: 'attachment-1', mediaType: 'image/png', bytes: png.length, width: 600, height: 800 } }
  const capturedDirect = captureRenderedPageEvidence(direct)
  assert.equal(capturedDirect.source, 'direct-image')
  assert.deepEqual(capturedDirect.locator, { kind: 'page-only' })
  assert.equal(capturedDirect.snapshot.kind, 'attachment')
  assert.equal(JSON.stringify(capturedDirect).includes(png.toString()), false)

  const derived: DerivedPageValue = { ...common, kind: 'derived-text', text: 'caption',
    totalChars: 7, truncated: false, source: { backendId: 'vision-cheap', mode: 'image-description' },
    evidenceSource: { ...evidenceSource, kind: 'auxiliary-vision', snapshotSha256: evidenceSha256('caption') } }
  const capturedDerived = captureRenderedPageEvidence(derived)
  assert.equal(capturedDerived.source, 'auxiliary-vision')
  assert.equal(capturedDerived.snapshot.kind, 'derived-text')
  if (capturedDerived.snapshot.kind === 'derived-text') {
    assert.equal(capturedDerived.snapshot.sha256, evidenceSha256('caption'))
  }

  const ocr: OcrPageEvidenceValue = { ...common, text: 'page text', source: {
    backendId: 'local-ocr', backendVersion: '2', kind: 'ocr' },
    evidenceSource: { ...evidenceSource, kind: 'ocr-text', snapshotSha256: evidenceSha256('page text') } }
  const capturedOcr = captureOcrPageEvidence(ocr)
  assert.equal(capturedOcr.source, 'ocr-text')
  assert.equal(capturedOcr.snapshot.kind, 'derived-text')
  if (capturedOcr.snapshot.kind === 'derived-text') {
    assert.equal(capturedOcr.snapshot.backendVersion, '2')
  }
})

test('direct-image evidence stores an attachment handle, not image bytes, and replays after Host restart', async () => {
  const harness = fixture()
  const first = await harness.create().mint('alice', harness.capture(), signal)
  assert.match(first.refId, /^pdfref_[0-9a-f-]{36}$/)
  assert.equal(first.source, 'direct-image')
  assert.equal(first.snapshot.kind, 'attachment')
  assert.equal(JSON.stringify(harness.records.get(first.refId)).includes(png.toString()), false)
  const replay = await harness.create().revalidate('alice', 'document-1', first.refId, signal, harness.readSource)
  assert.equal(replay.revalidated, false)
  assert.equal(replay.evidence.refId, first.refId)
  harness.reopen()
  const rebound = await harness.create().revalidate('alice', 'document-2', first.refId, signal, harness.readSource)
  assert.equal(rebound.revalidated, true)
  assert.equal(rebound.evidence.documentId, 'document-2')
  assert.notEqual(rebound.evidence.refId, first.refId)
  assert.equal(harness.records.size, 2)
})

test('direct-image replay fails closed when the attachment cannot be attested', async () => {
  const harness = fixture()
  harness.setAttachmentAvailable(false)
  await assert.rejects(harness.create().mint('alice', harness.capture(), signal),
    { code: 'pdf/attachment-unavailable' })
  assert.equal(harness.records.size, 0)
  harness.setAttachmentAvailable(true)
  const first = await harness.create().mint('alice', harness.capture(), signal)
  const noVerifier = createImageEvidenceRegistry(harness.workspaces, harness.store)
  await assert.rejects(noVerifier.revalidate('alice', 'document-1', first.refId, signal, harness.readSource),
    { code: 'pdf/attachment-unavailable' })
  harness.setAttachmentAvailable(false)
  await assert.rejects(harness.create().revalidate('alice', 'document-1', first.refId, signal, harness.readSource),
    { code: 'pdf/attachment-unavailable' })
  harness.setAttachmentAvailable(true)
  harness.changeAttachmentWidth(601)
  await assert.rejects(harness.create().revalidate('alice', 'document-1', first.refId, signal, harness.readSource),
    { code: 'pdf/attachment-unavailable' })
  harness.changeAttachmentWidth(600)
  await assert.rejects(harness.create().revalidate('bob', 'document-1', first.refId, signal, harness.readSource),
    { code: 'pdf/reference-unavailable' })
  await assert.rejects(noVerifier.mint('alice', harness.capture(), signal),
    { code: 'pdf/attachment-unavailable' })
})

test('OCR and auxiliary image evidence persist bounded derived text and remain distinct from PDF text refs', async () => {
  const harness = fixture(false)
  const registry = harness.create()
  for (const source of ['ocr-text', 'auxiliary-vision'] as const) {
    const saved = await registry.mint('alice', harness.capture(source), signal)
    assert.equal(saved.source, source)
    assert.equal(saved.snapshot.kind, 'derived-text')
    const replay = await harness.create().revalidate('alice', 'document-1', saved.refId, signal, harness.readSource)
    assert.equal(replay.evidence.snapshot.kind, 'derived-text')
    if (replay.evidence.snapshot.kind === 'derived-text') {
      assert.equal(replay.evidence.snapshot.text, 'Recognized chart labels')
    }
  }
  const forged = harness.capture('ocr-text')
  if (forged.snapshot.kind !== 'derived-text') assert.fail('Expected derived evidence')
  await assert.rejects(registry.mint('alice', { ...forged, snapshot: { ...forged.snapshot,
    sha256: evidenceSha256('other text') } }, signal), { code: 'pdf/invalid-evidence' })
  await assert.rejects(registry.mint('alice', { ...forged, snapshot: { ...forged.snapshot,
    text: 'x'.repeat(8001) } }, signal))
})

test('image refs are session-scoped and source-byte-bound; regions and page bounds are validated', async () => {
  const harness = fixture()
  const registry = harness.create()
  const first = await registry.mint('alice', harness.capture(), signal)
  await assert.rejects(registry.revalidate('bob', 'document-1', first.refId, signal, harness.readSource),
    { code: 'pdf/reference-unavailable' })
  harness.movePath('/other.pdf')
  await assert.rejects(registry.revalidate('alice', 'document-1', first.refId, signal, harness.readSource),
    { code: 'pdf/reference-unavailable' })
  harness.movePath('/paper.pdf')
  harness.removePage()
  await assert.rejects(registry.revalidate('alice', 'document-1', first.refId, signal, harness.readSource),
    { code: 'pdf/stale-reader' })
  harness.reopen()
  // A new one-page document cannot mint evidence allegedly captured on page 2.
  await assert.rejects(registry.mint('alice', harness.capture(), signal), { code: 'pdf/stale-reader' })
})

test('image reference rejects a changed source and invalid PDF-region geometry', async () => {
  const harness = fixture()
  const registry = harness.create()
  const first = await registry.mint('alice', harness.capture(), signal)
  harness.changeBytes()
  await assert.rejects(registry.revalidate('alice', 'document-1', first.refId, signal, harness.readSource),
    { code: 'pdf/stale-reader' })
  const invalid = { ...harness.capture(), locator: { kind: 'pdf-region' as const,
    rectPdf: [20, 30, 10, 40] as [number, number, number, number] } }
  await assert.rejects(registry.mint('alice', invalid, signal), { code: 'pdf/invalid-region' })
})

test('image replay rejects an external overwrite even when its working copy was not reopened', async () => {
  const harness = fixture()
  const registry = harness.create()
  const first = await registry.mint('alice', harness.capture(), signal)
  assert.equal((await registry.revalidate('alice', 'document-1', first.refId, signal,
    harness.readSource)).evidence.refId, first.refId)
  harness.overwriteSource()
  await assert.rejects(registry.revalidate('alice', 'document-1', first.refId, signal,
    harness.readSource), { code: 'pdf/stale-reader' })
  assert.equal(harness.snapshot().revision, 1, 'the working copy was not refreshed')
})

test('image replay checks the fresh source again after attachment verification and respects abort', async () => {
  const harness = fixture()
  const first = await harness.create().mint('alice', harness.capture(), signal)
  let checks = 0
  const readSource: typeof harness.readSource = async (...args) => {
    checks++
    if (checks === 2) harness.overwriteSource()
    return harness.readSource(...args)
  }
  await assert.rejects(harness.create().revalidate('alice', 'document-1', first.refId, signal,
    readSource), { code: 'pdf/stale-reader' })
  assert.equal(checks, 2)
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(harness.create().revalidate('alice', 'document-1', first.refId,
    cancelled.signal, harness.readSource), /abort/i)
  const inFlight = new AbortController()
  await assert.rejects(harness.create().revalidate('alice', 'document-1', first.refId,
    inFlight.signal, async (...args) => {
      inFlight.abort()
      return harness.readSource(...args)
    }), /abort/i)
})

test('image reference rejects a working-copy revision that changes during attachment attestation', async () => {
  const harness = fixture()
  const first = await harness.create().mint('alice', harness.capture(), signal)
  harness.changeDuringVerify(true)
  await assert.rejects(harness.create().revalidate('alice', 'document-1', first.refId, signal, harness.readSource),
    { code: 'pdf/stale-reader' })
})

test('mint rejects stale captures and deletes a record if the working copy changes during persistence', async () => {
  const harness = fixture(false)
  const staleCapture = harness.capture('ocr-text')
  harness.changeRevision()
  await assert.rejects(harness.create().mint('alice', staleCapture, signal), { code: 'pdf/stale-reader' })
  harness.changeDuringPut(true)
  await assert.rejects(harness.create().mint('alice', harness.capture('ocr-text'), signal),
    { code: 'pdf/stale-reader' })
  assert.equal(harness.records.size, 0)
})
