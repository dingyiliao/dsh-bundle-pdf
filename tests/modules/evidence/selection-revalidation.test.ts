import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { plainPdf } from '../../fixtures/plain-pdf.ts'
import { createMemoryEvidenceReferenceStore, evidenceSha256, prepareTextSelectionEvidence,
  revalidateTextSelectionEvidence, type AgentPageReadPort, type FreshSourceRead,
  type SelectionRevalidationRequest } from '../../../src/modules/evidence/index.ts'
import type { NativeTextContent } from '../../../src/shared/native.ts'
import { createPdfService } from '../../../src/adapters/host/pdfium/index.ts'
import { memoryWorkspace } from '../../native-fixture.ts'
import { nativeTestSubprocess } from '../../native-test-subprocess.ts'

const owner = 'selection-revalidation', path = '/fixtures/native.pdf'
const signal = new AbortController().signal
const agent = (sessionId = owner) => ({ session: { id: sessionId, header: {} } })
const originalTexts = ['First selected passage.', 'Second selected passage.']
const nativeExecutable = process.env.DSH_PDF_NATIVE_HELPER
  ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
if (process.env.DSH_PDF_REQUIRE_NATIVE_TESTS === '1' && !existsSync(nativeExecutable)) {
  throw new Error('Native selection revalidation tests require a built helper')
}

async function pdfBytes(texts = originalTexts) {
  return plainPdf(texts.map(text => ({ size: [300, 250], lines: [{ text, x: 40, y: 160, size: 12 }] })))
}

function content(text: string): NativeTextContent {
  const advance = Math.min(6, 200 / text.length)
  return { items: [{ str: text, transform: [12, 0, 0, 12, 40, 160], width: text.length * advance, height: 12,
    dir: 'ltr', fontName: 'fixture', hasEOL: false,
    glyphs: Array.from(text, (_, index) => [40 + index * advance, 160, advance]) }],
  styles: { fixture: { fontFamily: 'sans-serif', ascent: 0.8, descent: -0.2, vertical: false } }, lang: null }
}

async function fixture(native = false) {
  const state = memoryWorkspace(await pdfBytes()), references = createMemoryEvidenceReferenceStore()
  const opened = await state.workspaces.execute(owner, { action: 'open', sessionId: owner, owner: 'ui',
    address: `dsh-resource://file/session/${owner}//fixtures/native.pdf` }, agent(), signal)
  assert.ok('bytes' in opened)
  let texts = [...originalTexts]
  const pdf = native ? createPdfService(state.workspaces, { executable: nativeExecutable, subprocess: nativeTestSubprocess }) : undefined
  const pages: AgentPageReadPort = pdf ?? { async readPageText(sessionId, documentId, page, active, options) {
    active.throwIfAborted()
    assert.equal(options?.recover, false, 'saved native refs must not silently switch to OCR')
    return { snapshot: state.workspaces.readSnapshot(sessionId, documentId), content: content(texts[page - 1]!) }
  } }
  const readSource: FreshSourceRead = async (sessionId, snapshot, active) => {
    active.throwIfAborted()
    const source = await state.files.read(agent(sessionId), snapshot.path, active)
    return { path: source.path, digest: source.version }
  }
  // Capture exactly the source-bound references that the explanation editor saves.
  const captureReader: AgentPageReadPort = pdf ?? { async readPageText(sessionId, documentId, page, active) {
    active.throwIfAborted()
    return { snapshot: state.workspaces.readSnapshot(sessionId, documentId), content: content(texts[page - 1]!) }
  } }
  const captured = await prepareTextSelectionEvidence(state.workspaces, captureReader, references, {
    sessionId: owner, documentId: opened.id, expectedRevision: opened.revision,
    expectedContentVersion: opened.contentVersion, quote: texts.join('\n'),
    fragments: texts.map((_, index) => ({ page: index + 1, rect: [38, 156, 250, 174],
      quadPoints: [38, 174, 250, 174, 38, 156, 250, 156] })),
  }, signal, readSource)
  const current = () => state.workspaces.readSnapshot(owner, opened.id)
  const input = (): SelectionRevalidationRequest => ({ action: 'revalidate', sessionId: owner,
    documentId: opened.id, expectedRevision: current().revision, expectedContentVersion: current().contentVersion,
    selections: captured.excerpts.map((excerpt, index) => ({ id: `passage-${index}`, refIds: [excerpt.refId] })) })
  const revalidate = (request = input(), reader = pages, active = signal) =>
    revalidateTextSelectionEvidence(state.workspaces, reader, references, request, active, readSource)
  const change = () => state.workspaces.execute(owner, { action: 'change', sessionId: owner,
    id: opened.id, revision: current().revision, operations: [{ type: 'add', annotation: {
      id: `note-${current().revision}`, page: 1, subtype: 'Text', rect: [20, 20, 40, 40], contents: 'A normal PDF note',
    } }] }, agent(), signal)
  const save = () => state.workspaces.execute(owner, { action: 'save', sessionId: owner,
    id: opened.id, revision: current().revision, options: {} }, agent(), signal)
  return { state, references, captured, pages, readSource, current, input, revalidate, change, save,
    async replaceText() {
      texts = ['First changed passage.', originalTexts[1]!]
      await state.files.save(agent(), path, await pdfBytes(texts), evidenceSha256(state.current()))
      await state.workspaces.execute(owner, { action: 'reload', sessionId: owner, id: opened.id,
        revision: current().revision }, agent(), signal)
    },
    async dispose() { await pdf?.dispose(); await state.workspaces.dispose() },
  }
}

