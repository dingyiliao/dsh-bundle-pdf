import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { createEvidenceReader, createMemoryEvidenceReferenceStore, createTextReferenceResolver,
  evidenceSha256, type TextReferenceResolverPort } from '../../../src/modules/evidence/index.ts'
import { createModelWriteService } from '../../../src/modules/model-write/index.ts'
import { createPdfRetrieval } from '../../../src/adapters/host/dsh/retrieval.ts'
import { NativeWorker } from '../../../src/adapters/host/pdfium/native-worker.ts'
import type { NativeTextContent } from '../../../src/shared/native.ts'
import { memoryWorkspace, nativeFixture } from '../../native-fixture.ts'
import { nativeTestSubprocess } from '../../native-test-subprocess.ts'

const signal = new AbortController().signal
const sessionId = 'reference-annotations'
const agent = { session: { id: sessionId, header: {} } }
const quote = 'Repeated evidence'

function line(y: number): NativeTextContent['items'][number] {
  return { str: quote, transform: [12, 0, 0, 12, 60, y], width: quote.length * 6, height: 12,
    dir: 'ltr', fontName: 'test', hasEOL: true,
    glyphs: Array.from(quote, (_, index) => [60 + index * 6, y, 6]) }
}

async function fixture() {
  const state = memoryWorkspace(await nativeFixture())
  const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId, owner: 'agent',
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal)
  assert.ok('bytes' in opened)
  const pages = { async readPageText(owner: string, documentId: string) {
    return { snapshot: state.workspaces.readSnapshot(owner, documentId), content: {
      items: [line(260), line(180)],
      styles: { test: { fontFamily: 'sans-serif', ascent: 0.8, descent: -0.2, vertical: false } },
      lang: null,
    } as NativeTextContent }
  } }
  const references = createMemoryEvidenceReferenceStore()
  const reader = createEvidenceReader(state.workspaces, pages, references)
  const located = await reader.locate(sessionId, { documentId: opened.id, page: 1, quote }, signal)
  const reference = located.matches[1]!.evidence
  const resolver = createTextReferenceResolver(state.workspaces, pages, references)
  const input = { documentId: opened.id, expectedRevision: opened.revision,
    subtype: 'Highlight' as const, target: { kind: 'reference' as const, refId: reference.refId } }
  return { state, opened, pages, references, resolver, input, reference }
}

test('retrieval reference marks the right duplicate in the shared undoable draft and remains navigable', async () => {
  const f = await fixture(), writes = createModelWriteService(f.state.workspaces, f.pages, f.resolver)
  try {
    const result = await writes.annotate(sessionId, f.input, agent, signal)
    assert.equal(result.status, 'updated')
    assert.equal(result.revision, f.opened.revision + 1)
    assert.equal(result.dirty, true)
    assert.equal(result.canUndo, true)
    assert.equal(result.savedToFile, false)
    assert.equal(result.resolvedTarget.refId, f.reference.refId)
    assert.equal(result.coverage.complete, true)
    assert.equal(result.coverage.pages[0]!.refId, f.reference.refId)
    assert.equal(result.coverage.pages[0]!.startUtf16, quote.length + 1)
    assert.equal(result.coverage.pages[0]!.text, quote)
    const draft = f.state.workspaces.readSnapshot(sessionId, f.opened.id)
    const mark = draft.document.annotations.find(item => item.id === result.annotationId)!
    assert.deepEqual(mark.rect, [60, 177.6, 162, 189.6])
    assert.equal(mark.quadPoints?.length, 8)
    assert.equal(f.state.writes(), 0)
    const target = await f.resolver.resolve(sessionId, f.opened.id, f.reference.refId, signal)
    assert.equal(target.revision, result.revision)
    assert.deepEqual(target.rectPdf, mark.rect)
    const repeated = await writes.annotate(sessionId, { ...f.input, expectedRevision: result.revision }, agent, signal)
    assert.equal(repeated.status, 'already_annotated')
    assert.equal(repeated.annotationId, result.annotationId)
    const undone = await f.state.workspaces.execute(sessionId, { action: 'undo', sessionId,
      id: f.opened.id, revision: result.revision }, agent, signal)
    assert.ok('bytes' in undone)
    assert.equal(undone.document.annotations.some(item => item.id === result.annotationId), false)
  } finally { writes.dispose(); await f.state.workspaces.dispose() }
})

