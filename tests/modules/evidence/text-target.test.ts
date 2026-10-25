import assert from 'node:assert/strict'
import test from 'node:test'
import { createEvidenceReader, createTextReferenceResolver, evidenceSha256,
  type SavedReference, type EvidenceReferenceStore } from '../../../src/modules/evidence/index.ts'
import type { HostWorkspaceSnapshot } from '../../../src/modules/working-copy/index.ts'
import type { NativeTextContent } from '../../../src/shared/native.ts'
import { joinPageText } from '../../../src/shared/page-text.ts'

const signal = new AbortController().signal
const quote = 'Repeated evidence'
function line(str: string, y: number, hasEOL = true): NativeTextContent['items'][number] {
  return { str, transform: [12, 0, 0, 12, 60, y], width: Array.from(str).length * 6,
    height: 12, dir: 'ltr', fontName: 'test', hasEOL,
    glyphs: Array.from(str, (_, index) => [60 + index * 6, y, 6]) }
}
async function fixture() {
  let current: HostWorkspaceSnapshot = { id: 'doc-1', path: '/paper.pdf', bytes: Buffer.from('source'),
    sourceVersion: 'fs-v1', contentVersion: 'content-v1', revision: 0, conflict: false,
    dirty: false, canUndo: false, canRedo: false,
    document: { pageCount: 1, pages: [{ cropBox: [0, 0, 600, 800] }] } as HostWorkspaceSnapshot['document'] }
  let content: NativeTextContent = { items: [line(quote, 200), line(quote, 100, false)],
    styles: { test: { fontFamily: 'sans-serif', ascent: 0.8, descent: -0.2, vertical: false } }, lang: null }
  let source = current.bytes
  let onRead: (() => void) | undefined, onSource: (() => void) | undefined
  const workspaces = { readSnapshot(sessionId: string, documentId: string) {
    if (sessionId !== 'alice' || documentId !== current.id) {
      throw Object.assign(new Error('Not owned by this session'), { code: 'pdf/session-mismatch' })
    }
    return current
  } }
  const pages = { async readPageText(sessionId: string, documentId: string, page: number, inputSignal: AbortSignal) {
    inputSignal.throwIfAborted()
    assert.equal(page, 1)
    const snapshot = workspaces.readSnapshot(sessionId, documentId)
    onRead?.()
    return { snapshot, content }
  } }
  const records = new Map<string, SavedReference>()
  const references: EvidenceReferenceStore = { get: key => records.get(key),
    async put(key, value) { records.set(key, value) }, async delete(key) { records.delete(key) },
    async deleteSession() { records.clear() } }
  const reader = createEvidenceReader(workspaces, pages, references)
  const located = await reader.locate('alice', { documentId: current.id, quote }, signal)
  const resolver = createTextReferenceResolver(workspaces, pages, references)
  const readSource = async (sessionId: string, snapshot: HostWorkspaceSnapshot, inputSignal: AbortSignal) => {
    inputSignal.throwIfAborted()
    assert.equal(sessionId, 'alice')
    const digest = evidenceSha256(source)
    onSource?.()
    return { path: snapshot.path, digest }
  }
  return { resolver, reader, workspaces, pages, references, records,
    first: located.matches[0]!.evidence.refId, second: located.matches[1]!.evidence.refId,
    current: () => current, readSource,
    update(patch: Partial<HostWorkspaceSnapshot>) { current = { ...current, ...patch } },
    source(value: Uint8Array) { source = value },
    content: () => content, setContent(value: NativeTextContent) { content = value },
    onRead(value: () => void) { onRead = value }, onSource(value: () => void) { onSource = value },
  }
}

test('saved offsets resolve the exact repeated occurrence, ignoring stored approximate rectangles', async () => {
  const f = await fixture()
  const stored = f.records.get(f.second)!
  if (stored.evidence.source !== 'pdf-text') assert.fail('Expected text evidence')
  stored.evidence.locator.rectsPdf = [[1, 1, 500, 500]]
  const first = await f.resolver.resolve('alice', 'doc-1', f.first, signal, f.readSource)
  const second = await f.resolver.resolve('alice', 'doc-1', f.second, signal, f.readSource)
  assert.deepEqual(first.rectPdf, [60, 197.6, 162, 209.6])
  assert.deepEqual(second.rectPdf, [60, 97.6, 162, 109.6])
  assert.equal(second.startUtf16, quote.length + 1)
  assert.equal(second.endUtf16, quote.length * 2 + 1)
  assert.equal(second.text, quote)
  assert.equal(second.textSha256, evidenceSha256(quote))
  assert.equal(second.pageTextDigest, evidenceSha256(`${quote}\n${quote}`))
  assert.equal(second.quadPoints.length, 8)
})