for (const native of [false, true]) test(`saved selections survive ordinary annotation edits and overwrite-save with ${native ? 'real PDFium glyphs' : 'a controlled glyph reader'}`,
  { skip: native && !existsSync(nativeExecutable) }, async () => {
    const f = await fixture(native)
    try {
      const old = f.current(), records = f.captured.excerpts.map(item => structuredClone(f.references.get(item.refId)))
      await f.change()
      const edited = await f.revalidate()
      assert.equal(edited.revision, old.revision + 1)
      assert.equal(edited.sourceDigest, evidenceSha256(old.bytes))
      assert.deepEqual(edited.selections.map(item => item.text), originalTexts)
      assert.ok(edited.selections.every(item => item.fragments[0]!.quadPoints.length > 0))
      assert.equal(f.current().dirty, true)
      await f.save()
      const saved = f.current(), result = await f.revalidate()
      assert.equal(result.revision, saved.revision)
      assert.equal(result.contentVersion, old.contentVersion)
      assert.equal(result.sourceDigest, evidenceSha256(saved.bytes))
      assert.notEqual(result.sourceDigest, evidenceSha256(old.bytes))
      assert.notEqual(result.sourceVersion, old.sourceVersion)
      assert.equal(f.current().dirty, false)
      assert.equal(f.state.writes(), 1, 'revalidation never edits or saves the PDF')
      assert.deepEqual(result.selections.map(item => item.evidenceRefs), f.input().selections.map(item => item.refIds))
      assert.deepEqual(f.captured.excerpts.map(item => f.references.get(item.refId)), records,
        'old references keep their original source, revision, geometry and IDs')
      const joined = await f.revalidate({ ...f.input(), selections: [{ id: 'cross-page',
        refIds: f.captured.excerpts.map(item => item.refId) }] })
      assert.equal(joined.selections[0]!.text, originalTexts.join('\n'))
      assert.deepEqual(joined.selections[0]!.fragments.map(item => item.page), [1, 2])
      await assert.rejects(f.revalidate({ ...f.input(), expectedRevision: old.revision }), { code: 'pdf/stale-reader' })
    } finally { await f.dispose() }
  })