test('a reference subquote marks only the requested text in its attested repeated occurrence', async () => {
  const f = await fixture(), writes = createModelWriteService(f.state.workspaces, f.pages, f.resolver)
  const selected = 'evidence'
  try {
    const result = await writes.annotate(sessionId, { ...f.input,
      target: { ...f.input.target, quote: selected } }, agent, signal)
    assert.equal(result.status, 'updated')
    assert.equal(result.resolvedTarget.refId, f.reference.refId)
    assert.equal(result.resolvedTarget.quote, selected)
    assert.equal(result.coverage.totalChars, selected.length)
    assert.equal(result.coverage.pages[0]!.text, selected)
    assert.equal(result.coverage.pages[0]!.startUtf16, quote.length + 1 + 'Repeated '.length)
    const draft = f.state.workspaces.readSnapshot(sessionId, f.opened.id)
    const mark = draft.document.annotations.find(item => item.id === result.annotationId)!
    assert.deepEqual(mark.rect, [114, 177.6, 162, 189.6])
    const jump = await f.resolver.resolve(sessionId, f.opened.id, result.resolvedTarget.refId!, signal,
      undefined, result.resolvedTarget.quote)
    assert.deepEqual(jump.rectPdf, mark.rect)
    assert.equal(jump.text, selected)
    const original = await f.resolver.resolve(sessionId, f.opened.id, f.reference.refId, signal)
    assert.equal(original.text, quote, 'narrowing must not mutate the parent reference')
    const repeated = await writes.annotate(sessionId, { ...f.input, expectedRevision: result.revision,
      target: { ...f.input.target, quote: selected } }, agent, signal)
    assert.equal(repeated.status, 'already_annotated')
    assert.equal(repeated.annotationId, result.annotationId)
    assert.equal(f.state.writes(), 0)
    const undone = await f.state.workspaces.execute(sessionId, { action: 'undo', sessionId,
      id: f.opened.id, revision: result.revision }, agent, signal)
    assert.ok('bytes' in undone)
    assert.equal(undone.document.annotations.some(item => item.id === result.annotationId), false)
  } finally { writes.dispose(); await f.state.workspaces.dispose() }
})

test('a whole-context reference stays broad when requested, while invalid subquotes write nothing', async () => {
  const f = await fixture(), writes = createModelWriteService(f.state.workspaces, f.pages, f.resolver)
  const reader = createEvidenceReader(f.state.workspaces, f.pages, f.references)
  try {
    const context = await reader.context(sessionId, { documentId: f.opened.id,
      focus: { kind: 'page-window', page: 1 }, maxPages: 1 }, signal)
    const reference = context.chunks[0]!.evidence
    for (const [refId, selected, code] of [
      [reference.refId, 'evidence', 'pdf/ambiguous-text-target'],
      [f.reference.refId, 'evidence\nRepeated', 'pdf/text-not-found'],
    ]) {
      await assert.rejects(writes.annotate(sessionId, { ...f.input,
        target: { kind: 'reference', refId: refId!, quote: selected } }, agent, signal), { code })
      assert.equal(f.state.workspaces.readSnapshot(sessionId, f.opened.id).revision, f.opened.revision)
    }
    const broad = await writes.annotate(sessionId, { ...f.input,
      target: { kind: 'reference', refId: reference.refId } }, agent, signal)
    assert.equal(broad.coverage.pages[0]!.text, `${quote}\n${quote}`)
    assert.equal(broad.coverage.totalChars, quote.length * 2 + 1)
    assert.equal('quote' in broad.resolvedTarget, false)
    assert.equal(f.state.writes(), 0)
  } finally { writes.dispose(); await f.state.workspaces.dispose() }
})