test('subquotes resolve only inside their reference and retain the original occurrence and parent snapshot', async () => {
  const f = await fixture()
  const second = await f.resolver.resolve('alice', 'doc-1', f.second, signal, f.readSource, 'evidence')
  assert.equal(second.startUtf16, quote.length + 1 + 'Repeated '.length)
  assert.equal(second.endUtf16, quote.length * 2 + 1)
  assert.equal(second.text, 'evidence')
  assert.equal(second.textSha256, evidenceSha256('evidence'))
  assert.deepEqual(second.rectPdf, [114, 97.6, 162, 109.6])
  const parent = await f.resolver.resolve('alice', 'doc-1', f.second, signal)
  assert.equal(parent.text, quote)
  await assert.rejects(f.resolver.resolve('alice', 'doc-1', f.second, signal, undefined,
    'evidence\nRepeated'), { code: 'pdf/text-not-found' })
  await assert.rejects(f.resolver.resolve('alice', 'doc-1', f.second, signal, undefined, ' \n'),
    { code: 'pdf/invalid-text-range' })
})

test('reference subquotes reject ambiguous occurrences and still validate the full original page', async () => {
  const f = await fixture()
  const context = await f.reader.context('alice', { documentId: 'doc-1',
    focus: { kind: 'page-window', page: 1 }, maxPages: 1 }, signal)
  const refId = context.chunks[0]!.evidence.refId
  await assert.rejects(f.resolver.resolve('alice', 'doc-1', refId, signal, undefined, 'evidence'),
    { code: 'pdf/ambiguous-text-target' })
  f.setContent({ ...f.content(), items: [line('Changed elsewhere on the page', 200), line(quote, 100, false)] })
  await assert.rejects(f.resolver.resolve('alice', 'doc-1', f.second, signal, f.readSource, 'evidence'),
    { code: 'pdf/stale-reader' })
})

test('annotation-only revisions and saves revalidate the whole page rather than invalidating a correct quote', async () => {
  const f = await fixture()
  const updated = Buffer.from('source with annotation-only changes')
  f.update({ revision: 2, contentVersion: 'content-v2', sourceVersion: 'fs-v2', bytes: updated })
  f.source(updated)
  const result = await f.resolver.resolve('alice', 'doc-1', f.second, signal, f.readSource)
  assert.equal(result.revision, 2)
  assert.equal(result.contentVersion, 'content-v2')
  assert.equal(result.sourceVersion, 'fs-v2')
  assert.equal(result.sourceDigest, evidenceSha256(updated))
  f.setContent({ ...f.content(), items: [line('Different introduction', 240), ...f.content().items] })
  await assert.rejects(f.resolver.resolve('alice', 'doc-1', f.second, signal, f.readSource),
    { code: 'pdf/stale-reader' })
})

test('references are not access grants: cross-session/path refs fail, authorized same-path reopen can revalidate', async () => {
  const f = await fixture()
  await assert.rejects(f.resolver.resolve('bob', 'doc-1', f.first, signal), { code: 'pdf/reference-unavailable' })
  await assert.rejects(f.resolver.resolve('alice', 'another-doc', f.first, signal), { code: 'pdf/session-mismatch' })
  f.update({ id: 'reopened' })
  assert.equal((await f.resolver.resolve('alice', 'reopened', f.first, signal, f.readSource)).documentId, 'reopened')
  f.update({ path: '/another.pdf' })
  await assert.rejects(f.resolver.resolve('alice', 'reopened', f.first, signal), { code: 'pdf/reference-unavailable' })
  await assert.rejects(f.resolver.resolve('alice', 'reopened', 'missing', signal), { code: 'pdf/reference-unavailable' })
})

test('stored snapshot, offset and digest tampering is rejected before any geometry is trusted', async () => {
  for (const mutate of [
    (saved: Extract<SavedReference, { pageTextDigest: string }>) => { saved.evidence.snapshot.sha256 = evidenceSha256('other') },
    (saved: Extract<SavedReference, { pageTextDigest: string }>) => { saved.evidence.locator.endUtf16++ },
    (saved: Extract<SavedReference, { pageTextDigest: string }>) => { saved.evidence.pageTextDigest = evidenceSha256('other') },
  ]) {
    const f = await fixture(), record = f.records.get(f.first)!
    if (!('pageTextDigest' in record)) assert.fail('Expected text evidence')
    mutate(record)
    await assert.rejects(f.resolver.resolve('alice', 'doc-1', f.first, signal), { code: 'pdf/invalid-evidence' })
  }
  const f = await fixture(), record = f.records.get(f.first)!
  record.evidence.refId = f.second
  await assert.rejects(f.resolver.resolve('alice', 'doc-1', f.first, signal), { code: 'pdf/reference-unavailable' })
})

