import assert from 'node:assert/strict'
import test from 'node:test'
import { evidenceNavigationRequestSchema, evidenceSha256,
  createMemoryEvidenceReferenceStore, revalidateEvidenceNavigation } from '../../../src/modules/evidence/index.ts'
import type { AgentPageReadPort } from '../../../src/modules/evidence/index.ts'
import type { HostWorkspaceSnapshot, WorkingCopyReadPort } from '../../../src/modules/working-copy/index.ts'

const text = 'A useful sentence about the result.'
const startUtf16 = 2
const excerpt = 'useful sentence'
const sourcePath = '/papers/result.pdf'
const sessionId = 'reader-session'
const documentId = 'working-copy'
const signal = new AbortController().signal
const content = { items: [{ str: text, transform: [1, 0, 0, 1, 0, 0], width: 100,
  height: 10, dir: 'ltr', fontName: 'Helvetica', hasEOL: false }], styles: {}, lang: null }

function snapshot(bytes: number[], revision: number, path = sourcePath): HostWorkspaceSnapshot {
  return { id: documentId, path, bytes: new Uint8Array(bytes), revision,
    contentVersion: 'new-occurrence', sourceVersion: `source-${revision}`,
    document: { pageCount: 1 } } as HostWorkspaceSnapshot
}

const request = evidenceNavigationRequestSchema.parse({ action: 'revalidate', sessionId, documentId,
  sourcePathDigest: evidenceSha256(sourcePath), page: 1, pageTextDigest: evidenceSha256(text),
  startUtf16, endUtf16: startUtf16 + excerpt.length, excerpt,
  excerptSha256: evidenceSha256(excerpt) })
const ocrRequest = { ...request, extraction: 'local-ocr' as const }

function harness(initial: HostWorkspaceSnapshot, pageText: typeof content & { extraction?: 'local-ocr' } = content) {
  let current = initial
  let sourceBytes = initial.bytes
  const workspaces: WorkingCopyReadPort = { readSnapshot(caller, id) {
    if (caller !== sessionId || id !== documentId) throw new Error('Working copy belongs to another session')
    return current
  } }
  const pages: AgentPageReadPort = { async readPageText(caller, id) {
    workspaces.readSnapshot(caller, id)
    return { snapshot: current, content: pageText as never }
  } }
  const readSource = async (caller: string, observed: HostWorkspaceSnapshot, currentSignal: AbortSignal) => {
    currentSignal.throwIfAborted()
    assert.equal(caller, sessionId)
    return { path: observed.path, digest: evidenceSha256(sourceBytes) }
  }
  return { workspaces, pages, readSource,
    set(value: HostWorkspaceSnapshot) { current = value; sourceBytes = value.bytes },
    overwriteSource() { sourceBytes = new Uint8Array([1, 2, 3, 4]) },
  }
}

test('tool-card revalidation permits an annotation-only save after reopening the same text', async () => {
  const h = harness(snapshot([9, 8, 7], 4))
  const first = await revalidateEvidenceNavigation(h.workspaces, h.pages, request, signal, h.readSource)
  assert.equal(first.status, 'valid')
  h.set(snapshot([9, 8, 7, 6], 5))
  const afterSave = await revalidateEvidenceNavigation(h.workspaces, h.pages, request, signal, h.readSource)
  assert.equal(afterSave.status, 'valid')
  assert.notEqual(first.sourceDigest, afterSave.sourceDigest)
  assert.equal(afterSave.revision, 5)
})

test('revalidation rejects a changed path or page text even if the short excerpt survives', async () => {
  const h = harness(snapshot([9, 8, 7], 4))
  h.set(snapshot([9, 8, 7], 4, '/papers/other.pdf'))
  await assert.rejects(revalidateEvidenceNavigation(h.workspaces, h.pages, request, signal, h.readSource),
    { code: 'pdf/stale-reader' })
  const changed = harness(snapshot([9, 8, 7], 4), { ...content,
    items: [{ ...content.items[0], str: `${text} Additional text.` }] })
  await assert.rejects(revalidateEvidenceNavigation(changed.workspaces, changed.pages, request, signal,
    changed.readSource),
    { code: 'pdf/stale-reader' })
})