test('a UI edit after reference resolution wins the CAS; the model does not add a stale mark', async () => {
  const f = await fixture()
  const racing: TextReferenceResolverPort = { async resolve(...args) {
    const result = await f.resolver.resolve(...args)
    await f.state.workspaces.execute(sessionId, { action: 'change', sessionId,
      id: f.opened.id, revision: f.opened.revision, operations: [{ type: 'add', annotation: {
        id: 'user-note', page: 1, subtype: 'Text', rect: [40, 50, 60, 70], contents: 'User edit',
      } }] }, agent, signal)
    return result
  } }
  const writes = createModelWriteService(f.state.workspaces, f.pages, racing)
  try {
    await assert.rejects(writes.annotate(sessionId, f.input, agent, signal), { code: 'pdf/stale-revision' })
    const latest = f.state.workspaces.readSnapshot(sessionId, f.opened.id)
    assert.equal(latest.document.annotations.length, f.opened.document.annotations.length + 1)
    assert.equal(latest.document.annotations.some(item => item.id === 'user-note'), true)
    assert.equal(f.state.writes(), 0)
  } finally { writes.dispose(); await f.state.workspaces.dispose() }
})

test('reference metadata must match the draft before an annotation is planned', async () => {
  const f = await fixture()
  try {
    const resolved = await f.resolver.resolve(sessionId, f.opened.id, f.reference.refId, signal)
    for (const mismatch of [{ documentId: 'other-document' }, { revision: resolved.revision + 1 },
      { contentVersion: 'other-version' }, { sourceDigest: 'other-source' }]) {
      const writes = createModelWriteService(f.state.workspaces, f.pages,
        { resolve: async () => ({ ...resolved, ...mismatch }) })
      try {
        await assert.rejects(writes.annotate(sessionId, f.input, agent, signal), { code: 'pdf/stale-revision' })
        assert.equal(f.state.workspaces.readSnapshot(sessionId, f.opened.id).revision, f.opened.revision)
        assert.equal(f.state.writes(), 0)
      } finally { writes.dispose() }
    }
  } finally { await f.state.workspaces.dispose() }
})

test('context and related references spanning line-interleaved columns reject markup without a partial draft', async () => {
  const f = await fixture()
  const run = (str: string, x: number, y: number) => ({ ...line(y), str,
    transform: [12, 0, 0, 12, x, y], width: str.length * 6,
    glyphs: Array.from(str, (_, index) => [x + index * 6, y, 6] as [number, number, number]), hasEOL: false })
  const pages = { async readPageText(owner: string, id: string) {
    const result = await f.pages.readPageText(owner, id)
    return { ...result, content: { ...result.content, items: [run('Left start', 60, 260),
      run('Right unrelated', 180, 260), run('Left following', 60, 240)] } }
  } }
  const references = createMemoryEvidenceReferenceStore()
  const evidence = createEvidenceReader(f.state.workspaces, pages, references)
  const retrieval = createPdfRetrieval(f.state.workspaces, pages, references)
  const writes = createModelWriteService(f.state.workspaces, pages,
    createTextReferenceResolver(f.state.workspaces, pages, references))
  try {
    const context = await evidence.context(sessionId, { documentId: f.opened.id,
      focus: { kind: 'page-window', page: 1 }, maxPages: 1 }, signal)
    const related = await retrieval.search(sessionId, { documentId: f.opened.id,
      query: 'Left start', mode: 'lexical', maxPages: 1 }, signal)
    const refs = [context.chunks[0]!.evidence.refId, related.candidates[0]!.evidence.refId]
    for (const refId of refs) await assert.rejects(writes.annotate(sessionId, {
      ...f.input, target: { kind: 'reference', refId } }, agent, signal), { code: 'pdf/ambiguous-reading-order' })
    const preciseReference = await createTextReferenceResolver(f.state.workspaces, pages, references)
      .resolve(sessionId, f.opened.id, context.chunks[0]!.evidence.refId, signal, undefined, 'Left start')
    assert.equal(preciseReference.text, 'Left start', 'a safe subpassage need not validate the broad parent geometry')
    assert.equal(preciseReference.endUtf16, 'Left start'.length)
    await assert.rejects(writes.annotate(sessionId, { ...f.input, target: { kind: 'pdf-text', page: 1,
      quote: context.chunks[0]!.evidence.snapshot.text } }, agent, signal), { code: 'pdf/ambiguous-reading-order' })
    assert.equal(f.state.workspaces.readSnapshot(sessionId, f.opened.id).revision, f.opened.revision)
    assert.equal(f.state.workspaces.readSnapshot(sessionId, f.opened.id).document.annotations.length,
      f.opened.document.annotations.length)
    assert.equal(f.state.writes(), 0)
    const precise = await writes.annotate(sessionId, { ...f.input,
      target: { kind: 'pdf-text', page: 1, quote: 'Left start' } }, agent, signal)
    assert.equal(precise.status, 'updated', 'an unambiguous single-column quote must still succeed')
    assert.equal(precise.revision, f.opened.revision + 1)
    assert.equal(precise.coverage.pages[0]!.text, 'Left start')
  } finally { writes.dispose(); await retrieval.dispose(); await f.state.workspaces.dispose() }
})

