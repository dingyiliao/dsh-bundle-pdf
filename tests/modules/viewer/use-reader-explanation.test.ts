import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import type { ReaderSelection } from '../../../src/modules/viewer/model/reader-selection.ts'
import type { NativeDocument } from '../../../src/modules/viewer/rendering/document.ts'
import { useReaderExplanation, type ReaderExplanationOptions } from '../../../src/modules/viewer/index.ts'
import { readerLocales } from '../../../src/modules/viewer/locales.ts'

const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

const baselineDigest = `sha256:${'a'.repeat(64)}`
const snapshot = { id: 'doc-1', revision: 7, contentVersion: 'content-1', path: '/lesson.pdf',
  sourceVersion: 'fs-1', reader: { bytesHash: baselineDigest, generation: 1, protocolVersion: 1 },
  conflict: false, document: { annotations: [] } } as unknown as WorkspaceSnapshot
const selection: ReaderSelection = { kind: 'text', revision: 7, text: 'Selected paragraph',
  fragments: [{ page: 3, rect: [10, 20, 100, 40], quadPoints: [] }] }

async function withExplanation(run: (fixture: {
  state(): ReturnType<typeof useReaderExplanation>
  options: ReaderExplanationOptions
  render(options: ReaderExplanationOptions): Promise<void>
  prompts: unknown[]
  window: Window & typeof globalThis
}) => Promise<void>): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const root = createRoot(dom.document.getElementById('root')!)
  const tab = new AbortController()
  const prompts: unknown[] = []
  let latest: ReturnType<typeof useReaderExplanation> | undefined
  const Harness = (props: ReaderExplanationOptions) => { latest = useReaderExplanation(props); return null }
  const options: ReaderExplanationOptions = {
    sessionId: 'session-1', tabSignal: tab.signal, visible: true, snapshot, pdf: null,
    promptExplanation: async value => { prompts.push(value) },
    promptTemplate: '{{instruction}}\n\n{{document}}\n\n{{items}}',
    imageUnderstanding: { async availability() { return { status: 'available', kind: 'direct-image', backendId: 'test' } },
      async prepareReference() { throw new Error('no image reference in a text-only explanation') } },
    textSelectionEvidence: { async prepare(request) { return {
      text: request.quote, documentId: 'doc-1', sourcePath: '/lesson.pdf',
      sourceDigest: baselineDigest, sourceVersion: 'fs-1', contentVersion: 'content-1', revision: 7,
      excerpts: [{ page: 3, text: request.quote, refId: 'pdfref_test', startUtf16: 0, endUtf16: request.quote.length }],
    } } },
    allowReadingContext: true, screenshotBusy: false, displayReady: true, mode: 'text',
    regionPurpose: { current: null }, ownerSequence: { current: 1 }, currentSnapshot: () => snapshot,
    inspectSource: async () => baselineDigest,
    documentReady: () => true, setMode() {}, setSelection() {}, clearSelection() {}, clearAnnotation() {},
    closeToolsMenu() {}, t: key => key,
  }
  const render = async (next: ReaderExplanationOptions) => { await act(async () => { root.render(React.createElement(Harness, next)) }) }
  try { await render(options); await run({ state: () => latest!, options, render, prompts, window: dom }) }
  finally {
    await act(async () => root.unmount())
    tab.abort()
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('explanation requires a question, then submits one ordinary text turn', async () => {
  await withExplanation(async ({ state, prompts }) => {
    await act(async () => { state().start(selection) })
    assert.equal(state().editor?.kind, 'new')
    await act(async () => { await state().saveQuestion() })
    assert.equal(state().error, 'reader.explain.questionRequired')
    assert.equal(state().active?.excerpts.length, 0)
    await act(async () => { state().setEditor(current => current ? { ...current, question: 'Why?' } : current) })
    await act(async () => { await state().saveQuestion() })
    assert.equal(state().active?.excerpts[0]?.question, 'Why?')
    assert.equal(state().editor, null)
    await act(async () => { await state().submit() })
    assert.equal(prompts.length, 1)
    assert.match(JSON.stringify(prompts[0]), /Selected paragraph/)
    assert.match(JSON.stringify(prompts[0]), /Why\?/)
    assert.equal(state().active, null)
  })
})

test('leaving explanation pauses saved materials and the current question for the same source', async () => {
  await withExplanation(async ({ state, prompts }) => {
    await act(async () => { state().start(selection) })
    await act(async () => { state().setEditor(editor => editor ? { ...editor, question: 'Why?' } : editor) })
    await act(async () => { await state().saveQuestion() })
    const saved = state().active!.excerpts[0]
    const next = { ...selection, text: 'Another paragraph' }
    await act(async () => { state().offerTextSelection(next) })
    await act(async () => { state().setEditor(editor => editor ? { ...editor, question: 'An unfinished question' } : editor) })
    await act(async () => { state().cancel() })
    assert.equal(state().active, null)
    assert.equal(state().draft?.excerpts[0], saved)
    assert.equal(state().editor, null, 'paused editing is not rendered in reading mode')
    let restored: ReturnType<ReturnType<typeof useReaderExplanation>['start']>
    await act(async () => { restored = state().start() })
    assert.equal(state().active?.excerpts[0], saved)
    assert.equal(state().editor?.question, 'An unfinished question')
    assert.deepEqual(restored, next.fragments, 'the Reader can precisely reveal an offscreen paused question')
    assert.equal(state().active?.excerpts.length, 1, 'the pending question never increments the saved count')
    await act(async () => { state().cancelEditor(); state().cancel() })
    await act(async () => { restored = state().start() })
    assert.equal(restored, undefined, 'reopening saved materials without a pending question does not request navigation')
    await act(async () => { state().editQuestion(saved.id) })
    await act(async () => { state().setEditor(editor => editor ? { ...editor, question: 'An unfinished revision' } : editor) })
    await act(async () => { state().cancel() })
    await act(async () => { restored = state().start() })
    assert.deepEqual(restored, saved.fragments, 'pending edits resume at the saved material instead of a new page position')
    assert.equal(state().editor?.question, 'An unfinished revision')
    assert.equal(state().active?.excerpts[0].question, 'Why?', 'pausing a question edit does not implicitly save it')
    assert.deepEqual(prompts, [], 'pausing/resuming never sends a model turn or writes the PDF')
  })
})

test('a new selection cannot silently replace a question that has not been saved', async () => {
  await withExplanation(async ({ state }) => {
    await act(async () => { state().start(selection) })
    await act(async () => { state().setEditor(editor => editor ? { ...editor, question: 'Keep this question' } : editor) })
    const first = state().editor
    const next = { ...selection, text: 'Different text' }
    await act(async () => { state().offerTextSelection(next) })
    assert.equal(state().editor, first)
    assert.equal(state().error, 'reader.explain.finishQuestion')
    await act(async () => { state().cancel() })
    assert.equal(state().editor, null)
    let restored: ReturnType<ReturnType<typeof useReaderExplanation>['start']>
    await act(async () => { restored = state().start(next) })
    assert.equal(state().editor, first)
    assert.equal(state().editor?.question, 'Keep this question', 'a new context-menu selection cannot overwrite a paused typed question')
    assert.deepEqual(restored, selection.fragments, 'the original question remains reachable even when a different passage was offered')
    await act(async () => { state().cancelEditor() })
    await act(async () => { state().offerTextSelection(next) })
    const editor = state().editor
    assert.equal(editor?.kind === 'new' && editor.selection.text, 'Different text')
    assert.equal(state().active?.excerpts.length, 0, 'only saved non-empty questions count as materials')
  })
})

test('paused materials retain their exact source and cannot be rebound when reopened after a revision change', async () => {
  await withExplanation(async ({ state, options, render, prompts }) => {
    let current = snapshot
    await render({ ...options, currentSnapshot: () => current })
    await act(async () => { state().start(selection) })
    await act(async () => { state().setEditor(editor => editor ? { ...editor, question: 'Why?' } : editor) })
    await act(async () => { await state().saveQuestion() })
    const id = state().active!.excerpts[0].id
    await act(async () => { state().cancel() })
    current = { ...snapshot, revision: 8 }
    await render({ ...options, snapshot: current, currentSnapshot: () => current })
    await act(async () => { state().start() })
    assert.equal(state().active?.source.revision, 7)
    assert.equal(state().error, 'reader.explain.sourceChanged')
    await act(async () => { await state().submit() })
    assert.deepEqual(prompts, [])
    await act(async () => { state().removeQuestion(id) })
    assert.equal(state().active?.excerpts.length, 0)
    assert.equal(state().active?.source.revision, 8, 'only removing all stale evidence starts an empty fresh draft')
  })
})

test('exit aborts image capture without losing saved materials or reviving the mode on a late result', async () => {
  await withExplanation(async ({ state, options, render }) => {
    let finish!: (result: Awaited<ReturnType<NonNullable<ReaderExplanationOptions['regionEvidence']>['prepare']>>) => void
    let signal: AbortSignal | undefined
    await render({ ...options, pdf: { numPages: 3 } as NativeDocument,
      regionEvidence: { prepare: async (_request, nextSignal) => { signal = nextSignal; return new Promise(resolve => { finish = resolve }) } } })
    await act(async () => { state().start(selection) })
    await act(async () => { state().setEditor(editor => editor ? { ...editor, question: 'Saved text' } : editor) })
    await act(async () => { await state().saveQuestion() })
    await act(async () => { state().beginRegion() })
    await act(async () => { state().selectRegion(2, { rect: [0, 0, 20, 20], quadPoints: [] }) })
    await act(async () => { state().setEditor(editor => editor ? { ...editor, question: 'Unfinished image question' } : editor) })
    let pending!: Promise<void>
    await act(async () => { pending = state().saveQuestion() })
    await act(async () => { state().cancel() })
    assert.equal(signal?.aborted, true)
    assert.equal(state().draft?.excerpts.length, 1)
    await act(async () => {
      finish({ refId: 'late-region', documentId: 'doc-1', page: 2, rectPdf: [0, 0, 20, 20],
        sourcePath: '/lesson.pdf', sourceDigest: baselineDigest, sourceVersion: 'fs-1',
        contentVersion: 'content-1', revision: 7, mediaType: 'image/png', width: 20, height: 20,
        bytes: new Uint8Array([1, 2, 3]) })
      await pending
    })
    assert.equal(state().active, null)
    assert.equal(state().draft?.excerpts.length, 1)
    assert.equal(state().saving, false)
    await act(async () => { state().start() })
    assert.equal(state().active?.excerpts.length, 1)
    assert.equal(state().editor?.question, 'Unfinished image question')
  })
})

test('an admitted send can leave the mode, prevents duplicate submissions, and retains failures for review', async () => {
  await withExplanation(async ({ state, options, render }) => {
    let calls = 0, fail!: (error: Error) => void
    await render({ ...options, promptExplanation: async () => { calls++; await new Promise<void>((_resolve, reject) => { fail = reject }) } })
    await act(async () => { state().start(selection) })
    await act(async () => { state().setEditor(editor => editor ? { ...editor, question: 'Why?' } : editor) })
    await act(async () => { await state().saveQuestion() })
    let pending!: Promise<void>
    await act(async () => { pending = state().submit(); await state().submit() })
    assert.equal(calls, 1)
    await act(async () => { state().cancel() })
    assert.equal(state().active, null)
    assert.equal(state().sending, true)
    await act(async () => { fail(new Error('Could not append turn')); await pending })
    assert.equal(state().draft?.excerpts.length, 1)
    assert.equal(state().error, 'Could not append turn')
    await act(async () => { state().start() })
    assert.equal(state().error, 'Could not append turn', 'reopening does not dismiss an outstanding failure')
    await act(async () => { state().dismissError() })
    assert.equal(state().error, '')
  })
})

test('admission clears exactly the sent materials even if the working revision changes while awaiting acceptance', async () => {
  await withExplanation(async ({ state, options, render }) => {
    let current = snapshot, accept!: () => void
    const input = { ...options, currentSnapshot: () => current,
      promptExplanation: async () => { await new Promise<void>(resolve => { accept = resolve }) } }
    await render(input)
    await act(async () => { state().start(selection) })
    await act(async () => { state().setEditor(editor => editor ? { ...editor, question: 'Why?' } : editor) })
    await act(async () => { await state().saveQuestion() })
    let pending!: Promise<void>
    await act(async () => { pending = state().submit() })
    current = { ...snapshot, revision: snapshot.revision + 1 }
    await render({ ...input, snapshot: current })
    await act(async () => { accept(); await pending })
    assert.equal(state().active, null)
    assert.equal(state().draft, null, 'accepted materials cannot remain available for duplicate submission')
    assert.equal(state().sending, false)
    await act(async () => { state().start() })
    assert.equal(state().active?.source.revision, 8)
    assert.equal(state().active?.excerpts.length, 0)
  })
})

test('a late submission failure cannot affect another document or keep its mode entry locked', async () => {
  await withExplanation(async ({ state, options, render }) => {
    let fail!: (error: Error) => void
    let signal: AbortSignal | undefined
    await render({ ...options, promptExplanation: async (_prompt, nextSignal) => {
      signal = nextSignal; await new Promise<void>((_resolve, reject) => { fail = reject })
    } })
    await act(async () => { state().start(selection) })
    await act(async () => { state().setEditor(editor => editor ? { ...editor, question: 'Why?' } : editor) })
    await act(async () => { await state().saveQuestion() })
    let pending!: Promise<void>
    await act(async () => { pending = state().submit() })
    const next = { ...snapshot, id: 'doc-2', contentVersion: 'content-2' }
    await render({ ...options, snapshot: next, currentSnapshot: () => next })
    assert.equal(signal?.aborted, true)
    await act(async () => { state().start() })
    const newDraft = state().active
    assert.equal(newDraft?.source.documentId, 'doc-2')
    await act(async () => { fail(new Error('Old document failed')); await pending })
    assert.equal(state().active, newDraft)
    assert.equal(state().error, '')
    assert.equal(state().sending, false)
  })
})

test('explanation draft is scoped to content identity and cleared on document switch', async () => {
  await withExplanation(async ({ state, options, render }) => {
    await act(async () => { state().start(selection) })
    assert.equal(state().active?.key, 'session-1:doc-1:content-1')
    const changed = { ...snapshot, contentVersion: 'content-2' }
    await render({ ...options, snapshot: changed, currentSnapshot: () => changed })
    assert.equal(state().active, null)
    assert.equal(state().editor, null)
    assert.equal(state().captureTask.current, null)
  })
})

test('selection verification failures are localized and preserve the question without calling the model', async () => {
  for (const [code, key] of [
    ['pdf/selection-unverifiable', 'selectionUnverifiable'],
    ['pdf/selection-ocr-unverifiable', 'selectionOcr'],
    ['pdf/selection-mismatch', 'selectionMismatch'],
    ['pdf/stale-reader', 'sourceChanged'],
  ]) await withExplanation(async ({ state, options, render, prompts }) => {
    const t = (key: string) => readerLocales.zh[key] ?? key
    await render({ ...options, t, textSelectionEvidence: { async prepare() {
      throw Object.assign(new Error('Internal Host geometry details'), { code })
    } } })
    await act(async () => { state().start(selection) })
    await act(async () => { state().setEditor(editor => editor ? { ...editor, question: '为什么？' } : editor) })
    await act(async () => { await state().saveQuestion() })
    assert.equal(state().error, t(`reader.explain.${key}`))
    assert.doesNotMatch(state().error, /Internal Host/)
    assert.equal(state().editor?.question, '为什么？')
    assert.equal(state().active?.excerpts.length, 0)
    assert.equal(state().saving, false)
    assert.deepEqual(prompts, [])
  })
})

test('selection bound to the old source version cannot be submitted after its PDF changes', async () => {
  await withExplanation(async ({ state, options, render, prompts }) => {
    await act(async () => { state().start(selection) })
    await act(async () => { state().setEditor(current => current ? { ...current, question: 'Why?' } : current) })
    await act(async () => { await state().saveQuestion() })
    const changed = { ...snapshot, sourceVersion: 'fs-2' }
    await render({ ...options, snapshot: changed, currentSnapshot: () => changed })
    assert.equal(state().active?.excerpts.length, 1)
    await act(async () => { await state().submit() })
    assert.deepEqual(prompts, [])
    assert.equal(state().error, 'reader.explain.sourceChanged')
  })
})

test('source digest is re-read from disk immediately before the explanation enters the Session', async () => {
  await withExplanation(async ({ state, options, render, prompts }) => {
    let inspected = 0
    await render({ ...options, inspectSource: async path => {
      inspected++
      assert.equal(path, '/lesson.pdf')
      return `sha256:${'b'.repeat(64)}`
    } })
    await act(async () => { state().start(selection) })
    await act(async () => { state().setEditor(current => current ? { ...current, question: 'Why?' } : current) })
    await act(async () => { await state().saveQuestion() })
    await act(async () => { await state().submit() })
    assert.equal(inspected, 1)
    assert.deepEqual(prompts, [])
    assert.equal(state().error, 'reader.explain.sourceChanged')
  })
})

test('unsaved annotation operations do not invalidate an unchanged PDF baseline', async () => {
  await withExplanation(async ({ state, options, render, prompts }) => {
    const dirty = { ...snapshot, dirty: true }
    await render({ ...options, snapshot: dirty, currentSnapshot: () => dirty })
    await act(async () => { state().start(selection) })
    await act(async () => { state().setEditor(current => current ? { ...current, question: 'Why?' } : current) })
    await act(async () => { await state().saveQuestion() })
    await act(async () => { await state().submit() })
    assert.equal(prompts.length, 1)
    assert.equal(state().error, '')
  })
})

test('a stale text selection cannot start or be saved as an explanation question', async () => {
  await withExplanation(async ({ state }) => {
    const staleSelection = { ...selection, revision: selection.revision + 1 }
    await act(async () => { state().start(staleSelection) })
    assert.equal(state().active, null)
    assert.equal(state().error, 'reader.explain.sourceChanged')

    await act(async () => { state().start(selection) })
    await act(async () => { state().setEditor(current => current?.kind === 'new'
      ? { ...current, selection: staleSelection, question: 'Why?' } : current) })
    await act(async () => { await state().saveQuestion() })
    assert.equal(state().active?.excerpts.length, 0)
    assert.equal(state().error, 'reader.explain.sourceChanged')
  })
})

test('fresh explanation entry accepts a flushed revision while old selections and changed sources stay rejected', async () => {
  await withExplanation(async ({ state, options, render }) => {
    let current = snapshot
    await render({ ...options, currentSnapshot: () => current })
    const delayedStart = state().start
    current = { ...snapshot, revision: snapshot.revision + 1, dirty: true }
    await act(async () => { delayedStart() })
    assert.equal(state().active?.source.revision, current.revision)
    assert.equal(state().error, '')
    await act(async () => { state().cancel() })
    await act(async () => { delayedStart(selection) })
    assert.equal(state().active, null, 'flushing cannot refresh an old selected-text identity')
    assert.equal(state().error, 'reader.explain.sourceChanged')
    for (const changed of [{ id: 'doc-2' }, { contentVersion: 'content-2' }, { sourceVersion: 'fs-2' }]) {
      current = { ...snapshot, ...changed }
      await act(async () => { delayedStart() })
      assert.equal(state().active, null, 'a delayed mode entry cannot transfer to another source')
      assert.equal(state().error, 'reader.explain.sourceChanged')
    }
  })
})

test('question editing and new text/region selections reject a changed PDF baseline', async () => {
  await withExplanation(async ({ state, options, render }) => {
    let current = snapshot
    await render({ ...options, currentSnapshot: () => current,
      pdf: { numPages: 3 } as NativeDocument,
      regionEvidence: { async prepare() { throw new Error('not called') } } })
    await act(async () => { state().start(selection) })
    await act(async () => { state().setEditor(editor => editor ? { ...editor, question: 'Why?' } : editor) })
    await act(async () => { await state().saveQuestion() })
    const id = state().active?.excerpts[0]?.id
    assert.ok(id)

    current = { ...snapshot, sourceVersion: 'fs-2' }
    await act(async () => { state().offerTextSelection(selection) })
    assert.equal(state().editor, null)
    assert.equal(state().error, 'reader.explain.sourceChanged')

    await act(async () => { state().beginRegion() })
    assert.equal(options.regionPurpose.current, null)
    assert.equal(state().error, 'reader.explain.sourceChanged')

    await act(async () => { state().editQuestion(id, document.createElement('span')) })
    assert.equal(state().editor, null)
    assert.equal(state().error, 'reader.explain.sourceChanged')

    current = snapshot
    await act(async () => { state().beginRegion() })
    assert.equal(options.regionPurpose.current, 'explanation')
    current = { ...snapshot, sourceVersion: 'fs-3' }
    await act(async () => { assert.equal(state().selectRegion(2, { rect: [0, 0, 20, 20], quadPoints: [] }), true) })
    assert.equal(state().editor, null)
    assert.equal(state().error, 'reader.explain.sourceChanged')
  })
})

test('saving an open question fails closed when the PDF changes before capture', async () => {
  await withExplanation(async ({ state, options, render }) => {
    let current = snapshot
    await render({ ...options, currentSnapshot: () => current })
    await act(async () => { state().start(selection) })
    await act(async () => { state().setEditor(editor => editor ? { ...editor, question: 'Why?' } : editor) })
    current = { ...snapshot, sourceVersion: 'fs-2' }
    await act(async () => { await state().saveQuestion() })
    assert.equal(state().active?.excerpts.length, 0)
    assert.equal(state().error, 'reader.explain.sourceChanged')
  })
})

test('a PDF change during Host region preparation leaves no captured explanation image', async () => {
  await withExplanation(async ({ state, options, render }) => {
    let current = snapshot
    let finish!: (value: Awaited<ReturnType<NonNullable<ReaderExplanationOptions['regionEvidence']>['prepare']>>) => void
    const response = new Promise<Parameters<typeof finish>[0]>(resolve => { finish = resolve })
    const pdf = { numPages: 3 } as NativeDocument
    await render({ ...options, pdf, currentSnapshot: () => current,
      regionEvidence: { prepare: request => {
        assert.deepEqual(request, { sessionId: 'session-1', documentId: 'doc-1', page: 2,
          rectPdf: [0, 0, 20, 20], expectedRevision: 7, expectedContentVersion: 'content-1' })
        return response
      } } })
    await act(async () => { state().start() })
    await act(async () => { state().beginRegion() })
    await act(async () => { assert.equal(state().selectRegion(2, { rect: [0, 0, 20, 20], quadPoints: [] }), true) })
    await act(async () => { state().setEditor(editor => editor ? { ...editor, question: 'What is this?' } : editor) })
    let pending!: Promise<void>
    await act(async () => { pending = state().saveQuestion() })
    current = { ...snapshot, sourceVersion: 'fs-2' }
    await act(async () => { finish({ refId: 'ref-1', documentId: 'doc-1', page: 2, rectPdf: [0, 0, 20, 20],
      sourcePath: '/lesson.pdf', sourceDigest: baselineDigest, sourceVersion: 'fs-1',
      contentVersion: 'content-1', revision: 7, mediaType: 'image/png', width: 20, height: 20,
      bytes: new Uint8Array([1, 2, 3]) }); await pending })
    assert.equal(state().active?.excerpts.length, 0)
    assert.equal(state().editor?.kind, 'new')
    assert.equal(state().error, 'reader.explain.sourceChanged')
    assert.equal(state().saving, false)
  })
})

test('a Host-rendered region carries its evidence reference into the submitted prompt', async () => {
  await withExplanation(async ({ state, options, render, prompts }) => {
    const bytes = new Uint8Array([1, 2, 3])
    await render({ ...options, pdf: { numPages: 3 } as NativeDocument,
      regionEvidence: { async prepare() { return { refId: 'pdf-ref-1', documentId: 'doc-1', page: 2,
        rectPdf: [0, 0, 20, 20], sourcePath: '/lesson.pdf', sourceDigest: baselineDigest,
        sourceVersion: 'fs-1', contentVersion: 'content-1', revision: 7,
        mediaType: 'image/png', width: 20, height: 20, bytes } } },
      imageUnderstanding: { async availability() { return { status: 'available', kind: 'direct-image', backendId: 'test' } },
        async prepareReference(request: { sessionId: string; documentId: string; refId: string; question: string }) {
          assert.deepEqual(request, { sessionId: 'session-1', documentId: 'doc-1', refId: 'pdf-ref-1',
            question: 'What is this?' })
          return { kind: 'direct-image' as const, backendId: 'test', requestedRefId: request.refId,
            provenance: { backendId: 'test', mode: 'session-vision' as const },
            evidence: { refId: request.refId, documentId: 'doc-1', page: 2,
              locator: { kind: 'pdf-region' as const, rectPdf: [0, 0, 20, 20] as [number, number, number, number] },
              sourceDigest: baselineDigest, sourceVersion: 'fs-1', contentVersion: 'content-1', revision: 7,
              renderedImageSha256: baselineDigest },
            image: { mediaType: 'image/png' as const, data: new Uint8Array([9, 9, 9]), width: 20, height: 20 } }
        } } })
    await act(async () => { state().start() })
    await act(async () => { state().beginRegion() })
    await act(async () => { assert.equal(state().selectRegion(2, { rect: [0, 0, 20, 20], quadPoints: [] }), true) })
    await act(async () => { state().setEditor(editor => editor ? { ...editor, question: 'What is this?' } : editor) })
    await act(async () => { await state().saveQuestion() })
    assert.equal(state().active?.excerpts[0]?.kind, 'region')
    await act(async () => { await state().submit() })
    assert.equal(prompts.length, 1)
    assert.match(JSON.stringify(prompts[0]), /pdf-ref-1/)
    assert.match(JSON.stringify(prompts[0]), /"type":"image"/)
    assert.match(JSON.stringify(prompts[0]), new RegExp(Buffer.from([9, 9, 9]).toString('base64')))
    assert.doesNotMatch(JSON.stringify(prompts[0]), new RegExp(Buffer.from([1, 2, 3]).toString('base64')))
  })
})

test('explanation rejects mismatched Host evidence and surfaces capture failures', async () => {
  await withExplanation(async ({ state, options, render }) => {
    await render({ ...options, textSelectionEvidence: { async prepare() { return {
      text: 'Selected paragraph', documentId: 'doc-1', sourcePath: '/lesson.pdf',
      sourceDigest: baselineDigest, sourceVersion: 'different-source', contentVersion: 'content-1', revision: 7,
      excerpts: [],
    } } } })
    await act(async () => { state().start(selection) })
    await act(async () => { state().setEditor(current => current ? { ...current, question: 'Why?' } : current) })
    await act(async () => { await state().saveQuestion() })
    assert.equal(state().error, 'reader.explain.sourceChanged')
    assert.equal(state().active?.excerpts.length, 0)
  })

  await withExplanation(async ({ state, options, render }) => {
    await render({ ...options, textSelectionEvidence: { async prepare() { throw new Error('Host evidence unavailable') } } })
    await act(async () => { state().start(selection) })
    await act(async () => { state().setEditor(current => current ? { ...current, question: 'Why?' } : current) })
    await act(async () => { await state().saveQuestion() })
    assert.equal(state().error, 'Host evidence unavailable')
    assert.equal(state().saving, false)
  })

  await withExplanation(async ({ state, options, render }) => {
    await render({ ...options, pdf: { numPages: 3 } as NativeDocument,
      regionEvidence: { async prepare() { return { refId: 'ref', documentId: 'doc-1', page: 3,
        rectPdf: [0, 0, 20, 20], sourcePath: '/lesson.pdf', sourceDigest: 'sha256:bad',
        sourceVersion: 'fs-1', contentVersion: 'content-1', revision: 7,
        mediaType: 'image/png', width: 20, height: 20, bytes: new Uint8Array([1]) } } } as never })
    await act(async () => { state().start() })
    await act(async () => { state().beginRegion() })
    await act(async () => { state().selectRegion(3, { rect: [0, 0, 20, 20], quadPoints: [] }) })
    await act(async () => { state().setEditor(current => current ? { ...current, question: 'What is shown?' } : current) })
    await act(async () => { await state().saveQuestion() })
    assert.equal(state().error, 'reader.explain.sourceChanged')
    assert.equal(state().active?.excerpts.length, 0)
  })
})