test('revalidation is session-fenced and rejects a concurrent source change', async () => {
  const h = harness(snapshot([9, 8, 7], 4))
  await assert.rejects(revalidateEvidenceNavigation(h.workspaces, h.pages,
    { ...request, sessionId: 'another-session' }, signal, h.readSource), /another session/)
  const pages: AgentPageReadPort = { async readPageText() {
    const old = h.workspaces.readSnapshot(sessionId, documentId)
    h.set(snapshot([1, 2, 3], 5))
    return { snapshot: old, content: content as never }
  } }
  await assert.rejects(revalidateEvidenceNavigation(h.workspaces, pages, request, signal, h.readSource),
    { code: 'pdf/stale-reader' })
})

test('text navigation rejects an external overwrite without reopening the working copy', async () => {
  const h = harness(snapshot([9, 8, 7], 4))
  assert.equal((await revalidateEvidenceNavigation(h.workspaces, h.pages, request, signal,
    h.readSource)).status, 'valid')
  h.overwriteSource()
  await assert.rejects(revalidateEvidenceNavigation(h.workspaces, h.pages, request, signal,
    h.readSource), { code: 'pdf/stale-reader' })
  assert.equal(h.workspaces.readSnapshot(sessionId, documentId).revision, 4)
})

test('text navigation rejects a concurrent external overwrite and respects cancellation', async () => {
  const h = harness(snapshot([9, 8, 7], 4))
  let checks = 0
  const readSource: typeof h.readSource = async (...args) => {
    checks++
    if (checks === 2) h.overwriteSource()
    return h.readSource(...args)
  }
  await assert.rejects(revalidateEvidenceNavigation(h.workspaces, h.pages, request, signal,
    readSource), { code: 'pdf/stale-reader' })
  assert.equal(checks, 2)
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(revalidateEvidenceNavigation(h.workspaces, h.pages, request,
    cancelled.signal, h.readSource), /abort/i)
  const inFlight = new AbortController()
  await assert.rejects(revalidateEvidenceNavigation(h.workspaces, h.pages, request,
    inFlight.signal, async (...args) => {
      inFlight.abort()
      return h.readSource(...args)
    }), /abort/i)
})

test('navigation request bounds the excerpt and requires exact UTF-16 span', () => {
  assert.equal(evidenceNavigationRequestSchema.safeParse({ ...request, endUtf16: 900 }).success, false)
  assert.equal(evidenceNavigationRequestSchema.safeParse({ ...request, excerpt: 'x'.repeat(8001) }).success, false)
})

test('historical cards reissue the same exact native target contract as tool references', async () => {
  const state = snapshot([9, 8, 7], 4)
  state.document.pages = [{ page: 1, cropBox: [0, 0, 300, 400], rotation: 0, userUnit: 1 }]
  const pageText = { ...content, items: [{ ...content.items[0]!, transform: [10, 0, 0, 10, 20, 200],
    glyphs: Array.from(text, (_, index) => [20 + index * 5, 200, 5]) }] }
  const h = harness(state, pageText)
  const references = createMemoryEvidenceReferenceStore()
  const value = await revalidateEvidenceNavigation(h.workspaces, h.pages, request, signal, h.readSource, references)
  assert.equal(value.target?.kind, 'text')
  assert.equal(value.target?.revision, state.revision)
  assert.equal(value.target?.startUtf16, startUtf16)
  assert.equal(value.target?.endUtf16, startUtf16 + excerpt.length)
  assert.equal(value.target?.textSha256, evidenceSha256(excerpt))
  assert.deepEqual(value.target?.rectPdf, [30, 198, 105, 208])
  assert.equal(value.target?.sourceDigest, value.sourceDigest)
  assert.ok(references.get(value.target!.refId))
})

test('production historical-card navigation never falls back to approximate boxes without native glyphs', async () => {
  const state = snapshot([9, 8, 7], 4)
  state.document.pages = [{ page: 1, cropBox: [0, 0, 300, 400], rotation: 0, userUnit: 1 }]
  const h = harness(state)
  await assert.rejects(revalidateEvidenceNavigation(h.workspaces, h.pages, request, signal,
    h.readSource, createMemoryEvidenceReferenceStore()), { code: 'pdf/text-geometry-unavailable' })
})

