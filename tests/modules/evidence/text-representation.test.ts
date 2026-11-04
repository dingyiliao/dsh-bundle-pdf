import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryEvidenceReferenceStore, createTextRangeReferences, createTextReferenceResolver,
  describeEvidenceCapabilities, evidenceSha256, rememberTextEvidence } from '../../../src/modules/evidence/index.ts'
import type { AgentPageReadPort } from '../../../src/modules/evidence/agent-page-read.ts'
import type { HostWorkspaceSnapshot } from '../../../src/modules/working-copy/index.ts'
import type { NativeTextContent } from '../../../src/shared/native.ts'

const signal = new AbortController().signal
function positioned(text: string, extraction?: 'local-ocr'): NativeTextContent {
  return { items: [{ str: text, hasEOL: false, dir: 'ltr', fontName: 'test', height: 12,
    transform: [12, 0, 0, 12, 20, 200], width: Array.from(text).length * 5,
    glyphs: Array.from(text, (_, index) => [20 + index * 5, 200, 5]) }], styles: {}, lang: null,
    ...(extraction ? { extraction } : { quality: { unmappedCharacters: 1 } }) }
}

function fixture() {
  let snapshot = { id: 'doc', path: '/book.pdf', bytes: Buffer.from('PDF source'), sourceVersion: 'fs-1',
    contentVersion: 'content-1', revision: 0, conflict: false, dirty: false, canUndo: false, canRedo: false,
    document: { pageCount: 1, pages: [{ cropBox: [0, 0, 600, 800] }] } as HostWorkspaceSnapshot['document'] }
  const raw = positioned('prefix Native 😀\ntext suffix')
  let recovered = positioned('prefix OCR 😀\ntext suffix', 'local-ocr')
  let recoverAvailable = true
  const reads: boolean[] = []
  const workspaces = { readSnapshot(owner: string, id: string) {
    if (owner !== 'alice' || id !== snapshot.id) throw Object.assign(new Error('Foreign document'), { code: 'pdf/session-mismatch' })
    return snapshot
  } }
  const pages: AgentPageReadPort = { async readPageText(owner, id, _page, abort, options) {
    abort.throwIfAborted()
    reads.push(options?.recover !== false)
    return { snapshot: workspaces.readSnapshot(owner, id),
      content: options?.recover === false || !recoverAvailable ? raw : recovered }
  } }
  const references = createMemoryEvidenceReferenceStore()
  const mint = (extraction?: 'local-ocr') => {
    const content = extraction ? recovered : raw
    return rememberTextEvidence(references, 'alice', snapshot, 1, content.items[0]!.str,
      'prefix '.length, content.items[0]!.str.indexOf(' suffix'), content)
  }
  return { raw, pages, reads, references, mint,
    ranges: createTextRangeReferences(workspaces, pages, references),
    resolver: createTextReferenceResolver(workspaces, pages, references),
    freshSource: async () => ({ path: snapshot.path, digest: evidenceSha256(snapshot.bytes) }),
    disableRecovery() { recoverAvailable = false },
    makeRecoveredEqualRaw() { recovered = { ...raw, extraction: 'local-ocr' } },
    replaceSource() { snapshot = { ...snapshot, bytes: Buffer.from('replaced PDF'), sourceVersion: 'fs-2', revision: 1 } },
  }
}

test('native evidence read, derive, capture and precise resolution remain on raw text when page defaults to OCR', async () => {
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
  assert.ok(f.reads.length >= 5)
  assert.ok(f.reads.every(recover => recover === false), 'even the derivation second read must avoid default OCR')
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

test('OCR references stay on their own representation and never upgrade to identical native wording', async () => {
  const f = fixture()
  f.makeRecoveredEqualRaw()
  const parent = await f.mint('local-ocr')
  const read = await f.ranges.readEvidence('alice', 'doc', parent.refId, signal, f.freshSource)
  assert.equal(read.pages[0]!.extraction, 'local-ocr')
  const child = await f.ranges.derive('alice', 'doc', parent.refId, 'Native 😀 text', signal,
    f.freshSource, 'whitespace-normalized')
  assert.equal(child.pages[0]!.extraction, 'local-ocr')
  assert.equal(child.pages[0]!.locator.rectsPdf, undefined)
  const target = await f.resolver.resolvePage('alice', 'doc', child.refId, signal, f.freshSource)
  assert.equal(target.precision, 'page-only')
  assert.equal('quadPoints' in target, false)
  await assert.rejects(f.resolver.resolve('alice', 'doc', child.refId, signal, f.freshSource),
    { code: 'pdf/text-geometry-unavailable' })
  assert.ok(f.reads.every(recover => recover === true))
  f.disableRecovery()
  await assert.rejects(f.ranges.readEvidence('alice', 'doc', parent.refId, signal, f.freshSource),
    { code: 'pdf/text-representation-unavailable' })
  await assert.rejects(f.resolver.resolvePage('alice', 'doc', child.refId, signal, f.freshSource),
    { code: 'pdf/text-representation-unavailable' })
})

test('bound native and OCR reads retain source/session/cancellation checks', async () => {
  for (const extraction of [undefined, 'local-ocr'] as const) {
    const f = fixture(), parent = await f.mint(extraction)
    await assert.rejects(f.ranges.readEvidence('bob', 'doc', parent.refId, signal, f.freshSource),
      { code: 'pdf/reference-unavailable' })
    const controller = new AbortController(); controller.abort()
    await assert.rejects(f.ranges.derive('alice', 'doc', parent.refId, 'text', controller.signal, f.freshSource),
      { name: 'AbortError' })
    await assert.rejects(f.ranges.readEvidence('alice', 'doc', parent.refId, signal,
      async () => ({ path: '/book.pdf', digest: evidenceSha256('external overwrite') })), { code: 'pdf/stale-reader' })
    if (extraction) {
      f.replaceSource()
      await assert.rejects(f.ranges.readEvidence('alice', 'doc', parent.refId, signal, f.freshSource),
        { code: 'pdf/stale-reader' })
    }
  }
})
