import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryEvidenceReferenceStore, createTextRangeReferences, createTextReferenceResolver,
  describeEvidenceCapabilities, evidenceSha256, rememberTextEvidence } from '../../../../src/layers/facade/evidence/index.ts'
import type { AgentPageReadPort } from '../../../../src/layers/facade/evidence/agent-page-read.ts'
import type { HostWorkspaceSnapshot } from '../../../../src/layers/document/working-copy/index.ts'
import type { NativeTextContent } from '../../../../src/shared/native.ts'

const signal = new AbortController().signal
function positioned(text: string): NativeTextContent {
  return { items: [{ str: text, hasEOL: false, dir: 'ltr', fontName: 'test', height: 12,
    transform: [12, 0, 0, 12, 20, 200], width: Array.from(text).length * 5,
    glyphs: Array.from(text, (_, index) => [20 + index * 5, 200, 5]) }], styles: {}, lang: null,
    quality: { unmappedCharacters: 1 } }
}

function fixture() {
  let snapshot = { id: 'doc', path: '/book.pdf', bytes: Buffer.from('PDF source'), sourceVersion: 'fs-1',
    contentVersion: 'content-1', revision: 0, conflict: false, dirty: false, canUndo: false, canRedo: false,
    document: { pageCount: 1, pages: [{ cropBox: [0, 0, 600, 800] }] } as HostWorkspaceSnapshot['document'] }
  const raw = positioned('prefix Native 😀\ntext \ufffd suffix')
  let reads = 0
  const workspaces = { readSnapshot(owner: string, id: string) {
    if (owner !== 'alice' || id !== snapshot.id) throw Object.assign(new Error('Foreign document'), { code: 'pdf/session-mismatch' })
    return snapshot
  } }
  const pages: AgentPageReadPort = { async readPageText(owner, id, _page, abort) {
    abort.throwIfAborted()
    reads++
    return { snapshot: workspaces.readSnapshot(owner, id), content: raw }
  } }
  const references = createMemoryEvidenceReferenceStore()
  const mint = async (extraction?: 'local-ocr') => {
    const ref = await rememberTextEvidence(references, 'alice', snapshot, 1, raw.items[0]!.str,
      'prefix '.length, raw.items[0]!.str.indexOf(' \ufffd suffix'), raw)
    if (extraction) {
      const saved = references.get(ref.refId)!
      if (saved.evidence.source === 'pdf-text') saved.evidence.extraction = extraction
    }
    return ref
  }
  return { raw, pages, reads: () => reads, references, mint,
    ranges: createTextRangeReferences(workspaces, pages, references),
    resolver: createTextReferenceResolver(workspaces, pages, references),
    freshSource: async () => ({ path: snapshot.path, digest: evidenceSha256(snapshot.bytes) }),
    replaceSource() { snapshot = { ...snapshot, bytes: Buffer.from('replaced PDF'), sourceVersion: 'fs-2', revision: 1 } },
  }
}

test('native evidence read, derive, capture and precise resolution work on clean subranges of pages with unmapped characters', async () => {
  const f = fixture(), parent = await f.mint()
  const read = await f.ranges.readEvidence('alice', 'doc', parent.refId, signal, f.freshSource)
  assert.equal(read.pages[0]!.snapshot.text, 'Native 😀\ntext')
  const narrowed = await f.ranges.derive('alice', 'doc', parent.refId, 'Native 😀 text', signal,
    f.freshSource, 'whitespace-normalized')
  const target = await f.resolver.resolve('alice', 'doc', narrowed.refId, signal, f.freshSource)
  assert.equal(target.text, 'Native 😀\ntext')
  assert.equal(target.startUtf16, 'prefix '.length)
  assert.equal(target.endUtf16, 'prefix Native 😀\ntext'.length)
  assert.ok(target.quadPoints.length)
  const captured = await f.ranges.capture('alice', 'doc',
    { start: { page: 1, quote: 'Native' }, end: { page: 1, quote: 'text' } }, signal, f.freshSource)
  assert.equal(captured.pages[0]!.extraction, undefined)
  assert.equal(captured.pages[0]!.snapshot.text, target.text)
  assert.ok(f.reads() >= 5)
})

test('legacy native reference reads refresh Host quality observations without changing their attested occurrence', async () => {
  const f = fixture(), parent = await f.mint()
  const saved = f.references.get(parent.refId)!
  if (saved.evidence.source !== 'pdf-text') assert.fail('Expected text reference')
  delete saved.evidence.quality
  const original = structuredClone(saved.evidence)
  assert.equal(describeEvidenceCapabilities(original).exactAnnotate, true)
  const read = await f.ranges.readEvidence('alice', 'doc', parent.refId, signal, f.freshSource)
  const current = read.pages[0]!
  assert.equal(read.refId, parent.refId)
  assert.equal(current.refId, parent.refId)
  assert.equal(read.revalidated, false)
  assert.deepEqual(current.snapshot, original.snapshot)
  assert.equal(current.locator.startUtf16, original.locator.startUtf16)
  assert.equal(current.locator.endUtf16, original.locator.endUtf16)
  assert.deepEqual(current.quality, { unmappedCharacters: 1 })
  assert.equal(describeEvidenceCapabilities(current).source, 'native-text')
  assert.equal(describeEvidenceCapabilities(current).navigation, 'range')
  assert.equal(describeEvidenceCapabilities(current).exactAnnotate, false)
  assert.equal(saved.evidence.quality, undefined, 'fresh display observations do not rewrite the persisted snapshot')
})

test('legacy persisted local-OCR references fail closed instead of upgrading to native wording or geometry', async () => {
  const f = fixture()
  const parent = await f.mint('local-ocr')
  await assert.rejects(f.ranges.readEvidence('alice', 'doc', parent.refId, signal, f.freshSource),
    { code: 'pdf/text-representation-unavailable' })
  await assert.rejects(f.ranges.derive('alice', 'doc', parent.refId, 'Native 😀 text', signal,
    f.freshSource, 'whitespace-normalized'),
    { code: 'pdf/text-representation-unavailable' })
  await assert.rejects(f.resolver.resolve('alice', 'doc', parent.refId, signal, f.freshSource),
    { code: 'pdf/text-geometry-unavailable' })
})

test('bound native reads retain source/session/cancellation checks', async () => {
  const f = fixture(), parent = await f.mint()
  await assert.rejects(f.ranges.readEvidence('bob', 'doc', parent.refId, signal, f.freshSource),
    { code: 'pdf/reference-unavailable' })
  const controller = new AbortController(); controller.abort()
  await assert.rejects(f.ranges.derive('alice', 'doc', parent.refId, 'text', controller.signal, f.freshSource),
    { name: 'AbortError' })
  await assert.rejects(f.ranges.readEvidence('alice', 'doc', parent.refId, signal,
    async () => ({ path: '/book.pdf', digest: evidenceSha256('external overwrite') })), { code: 'pdf/stale-reader' })
})