test('local OCR cards retain their representation and navigate page-only without native geometry', async () => {
  const state = snapshot([9, 8, 7], 4)
  const h = harness(state, { ...content, extraction: 'local-ocr' as const })
  const references = createMemoryEvidenceReferenceStore()
  let writes = 0
  references.put = async () => { writes++ }
  // The marker selects OCR; current Host extraction and source bytes must
  // still attest to it, and no card marker grants native geometry.
  const value = await revalidateEvidenceNavigation(h.workspaces, h.pages,
    { ...ocrRequest, sourceDigest: evidenceSha256(state.bytes) }, signal, h.readSource, references)
  assert.equal(value.status, 'valid')
  assert.equal(value.page, 1)
  assert.equal(value.target, undefined)
  assert.equal(writes, 0, 'page-only replay never mints a native-geometry reference')
  assert.equal(evidenceNavigationRequestSchema.safeParse({ ...request,
    sourceDigest: evidenceSha256(state.bytes), source: 'pdf-text', precision: 'exact-text' }).success, false)
})

test('OCR cards reject missing, forged or obsolete source digests even when the complete text matches', async () => {
  const state = snapshot([9, 8, 7], 4)
  const h = harness(state, { ...content, extraction: 'local-ocr' as const })
  for (const value of [ocrRequest, { ...ocrRequest, sourceDigest: evidenceSha256('forged source') }]) {
    await assert.rejects(revalidateEvidenceNavigation(h.workspaces, h.pages, value, signal, h.readSource,
      createMemoryEvidenceReferenceStore()), { code: 'pdf/stale-reader' })
  }
  h.set(snapshot([9, 8, 7, 6], 5))
  await assert.rejects(revalidateEvidenceNavigation(h.workspaces, h.pages,
    { ...ocrRequest, sourceDigest: evidenceSha256(state.bytes) }, signal, h.readSource,
    createMemoryEvidenceReferenceStore()), { code: 'pdf/stale-reader' })
  h.overwriteSource()
  await assert.rejects(revalidateEvidenceNavigation(h.workspaces, h.pages,
    { ...ocrRequest, sourceDigest: evidenceSha256(new Uint8Array([9, 8, 7, 6])) }, signal, h.readSource),
    { code: 'pdf/stale-reader' })
})

test('legacy native cards retain precise annotation-only revalidation with or without an old source digest', async () => {
  const state = snapshot([9, 8, 7], 4)
  state.document.pages = [{ page: 1, cropBox: [0, 0, 300, 400], rotation: 0, userUnit: 1 }]
  const pageText = { ...content, items: [{ ...content.items[0]!, transform: [10, 0, 0, 10, 20, 200],
    glyphs: Array.from(text, (_, index) => [20 + index * 5, 200, 5]) }] }
  const h = harness(state, pageText)
  const references = createMemoryEvidenceReferenceStore()
  assert.equal((await revalidateEvidenceNavigation(h.workspaces, h.pages, request, signal, h.readSource,
    references)).target?.kind, 'text')
  h.set({ ...state, bytes: new Uint8Array([9, 8, 7, 6]), revision: 5, sourceVersion: 'source-5' })
  const value = await revalidateEvidenceNavigation(h.workspaces, h.pages,
    { ...request, sourceDigest: evidenceSha256(state.bytes) }, signal, h.readSource, references)
  assert.equal(value.target?.kind, 'text')
  assert.equal(value.revision, 5)
  assert.equal(value.sourceDigest, evidenceSha256(new Uint8Array([9, 8, 7, 6])))
})

test('OCR card replay rejects Unicode halves and a source-check race before a page-only result escapes', async () => {
  const state = snapshot([9, 8, 7], 4)
  const unicodeText = 'A😀B', partial = unicodeText.slice(1, 2)
  const h = harness(state, { ...content, extraction: 'local-ocr' as const,
    items: [{ ...content.items[0]!, str: unicodeText }] })
  await assert.rejects(revalidateEvidenceNavigation(h.workspaces, h.pages, { ...ocrRequest,
    sourceDigest: evidenceSha256(state.bytes), pageTextDigest: evidenceSha256(unicodeText),
    startUtf16: 1, endUtf16: 2, excerpt: partial, excerptSha256: evidenceSha256(partial) }, signal, h.readSource),
  { code: 'pdf/stale-reader' })
  const race = harness(state, { ...content, extraction: 'local-ocr' as const })
  let checks = 0
  await assert.rejects(revalidateEvidenceNavigation(race.workspaces, race.pages,
    { ...ocrRequest, sourceDigest: evidenceSha256(state.bytes) }, signal, async (...args) => {
      const result = await race.readSource(...args)
      if (++checks === 2) race.set({ ...state, conflict: true })
      return result
    }), { code: 'pdf/stale-reader' })
})