test('a true text replacement, foreign session and foreign source path cannot reuse saved selections', async () => {
  const f = await fixture()
  try {
    const foreign = 'other-selection-session'
    const opened = await f.state.workspaces.execute(foreign, { action: 'open', sessionId: foreign,
      address: `dsh-resource://file/session/${foreign}//fixtures/native.pdf` }, agent(foreign), signal)
    assert.ok('bytes' in opened)
    await assert.rejects(f.revalidate({ ...f.input(), sessionId: foreign, documentId: opened.id,
      expectedRevision: opened.revision, expectedContentVersion: opened.contentVersion }), { code: 'pdf/reference-unavailable' })
    const wrongPath = { ...f.references, get(refId: string) {
      const record = structuredClone(f.references.get(refId))
      if (record) record.evidence.sourcePath = '/another.pdf'
      return record
    } }
    await assert.rejects(revalidateTextSelectionEvidence(f.state.workspaces, f.pages, wrongPath,
      f.input(), signal, f.readSource), { code: 'pdf/reference-unavailable' })
    await f.replaceText()
    await assert.rejects(f.revalidate(), { code: 'pdf/stale-reader' })
  } finally { await f.dispose() }
})

test('external overwrite without refreshing the working copy fails the fresh-source check', async () => {
  const f = await fixture()
  try {
    await f.state.files.save(agent(), path, await pdfBytes(['An external replacement', originalTexts[1]!]),
      evidenceSha256(f.state.current()))
    await assert.rejects(f.revalidate(), { code: 'pdf/stale-reader' })
  } finally { await f.dispose() }
})

test('a mutation between two saved selections rejects the whole batch and preserves the old records', async () => {
  const f = await fixture()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const readingSecond = new Promise<void>(resolve => { entered = resolve })
  let reads = 0
  const pages: AgentPageReadPort = { async readPageText(...args) {
    const result = await f.pages.readPageText(...args)
    if (++reads === 2) { entered(); await gate }
    return result
  } }
  const records = f.captured.excerpts.map(item => structuredClone(f.references.get(item.refId)))
  const pending = f.revalidate(f.input(), pages)
  const rejected = assert.rejects(pending, { code: 'pdf/stale-reader' })
  try {
    await readingSecond
    await f.change()
    release()
    await rejected
    assert.equal(f.current().dirty, true)
    assert.equal(f.state.writes(), 0)
    assert.deepEqual(f.captured.excerpts.map(item => f.references.get(item.refId)), records)
  } finally { release(); await pending.catch(() => {}); await f.dispose() }
})

test('cancellation before or during native reads never returns or rewrites a partial batch', async () => {
  const f = await fixture(), controller = new AbortController(), reason = new Error('cancel revalidation')
  try {
    const before = new AbortController(); before.abort(reason)
    await assert.rejects(f.revalidate(f.input(), f.pages, before.signal), error => error === reason)
    let calls = 0
    const pages: AgentPageReadPort = { async readPageText(...args) {
      const result = await f.pages.readPageText(...args)
      if (++calls === 2) controller.abort(reason)
      return result
    } }
    const records = f.captured.excerpts.map(item => structuredClone(f.references.get(item.refId)))
    await assert.rejects(f.revalidate(f.input(), pages, controller.signal), error => error === reason)
    assert.equal(f.current().revision, 0)
    assert.deepEqual(f.captured.excerpts.map(item => f.references.get(item.refId)), records)
  } finally { await f.dispose() }
})