test('source replacement and cancellation after resolving evidence still apply zero model changes', async () => {
  for (const mode of ['source', 'abort', 'dispose'] as const) {
    const f = await fixture(), controller = new AbortController()
    const resolver: TextReferenceResolverPort = { async resolve(...args) {
      const result = await f.resolver.resolve(...args)
      if (mode === 'source') await f.state.files.save(agent, f.opened.path,
        Buffer.from('External replacement'), evidenceSha256(f.state.current()), { signal })
      else if (mode === 'abort') controller.abort()
      else writes.dispose()
      return result
    } }
    const writes = createModelWriteService(f.state.workspaces, f.pages, resolver)
    try {
      await assert.rejects(writes.annotate(sessionId, f.input, agent, controller.signal),
        mode === 'source' ? { code: 'pdf/source-conflict' }
          : mode === 'abort' ? { name: 'AbortError' } : { code: 'pdf/write-unavailable' })
      assert.equal(f.state.workspaces.readSnapshot(sessionId, f.opened.id).revision, f.opened.revision)
    } finally { writes.dispose(); await f.state.workspaces.dispose() }
  }
})

const executable = resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
test('real PDFium evidence offsets become the correct shared-draft annotation without a model rectangle',
  { skip: !existsSync(executable) }, async () => {
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica)
    const page = pdf.addPage([400, 400])
    page.drawText(quote, { x: 60, y: 260, size: 12, font })
    page.drawText(quote, { x: 60, y: 180, size: 12, font })
    const state = memoryWorkspace(await pdf.save())
    const worker = new NativeWorker(executable, nativeTestSubprocess)
    let writes: ReturnType<typeof createModelWriteService> | undefined
    try {
      const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId, owner: 'agent',
        address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal)
      assert.ok('bytes' in opened)
      await worker.request({ command: 'open', documentId: opened.id }, opened.bytes)
      const pages = { async readPageText(owner: string, documentId: string, page: number) {
        const snapshot = state.workspaces.readSnapshot(owner, documentId)
        const reply = await worker.request({ command: 'text', documentId, pageIndex: page - 1 })
        return { snapshot, content: reply.value as NativeTextContent }
      } }
      const references = createMemoryEvidenceReferenceStore()
      const reader = createEvidenceReader(state.workspaces, pages, references)
      const located = await reader.locate(sessionId, { documentId: opened.id, page: 1, quote }, signal)
      assert.equal(located.matches.length, 2)
      const target = located.matches[1]!.evidence
      writes = createModelWriteService(state.workspaces, pages,
        createTextReferenceResolver(state.workspaces, pages, references))
      const result = await writes.annotate(sessionId, { documentId: opened.id,
        expectedRevision: opened.revision, subtype: 'Highlight', target: { kind: 'reference', refId: target.refId } }, agent, signal)
      assert.equal(result.coverage.pages[0]!.startUtf16, target.locator.startUtf16)
      assert.ok(result.resolvedTarget.rectPdf[1] < 180 && result.resolvedTarget.rectPdf[3] > 180)
      assert.ok(result.resolvedTarget.rectPdf[3] < 220)
      assert.equal(state.writes(), 0)
    } finally { writes?.dispose(); await worker.dispose(); await state.workspaces.dispose() }
  })