test('historical native and OCR cards use distinct text representations on a recoverable page', async () => {
  const state = snapshot([9, 8, 7], 4)
  state.document.pages = [{ page: 1, cropBox: [0, 0, 300, 400], rotation: 0, userUnit: 1 }]
  const raw = { ...content, items: [{ ...content.items[0]!, transform: [10, 0, 0, 10, 20, 200],
    glyphs: Array.from(text, (_, index) => [20 + index * 5, 200, 5] as [number, number, number]) }] }
  const h = harness(state, raw), reads: boolean[] = []
  const recoveredText = `${text} OCR-only text.`
  const pages: AgentPageReadPort = { async readPageText(owner, id, page, abort, options) {
    abort.throwIfAborted()
    assert.equal(page, 1)
    reads.push(options?.recover !== false)
    const read = await h.pages.readPageText(owner, id, page, abort)
    return options?.recover === false ? read : { snapshot: read.snapshot, content: {
      ...raw, extraction: 'local-ocr', items: [{ ...raw.items[0]!, str: recoveredText }] } }
  } }
  const references = createMemoryEvidenceReferenceStore()
  const native = await revalidateEvidenceNavigation(h.workspaces, pages, request, signal, h.readSource, references)
  assert.equal(native.target?.kind, 'text')
  assert.ok(reads.every(recover => recover === false), 'native replay and its precise resolver both remain raw')
  const ocr = { ...ocrRequest, sourceDigest: evidenceSha256(state.bytes), pageTextDigest: evidenceSha256(recoveredText) }
  const derived = await revalidateEvidenceNavigation(h.workspaces, pages, ocr, signal, h.readSource, references)
  assert.equal(derived.target, undefined)
  assert.equal(reads.at(-1), true)
  // A legacy OCR card without its extraction marker never triggers OCR or
  // silently turns its snapshot into native-position authorization.
  const { extraction: _legacyMarker, ...legacyOcr } = ocr
  await assert.rejects(revalidateEvidenceNavigation(h.workspaces, pages, legacyOcr, signal, h.readSource, references),
    { code: 'pdf/stale-reader' })
  assert.equal(reads.at(-1), false)
  await assert.rejects(revalidateEvidenceNavigation(h.workspaces, h.pages, ocrRequest, signal, h.readSource, references),
    { code: 'pdf/stale-reader' })
  await assert.rejects(revalidateEvidenceNavigation(h.workspaces, h.pages,
    { ...ocrRequest, sourceDigest: evidenceSha256(state.bytes) }, signal, h.readSource, references),
    { code: 'pdf/text-representation-unavailable' })
})

test('historical-card navigation retries if the draft changes while its new reference is persisted', async () => {
  const state = snapshot([9, 8, 7], 4)
  state.document.pages = [{ page: 1, cropBox: [0, 0, 300, 400], rotation: 0, userUnit: 1 }]
  const pageText = { ...content, items: [{ ...content.items[0]!, transform: [10, 0, 0, 10, 20, 200],
    glyphs: Array.from(text, (_, index) => [20 + index * 5, 200, 5]) }] }
  const h = harness(state, pageText)
  const references = createMemoryEvidenceReferenceStore()
  const put = references.put
  let edited = false
  references.put = async (id, value) => {
    await put(id, value)
    if (!edited) {
      edited = true
      h.set({ ...state, revision: 5 })
    }
  }
  await assert.rejects(revalidateEvidenceNavigation(h.workspaces, h.pages, request, signal,
    h.readSource, references), { code: 'pdf/stale-reader', message: 'PDF changed while preparing the reference; retry' })
  const retried = await revalidateEvidenceNavigation(h.workspaces, h.pages, request, signal,
    h.readSource, references)
  assert.equal(retried.status, 'valid')
  assert.equal(retried.revision, 5)
  assert.equal(retried.target?.revision, 5, 'a retry must pair the target with the current draft revision')
})