test('the final batch source check still fences a draft edit or metadata-only filesystem refresh', async () => {
  for (const mutation of ['draft', 'filesystem-version'] as const) {
    const f = await fixture(), before = f.current()
    let pagesRead = 0, checksAfterLastPage = 0, changed = false
    const pages: AgentPageReadPort = { async readPageText(...args) {
      const read = await f.pages.readPageText(...args)
      pagesRead++
      return read
    } }
    const readSource: FreshSourceRead = async (...args) => {
      const source = await f.readSource(...args)
      // The first check after the final page belongs to that reference's own
      // resolver. Mutate during the subsequent whole-batch source check.
      if (pagesRead === 2 && ++checksAfterLastPage === 2) {
        changed = true
        if (mutation === 'draft') await f.change()
        else {
          await f.state.files.save(agent(), path, f.state.current(), evidenceSha256(f.state.current()))
          await f.state.workspaces.execute(owner, { action: 'open', sessionId: owner,
            address: `dsh-resource://file/session/${owner}//fixtures/native.pdf` }, agent(), signal)
        }
      }
      return source
    }
    try {
      await assert.rejects(revalidateTextSelectionEvidence(f.state.workspaces, pages, f.references,
        f.input(), signal, readSource), { code: 'pdf/stale-reader' })
      assert.equal(changed, true, 'the batch must verify its source after all references were resolved')
      if (mutation === 'filesystem-version') {
        assert.equal(f.current().revision, before.revision)
        assert.equal(f.current().bytes, before.bytes)
        assert.notEqual(f.current().sourceVersion, before.sourceVersion)
        // The next batch may use the new metadata version once it stays stable.
        assert.equal((await f.revalidate()).sourceVersion, f.current().sourceVersion)
      }
    } finally { await f.dispose() }
  }
})

test('missing glyphs and duplicate or descending pages cannot produce replacement selection geometry', async () => {
  const f = await fixture()
  try {
    const pages: AgentPageReadPort = { async readPageText(...args) {
      const read = await f.pages.readPageText(...args)
      return { ...read, content: { ...read.content, items: read.content.items.map(item => ({ ...item, glyphs: undefined })) } }
    } }
    await assert.rejects(f.revalidate(f.input(), pages), { code: 'pdf/text-geometry-unavailable' })
    const refs = f.captured.excerpts.map(item => item.refId)
    for (const refIds of [[refs[0]!, refs[0]!], [...refs].reverse()]) {
      await assert.rejects(f.revalidate({ ...f.input(), selections: [{ id: 'invalid-order', refIds }] }),
        { code: 'pdf/invalid-selection' })
    }
  } finally { await f.dispose() }
})

test('combining independently valid page references cannot exceed the saved selection text limit', async () => {
  const texts = ['A'.repeat(4000), 'B'.repeat(4000)]
  const state = memoryWorkspace(await pdfBytes(texts)), references = createMemoryEvidenceReferenceStore()
  try {
    const opened = await state.workspaces.execute(owner, { action: 'open', sessionId: owner, owner: 'ui',
      address: `dsh-resource://file/session/${owner}//fixtures/native.pdf` }, agent(), signal)
    assert.ok('bytes' in opened)
    const pages: AgentPageReadPort = { async readPageText(sessionId, documentId, page) {
      return { snapshot: state.workspaces.readSnapshot(sessionId, documentId), content: content(texts[page - 1]!) }
    } }
    const readSource: FreshSourceRead = async () => ({ path, digest: evidenceSha256(state.current()) })
    const identity = { sessionId: owner, documentId: opened.id,
      expectedRevision: opened.revision, expectedContentVersion: opened.contentVersion }
    const refIds: string[] = []
    for (const [index, quote] of texts.entries()) {
      const selection = await prepareTextSelectionEvidence(state.workspaces, pages, references, { ...identity, quote,
        fragments: [{ page: index + 1, rect: [38, 156, 250, 174], quadPoints: [38, 174, 250, 174, 38, 156, 250, 156] }] },
      signal, readSource)
      refIds.push(selection.excerpts[0]!.refId)
    }
    await assert.rejects(revalidateTextSelectionEvidence(state.workspaces, pages, references,
      { action: 'revalidate', ...identity, selections: [{ id: 'over-limit', refIds }] }, signal, readSource),
    { code: 'pdf/selection-too-large' })
  } finally { await state.workspaces.dispose() }
})
