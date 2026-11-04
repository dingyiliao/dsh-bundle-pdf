import assert from 'node:assert/strict'
import test from 'node:test'
import { createTextEvidence, describeEvidenceCapabilities, evidenceSha256, savedTextRangeReferenceSchema,
  textEvidenceSchema } from '../../../src/modules/evidence/index.ts'
import type { HostWorkspaceSnapshot } from '../../../src/modules/working-copy/index.ts'
import type { NativeTextContent } from '../../../src/shared/native.ts'
import { imageEvidenceSchema } from '../../../src/modules/evidence/reference-store.ts'

const snapshot = { id: 'doc', path: '/paper.pdf', bytes: Buffer.from('source'), sourceVersion: 'fs-1',
  contentVersion: 'v1', revision: 0, document: { pageCount: 1, pages: [] } } as unknown as HostWorkspaceSnapshot
const content: NativeTextContent = { items: [], styles: {}, lang: null, extraction: 'local-ocr' }
const native = createTextEvidence(snapshot, 1, 'text', 0, 4)
const ocr = createTextEvidence(snapshot, 1, 'text', 0, 4, content)

test('capabilities come from provenance, preserve old OCR refs and remain outside stored strict schemas', () => {
  assert.equal(describeEvidenceCapabilities(native).source, 'native-text')
  assert.equal(describeEvidenceCapabilities(native).exactAnnotate, true)
  assert.match(describeEvidenceCapabilities(native).reason, /require current source.*native glyph geometry.*verified by Host/u)
  const legacy = { ...ocr, precision: 'exact-text' as const }
  assert.equal(textEvidenceSchema.safeParse(legacy).success, true)
  assert.equal(describeEvidenceCapabilities(legacy).source, 'local-ocr')
  assert.equal(describeEvidenceCapabilities(legacy).exactAnnotate, false)
  assert.equal(describeEvidenceCapabilities(legacy).navigation, 'page')
  assert.equal(textEvidenceSchema.safeParse({ ...legacy, capabilities: { exactAnnotate: true } }).success, false)
})

test('Host-observed unmapped native characters constrain annotation reporting without changing native text or geometry routing', () => {
  const observed = { ...content, extraction: undefined, quality: { unmappedCharacters: 2 } }
  const degraded = createTextEvidence(snapshot, 1, 'text', 0, 4, observed)
  assert.deepEqual(degraded.quality, { unmappedCharacters: 2 })
  observed.quality.unmappedCharacters = 3
  assert.equal(degraded.quality?.unmappedCharacters, 2, 'capture copies the observed quality signal')
  assert.ok(textEvidenceSchema.safeParse(degraded).success)
  const caps = describeEvidenceCapabilities(degraded)
  assert.equal(caps.source, 'native-text')
  assert.equal(caps.textMatching, 'exact')
  assert.equal(caps.navigation, 'range', 'native subranges must still enter the native geometry resolver')
  assert.equal(caps.exactAnnotate, false)
  assert.match(caps.reason, /unmapped characters.*not currently eligible.*Exact stored-text matching and narrowing remain available/)
  assert.match(caps.reason, /Host must recheck the selected range.*source, text and native glyph geometry/)
  assert.match(caps.reason, /do not establish whether a selected subrange has valid geometry/)
  assert.equal(degraded.snapshot.text, native.snapshot.text)
  assert.equal('capabilities' in degraded, false)
  const clean = createTextEvidence(snapshot, 1, 'text', 0, 4, { ...content, extraction: undefined,
    quality: { unmappedCharacters: 0 } })
  assert.equal(clean.quality, undefined)
  assert.equal(describeEvidenceCapabilities(clean).exactAnnotate, true)
  assert.equal(textEvidenceSchema.safeParse(native).success, true, 'old strict records remain valid')
  for (const quality of [{ unmappedCharacters: -1 }, { unmappedCharacters: 1.5 },
    { unmappedCharacters: 1, exactAnnotate: true }, { exactAnnotate: true }]) {
    assert.equal(textEvidenceSchema.safeParse({ ...native, quality }).success, false)
  }
})

test('range capability is constrained by every embedded page and all image origins remain page-only', () => {
  const range = savedTextRangeReferenceSchema.parse({ sessionId: 'session', createdAt: Date.now(),
    evidence: { refId: native.refId, source: 'pdf-text-range', documentId: native.documentId,
      sourcePath: native.sourcePath, sourceDigest: native.sourceDigest, sourceVersion: native.sourceVersion,
      contentVersion: native.contentVersion, revision: native.revision,
      pages: [{ evidence: native, pageTextDigest: evidenceSha256('text') },
        { evidence: { ...ocr, page: 2 }, pageTextDigest: evidenceSha256('text') }] } })
  assert.equal(describeEvidenceCapabilities(range.evidence).source, 'mixed-text')
  assert.equal(describeEvidenceCapabilities(range.evidence).exactAnnotate, false)
  const allNative = { ...range.evidence, pages: range.evidence.pages.map((page, index) => ({ ...page,
    evidence: { ...native, page: index + 1, ...(index ? { quality: { unmappedCharacters: 1 } } : {}) } })) }
  const nativeCaps = describeEvidenceCapabilities(allNative)
  assert.equal(nativeCaps.source, 'native-text')
  assert.equal(nativeCaps.textMatching, 'exact')
  assert.equal(nativeCaps.navigation, 'range')
  assert.equal(nativeCaps.exactAnnotate, false, 'any degraded native page constrains the range report')
  assert.equal(savedTextRangeReferenceSchema.safeParse({ sessionId: 'session', createdAt: Date.now(), evidence: allNative }).success, true)
  for (const source of ['direct-image', 'ocr-text', 'auxiliary-vision'] as const) {
    const evidence = imageEvidenceSchema.parse({ refId: native.refId, source, documentId: native.documentId,
      sourcePath: native.sourcePath, sourceDigest: native.sourceDigest, sourceVersion: native.sourceVersion,
      contentVersion: native.contentVersion, revision: native.revision, page: 1,
      renderedImageSha256: evidenceSha256('image'), locator: { kind: 'page-only' },
      precision: 'page-only', limitations: [], snapshot: source === 'direct-image'
        ? { kind: 'attachment', attachmentId: 'attachment', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }
        : { kind: 'derived-text', text: 'text', sha256: evidenceSha256('text'), backendId: 'backend' } })
    const caps = describeEvidenceCapabilities(evidence)
    assert.equal(caps.source, source)
    assert.equal(caps.navigation, 'page')
    assert.equal(caps.exactAnnotate, false)
    assert.equal(caps.textMatching, source === 'direct-image' ? 'none' : 'derived')
  }
})