test('text targeting rejects missing, invalid and OCR-derived glyph geometry, including an invalid middle glyph', async () => {
  for (const mode of ['stored-ocr', 'native-ocr', 'missing', 'invalid-middle', 'outside-crop'] as const) {
    const f = await fixture()
    const content = f.content()
    if (mode === 'stored-ocr') {
      const record = f.records.get(f.first)!
      if (record.evidence.source !== 'pdf-text') assert.fail('Expected text evidence')
      record.evidence.extraction = 'local-ocr'
    } else if (mode === 'native-ocr') f.setContent({ ...content, extraction: 'local-ocr' })
    else if (mode === 'missing') content.items[0]!.glyphs = undefined
    else if (mode === 'invalid-middle') content.items[0]!.glyphs![5]![2] = 0
    else f.update({ document: { ...f.current().document, pages: [{ ...f.current().document.pages[0]!, cropBox: [0, 0, 10, 10] }] } })
    await assert.rejects(f.resolver.resolve('alice', 'doc-1', f.first, signal), { code: 'pdf/text-geometry-unavailable' })
  }
})

test('surrogate halves and cross-column offset ranges cannot produce a false precise target', async () => {
  const f = await fixture()
  const content = { ...f.content(), items: [line('A𝑅B', 200, false)] }
  f.setContent(content)
  const record = f.records.get(f.first)!
  if (!('pageTextDigest' in record)) assert.fail('Expected text evidence')
  record.pageTextDigest = evidenceSha256('A𝑅B')
  record.evidence.pageTextDigest = record.pageTextDigest
  record.evidence.snapshot = { text: '\ud835', sha256: evidenceSha256('\ud835') }
  record.evidence.locator = { kind: 'text-window', startUtf16: 1, endUtf16: 2 }
  await assert.rejects(f.resolver.resolve('alice', 'doc-1', f.first, signal), { code: 'pdf/invalid-text-range' })
  record.evidence.snapshot = { text: 'A𝑅B', sha256: evidenceSha256('A𝑅B') }
  record.evidence.locator = { kind: 'text-window', startUtf16: 0, endUtf16: 4 }
  for (const partial of ['A𝑅B'.slice(0, 2), 'A𝑅B'.slice(2)]) {
    await assert.rejects(f.resolver.resolve('alice', 'doc-1', f.first, signal, undefined, partial),
      { code: 'pdf/invalid-text-range' })
  }
  const scalar = await f.resolver.resolve('alice', 'doc-1', f.first, signal, undefined, '𝑅')
  assert.equal(scalar.startUtf16, 1)
  assert.equal(scalar.endUtf16, 3)
  assert.equal(scalar.text, '𝑅')
  const columns: NativeTextContent = { ...content, items: [line('Start', 300), line('Column one', 100),
    { ...line('Column two', 300), transform: [12, 0, 0, 12, 300, 300] }] }
  f.setContent(columns)
  const text = joinPageText(columns.items)
  record.pageTextDigest = evidenceSha256(text)
  record.evidence.pageTextDigest = record.pageTextDigest
  record.evidence.snapshot = { text, sha256: evidenceSha256(text) }
  record.evidence.locator = { kind: 'text-window', startUtf16: 0, endUtf16: text.length }
  await assert.rejects(f.resolver.resolve('alice', 'doc-1', f.first, signal), { code: 'pdf/ambiguous-reading-order' })
})

test('external source changes, conflicts, removed pages and in-flight snapshot races fail closed', async () => {
  for (const kind of ['source', 'conflict', 'page', 'revision', 'content', 'path', 'source-version'] as const) {
    const f = await fixture()
    if (kind === 'source') f.source(Buffer.from('external overwrite'))
    else if (kind === 'conflict') f.update({ conflict: true })
    else if (kind === 'page') f.update({ document: { ...f.current().document, pageCount: 0 } })
    else f.onRead(() => f.update(kind === 'revision' ? { revision: 1 }
      : kind === 'content' ? { contentVersion: 'changed' } : kind === 'path' ? { path: '/changed.pdf' }
      : { sourceVersion: 'changed' }))
    await assert.rejects(f.resolver.resolve('alice', 'doc-1', f.first, signal, f.readSource), { code: 'pdf/stale-reader' })
  }
  const f = await fixture()
  let checks = 0
  f.onSource(() => { if (++checks === 1) f.source(Buffer.from('external overwrite after first check')) })
  await assert.rejects(f.resolver.resolve('alice', 'doc-1', f.first, signal, f.readSource), { code: 'pdf/stale-reader' })
  assert.equal(checks, 2)
})

test('cancellation before and during text extraction or disk validation never resolves a target', async () => {
  for (const phase of ['before', 'read', 'source'] as const) {
    const f = await fixture(), controller = new AbortController()
    if (phase === 'before') controller.abort()
    else if (phase === 'read') f.onRead(() => controller.abort())
    else f.onSource(() => controller.abort())
    await assert.rejects(f.resolver.resolve('alice', 'doc-1', f.first, controller.signal, f.readSource),
      { name: 'AbortError' })
  }
})
