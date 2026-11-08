import { createDom } from '../../support/dom.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import type { ReaderSelection } from '../../../src/modules/viewer/model/reader-selection.ts'
import type { NativeDocument } from '../../../src/modules/viewer/rendering/document.ts'
import { useReaderExplanation, type ReaderExplanationOptions } from '../../../src/modules/viewer/index.ts'
import { readerLocales } from '../../../src/modules/viewer/locales.ts'

type TextEvidenceApi = NonNullable<ReaderExplanationOptions['textSelectionEvidence']>
type TextRevalidationRequest = Parameters<TextEvidenceApi['revalidate']>[0]
type TextRevalidationResult = Awaited<ReturnType<TextEvidenceApi['revalidate']>>

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
  revalidations: TextRevalidationRequest[]
  replaceNativePage(page: number, text: string): void
  setNativeGeometry(refId: string, fragments: ReaderSelection['fragments']): void
}) => Promise<void>): Promise<void> {
  const { dom, restore: restoreDom, install: installDom } = createDom('<!doctype html><html><body><div id="root"></div></body></html>', { globals: [] })

  installDom({ window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })
  const root = createRoot(dom.document.getElementById('root')!)
  const tab = new AbortController()
  const prompts: unknown[] = []
  let latest: ReturnType<typeof useReaderExplanation> | undefined
  let currentOptions: ReaderExplanationOptions
  let referenceSequence = 0
  const revalidations: TextRevalidationRequest[] = []
  const nativePages = new Map<string, string>()
  const references = new Map<string, { documentId: string; path: string; contentVersion: string;
    text: string; page: number; start: number; end: number; fragments: ReaderSelection['fragments'] }>()
  const nativeGeometry = new Map<string, ReaderSelection['fragments']>()
  const nativePageKey = (source: WorkspaceSnapshot, page: number) => JSON.stringify([source.id, source.path, source.contentVersion, page])
  function rejectStale(): never { throw Object.assign(new Error('Saved native PDF text no longer matches'), { code: 'pdf/stale-reader' }) }
  const Harness = (props: ReaderExplanationOptions) => { latest = useReaderExplanation(props); return null }
  const options: ReaderExplanationOptions = {
    sessionId: 'session-1', tabSignal: tab.signal, visible: true, snapshot, pdf: null,
    promptExplanation: async value => { prompts.push(value) },
    promptTemplate: '{{instruction}}\n\n{{document}}\n\n{{items}}',
    imageUnderstanding: { async availability() { return { status: 'available', kind: 'direct-image', backendId: 'test' } },
      async prepareReference() { throw new Error('no image reference in a text-only explanation') } },
    textSelectionEvidence: {
      async prepare(request) {
        const source = currentOptions.currentSnapshot()
        if (!source || source.id !== request.documentId || source.revision !== request.expectedRevision
          || source.contentVersion !== request.expectedContentVersion) rejectStale()
        const page = request.fragments[0]?.page
        assert.ok(page, 'the saved selection has a native page')
        const pageKey = nativePageKey(source, page)
        let text = nativePages.get(pageKey) ?? ''
        let start = text.indexOf(request.quote)
        if (start < 0) {
          start = text.length + (text ? 1 : 0)
          text += `${text ? '\n' : ''}${request.quote}`
          nativePages.set(pageKey, text)
        }
        const refId = `pdfref_00000000-0000-4000-8000-${String(++referenceSequence).padStart(12, '0')}`
        references.set(refId, { documentId: source.id, path: source.path, contentVersion: source.contentVersion,
          text: request.quote, page, start, end: start + request.quote.length,
          fragments: request.fragments.map(fragment => ({ page: fragment.page, rect: [...fragment.rect], quadPoints: [...fragment.quadPoints] })) })
        return { text: request.quote, documentId: source.id, sourcePath: source.path,
          sourceDigest: source.reader.bytesHash, sourceVersion: source.sourceVersion,
          contentVersion: source.contentVersion, revision: source.revision,
          excerpts: [{ page, text: request.quote, refId, startUtf16: start, endUtf16: start + request.quote.length }] }
      },
      async revalidate(request): Promise<TextRevalidationResult> {
        revalidations.push(structuredClone(request))
        const source = currentOptions.currentSnapshot()
        if (!source || source.conflict || source.id !== request.documentId || source.revision !== request.expectedRevision
          || source.contentVersion !== request.expectedContentVersion) rejectStale()
        const selections = request.selections.map(item => {
          const checked = item.refIds.map(refId => {
            const ref = references.get(refId)
            if (!ref || ref.documentId !== source.id || ref.path !== source.path || ref.contentVersion !== source.contentVersion
              || nativePages.get(nativePageKey(source, ref.page))?.slice(ref.start, ref.end) !== ref.text) rejectStale()
            return { refId, ref }
          })
          return { id: item.id, text: checked.map(item => item.ref.text).join('\n'),
            fragments: checked.flatMap(({ refId, ref }) => structuredClone(nativeGeometry.get(refId) ?? ref.fragments)),
            evidenceRefs: [...item.refIds] }
        })
        return { documentId: source.id, sourcePath: source.path, sourceDigest: source.reader.bytesHash,
          sourceVersion: source.sourceVersion, contentVersion: source.contentVersion, revision: source.revision, selections }
      },
    },
    allowReadingContext: true, screenshotBusy: false, displayReady: true, mode: 'text',
    regionPurpose: { current: null }, ownerSequence: { current: 1 }, currentSnapshot: () => snapshot,
    inspectSource: async () => currentOptions.currentSnapshot()?.reader.bytesHash ?? null,
    documentReady: () => true, setMode() {}, setSelection() {}, clearSelection() {}, clearAnnotation() {},
    closeToolsMenu() {}, t: key => key,
  }
  const render = async (next: ReaderExplanationOptions) => {
    currentOptions = next
    await act(async () => { root.render(React.createElement(Harness, next)) })
  }
  try { await render(options); await run({ state: () => latest!, options, render, prompts, window: dom, revalidations,
    replaceNativePage(page, text) { const source = currentOptions.currentSnapshot(); assert.ok(source); nativePages.set(nativePageKey(source, page), text) },
    setNativeGeometry(refId, fragments) { assert.ok(references.has(refId)); nativeGeometry.set(refId, structuredClone(fragments)) },
  }) }
  finally {
    await act(async () => root.unmount())
    tab.abort()
    restoreDom()

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

test('switching from an explanation image region back to text cancels capture intent and keeps saved materials', async () => {
  await withExplanation(async ({ state, options, render }) => {
    let mode: 'text' | 'region' | 'note' = 'text', cleared = 0
    await render({ ...options, pdf: { numPages: 3 } as NativeDocument,
      regionEvidence: { async prepare() { throw new Error('switching input mode must not capture an image') } },
      setMode(value) { mode = typeof value === 'function' ? value(mode) : value },
      clearSelection() { cleared++ } })
    await act(async () => { state().selectText() })
    assert.equal(cleared, 0, 'inactive explanation controls cannot affect ordinary reading selections')
    await act(async () => { state().start(selection) })
    await act(async () => { state().setEditor(editor => editor ? { ...editor, question: 'Saved question' } : editor) })
    await act(async () => { await state().saveQuestion() })
    const saved = state().active!.excerpts[0]
    await act(async () => { state().beginRegion() })
    assert.equal(mode, 'region')
    assert.equal(options.regionPurpose.current, 'explanation')
    await act(async () => { state().offerTextSelection({ ...selection, revision: selection.revision + 1 }) })
    assert.equal(state().error, 'reader.explain.sourceChanged')
    cleared = 0
    await act(async () => { state().selectText() })
    assert.equal(mode, 'text')
    assert.equal(options.regionPurpose.current, null)
    assert.equal(cleared, 1)
    assert.equal(state().error, '')
    assert.equal(state().active?.excerpts[0], saved)
    assert.equal(state().selectRegion(2, { rect: [0, 0, 20, 20], quadPoints: [] }), false,
      'a late rectangle completion cannot create an image question after text mode is selected')

    await act(async () => { state().offerTextSelection(selection) })
    await act(async () => { state().setEditor(editor => editor ? { ...editor, question: 'Keep this unsaved question' } : editor) })
    const pending = state().editor
    cleared = 0
    await act(async () => { state().selectText() })
    assert.equal(state().editor, pending)
    assert.equal(cleared, 0, 'mode changes cannot discard an unfinished question')
  })
})

test('editing another material cannot overwrite an unfinished new or existing question', async () => {
  await withExplanation(async ({ state }) => {
    await act(async () => { state().start(selection) })
    await act(async () => { state().setEditor(editor => editor ? { ...editor, question: 'First saved question' } : editor) })
    await act(async () => { await state().saveQuestion() })
    await act(async () => { state().offerTextSelection({ ...selection, text: 'Second passage' }) })
    await act(async () => { state().setEditor(editor => editor ? { ...editor, question: 'Second saved question' } : editor) })
    await act(async () => { await state().saveQuestion() })
    const [first, second] = state().active!.excerpts
    await act(async () => { state().editQuestion(first.id) })
    await act(async () => { state().setEditor(editor => editor ? { ...editor, question: 'Unsaved revision of the first question' } : editor) })
    const pendingEdit = state().editor
    await act(async () => { state().editQuestion(second.id) })
    assert.equal(state().editor, pendingEdit)
    assert.equal(state().error, 'reader.explain.finishQuestion')
    assert.deepEqual(state().active?.excerpts.map(item => item.question), ['First saved question', 'Second saved question'])

    await act(async () => { state().cancelEditor() })
    await act(async () => { state().offerTextSelection({ ...selection, text: 'An unfinished third passage' }) })
    await act(async () => { state().setEditor(editor => editor ? { ...editor, question: 'Unsaved third question' } : editor) })
    const pendingNew = state().editor
    await act(async () => { state().editQuestion(first.id) })
    assert.equal(state().editor, pendingNew)
    assert.equal(state().error, 'reader.explain.finishQuestion')
    assert.equal(state().active?.excerpts.length, 2)
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
    assert.deepEqual(prompts, [], 'reopening does not itself submit or rebind evidence')
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
    await render({ ...options, t, textSelectionEvidence: { ...options.textSelectionEvidence!, async prepare() {
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

test('an old selection is refused when its registered native page text has actually changed', async () => {
  await withExplanation(async ({ state, options, render, prompts, replaceNativePage }) => {
    await act(async () => { state().start(selection) })
    await act(async () => { state().setEditor(current => current ? { ...current, question: 'Why?' } : current) })
    await act(async () => { await state().saveQuestion() })
    replaceNativePage(3, 'The original paragraph has been replaced.')
    const changed = { ...snapshot, revision: 8, sourceVersion: 'fs-2',
      reader: { ...snapshot.reader, bytesHash: `sha256:${'b'.repeat(64)}` } }
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
    await render({ ...options, textSelectionEvidence: { ...options.textSelectionEvidence!, async prepare() { return {
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
    await render({ ...options, textSelectionEvidence: { ...options.textSelectionEvidence!, async prepare() { throw new Error('Host evidence unavailable') } } })
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

type ExplanationFixture = Parameters<Parameters<typeof withExplanation>[0]>[0]

async function saveNativeQuestion(fixture: ExplanationFixture, selected: ReaderSelection, question: string) {
  const { state } = fixture
  await act(async () => { if (state().active) state().offerTextSelection(selected); else state().start(selected) })
  assert.equal(state().editor?.kind, 'new')
  await act(async () => { state().setEditor(editor => editor ? { ...editor, question } : editor) })
  await act(async () => { await state().saveQuestion() })
  assert.equal(state().error, '')
  const saved = state().active?.excerpts.at(-1)
  assert.equal(saved?.question, question)
  return saved!
}

function annotationEdited(source: WorkspaceSnapshot): WorkspaceSnapshot {
  return { ...source, revision: source.revision + 1, dirty: true, document: { ...source.document,
    annotations: [...source.document.annotations, { id: 'ordinary-mark', subtype: 'Highlight', page: 1,
      flags: 4, supported: true, editable: true, rect: [1, 2, 30, 20], contents: 'A separate ordinary annotation' }] } }
}

test('two saved questions survive an ordinary annotation revision only after one Host batch revalidates their native refs', async () => {
  await withExplanation(async fixture => {
    const { state, options, render, prompts, revalidations, setNativeGeometry } = fixture
    let current = snapshot, accept!: () => void
    const input = { ...options, currentSnapshot: () => current, promptExplanation: async (prompt: unknown) => {
      prompts.push(prompt)
      await new Promise<void>(resolve => { accept = resolve })
    } }
    await render(input)
    const first = await saveNativeQuestion(fixture, selection, 'Why does the first paragraph matter?')
    const second = await saveNativeQuestion(fixture, { ...selection, text: 'Another paragraph' }, 'How is the second paragraph related?')
    assert.equal(first.kind, 'text'); assert.equal(second.kind, 'text')
    if (first.kind !== 'text' || second.kind !== 'text') throw new Error('Expected text evidence')
    const refreshed = [{ page: 3, rect: [18, 24, 108, 44] as [number, number, number, number],
      quadPoints: [18, 44, 108, 44, 18, 24, 108, 24] }]
    setNativeGeometry(first.evidenceRefs![0]!, refreshed)
    current = annotationEdited(current)
    await render({ ...input, snapshot: current })
    assert.equal(current.revision, snapshot.revision + 1)
    assert.equal(current.document.annotations.length, 1)
    assert.equal(state().active?.excerpts.length, 2, 'ordinary annotation edits do not silently discard pending questions')
    let pending!: Promise<void>
    await act(async () => { pending = state().submit() })
    assert.deepEqual(state().active?.excerpts[0]?.fragments, refreshed, 'current native geometry replaces the captured rectangles only after Host verification')
    assert.equal(state().active?.source.revision, current.revision)
    assert.equal(revalidations.length, 1, 'all saved passages share one current-revision batch fence')
    assert.deepEqual(revalidations[0], { sessionId: options.sessionId, documentId: current.id,
      expectedRevision: current.revision, expectedContentVersion: current.contentVersion,
      selections: [first, second].map(item => ({ id: item.id, refIds: item.kind === 'text' ? item.evidenceRefs : [] })) })
    assert.equal(prompts.length, 1)
    const prompt = JSON.stringify(prompts[0])
    for (const item of [first, second]) {
      assert.ok(prompt.includes(item.question))
      if (item.kind === 'text') { assert.ok(prompt.includes(item.text)); for (const ref of item.evidenceRefs!) assert.ok(prompt.includes(ref)) }
    }
    await act(async () => { accept(); await pending })
    assert.equal(state().active, null)
    assert.equal(state().error, '')
  })
})

test('a same-file save changing bytes and filesystem version can submit both questions only when native text still verifies', async () => {
  await withExplanation(async fixture => {
    const { state, options, render, prompts, revalidations } = fixture
    let current = snapshot
    await render({ ...options, currentSnapshot: () => current })
    await saveNativeQuestion(fixture, selection, 'Explain the first passage.')
    await saveNativeQuestion(fixture, { ...selection, text: 'Second passage' }, 'Explain the second passage.')
    const edited = annotationEdited(current)
    current = { ...edited, revision: edited.revision + 1, dirty: false, sourceVersion: 'fs-after-save',
      reader: { ...edited.reader, bytesHash: `sha256:${'b'.repeat(64)}`, generation: edited.reader.generation + 1 } }
    await render({ ...options, snapshot: current, currentSnapshot: () => current })
    await act(async () => { await state().submit() })
    assert.equal(revalidations.length, 1)
    assert.equal(revalidations[0]?.expectedRevision, current.revision)
    assert.equal(prompts.length, 1)
    assert.match(JSON.stringify(prompts[0]), /Explain the first passage/)
    assert.match(JSON.stringify(prompts[0]), /Explain the second passage/)
    assert.equal(state().error, '')
  })
})

test('Host revalidation failure cannot discard the two saved questions or admit a partial explanation', async () => {
  await withExplanation(async fixture => {
    const { state, options, render, prompts } = fixture
    let current = snapshot, calls = 0
    const input = { ...options, currentSnapshot: () => current,
      textSelectionEvidence: { ...options.textSelectionEvidence!, async revalidate() {
        calls++
        throw Object.assign(new Error('Saved text no longer exists in the native page'), { code: 'pdf/stale-reader' })
      } } }
    await render(input)
    await saveNativeQuestion(fixture, selection, 'Keep question one.')
    await saveNativeQuestion(fixture, { ...selection, text: 'Second passage' }, 'Keep question two.')
    const before = state().active
    current = annotationEdited(current)
    await render({ ...input, snapshot: current })
    await act(async () => { await state().submit() })
    assert.equal(calls, 1)
    assert.deepEqual(prompts, [])
    assert.deepEqual(state().active?.excerpts, before?.excerpts)
    assert.ok(state().error)
    assert.equal(state().sending, false)
  })
})

test('a snapshot mutation during batch revalidation cannot send or rewrite the saved materials', async () => {
  await withExplanation(async fixture => {
    const { state, options, render, prompts } = fixture
    let current = snapshot, finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const input = { ...options, currentSnapshot: () => current,
      textSelectionEvidence: { ...options.textSelectionEvidence!, async revalidate(request: TextRevalidationRequest, signal?: AbortSignal) {
        const checked = await options.textSelectionEvidence!.revalidate(request, signal)
        await gate
        return checked
      } } }
    await render(input)
    await saveNativeQuestion(fixture, selection, 'First question.')
    await saveNativeQuestion(fixture, { ...selection, text: 'Another paragraph' }, 'Second question.')
    const before = state().active
    current = annotationEdited(current)
    await render({ ...input, snapshot: current })
    let pending!: Promise<void>
    await act(async () => { pending = state().submit() })
    assert.equal(state().sending, true)
    current = { ...current, revision: current.revision + 1 }
    await render({ ...input, snapshot: current })
    await act(async () => { finish(); await pending })
    assert.deepEqual(prompts, [])
    assert.deepEqual(state().active?.excerpts, before?.excerpts)
    assert.ok(state().error)
    assert.equal(state().sending, false)
  })
})

test('malformed batch identity or substituted passage text never enters a model turn', async () => {
  const mutations: Array<[string, (value: TextRevalidationResult) => TextRevalidationResult]> = [
    ['document', value => ({ ...value, documentId: 'another-document' })],
    ['path', value => ({ ...value, sourcePath: '/another.pdf' })],
    ['digest', value => ({ ...value, sourceDigest: `sha256:${'c'.repeat(64)}` })],
    ['filesystem version', value => ({ ...value, sourceVersion: 'fs-other' })],
    ['content version', value => ({ ...value, contentVersion: 'another-content' })],
    ['revision', value => ({ ...value, revision: value.revision + 1 })],
    ['text', value => ({ ...value, selections: value.selections.map((item, index) => index ? item : { ...item, text: 'Substituted text' }) })],
    ['selection ID', value => ({ ...value, selections: value.selections.map((item, index) => index ? item : { ...item, id: 'unexpected-item' }) })],
    ['missing selection', value => ({ ...value, selections: value.selections.slice(0, 1) })],
    ['substituted ref', value => ({ ...value, selections: value.selections.map((item, index) => index ? item
      : { ...item, evidenceRefs: ['pdfref_00000000-0000-4000-8000-000000000098'] }) })],
    ['another page', value => ({ ...value, selections: value.selections.map((item, index) => index ? item
      : { ...item, fragments: item.fragments.map(fragment => ({ ...fragment, page: fragment.page + 1 })) }) })],
  ]
  for (const [name, mutate] of mutations) await withExplanation(async fixture => {
    const { state, options, render, prompts } = fixture
    let current = snapshot
    const input = { ...options, currentSnapshot: () => current,
      textSelectionEvidence: { ...options.textSelectionEvidence!, async revalidate(request: TextRevalidationRequest, signal?: AbortSignal) {
        return mutate(await options.textSelectionEvidence!.revalidate(request, signal))
      } } }
    await render(input)
    await saveNativeQuestion(fixture, selection, 'Do not lose this question.')
    await saveNativeQuestion(fixture, { ...selection, text: 'Another paragraph' }, 'Or this other question.')
    const before = state().active
    current = annotationEdited(current)
    await render({ ...input, snapshot: current })
    await act(async () => { await state().submit() })
    assert.deepEqual(prompts, [], `${name} mismatch cannot be submitted`)
    assert.deepEqual(state().active?.excerpts, before?.excerpts, `${name} mismatch preserves the complete original draft`)
    assert.ok(state().error, `${name} mismatch surfaces a failure`)
    assert.equal(state().sending, false)
  })
})

test('region-only and mixed materials retain their exact original source after an annotation edit', async () => {
  for (const mixed of [false, true]) await withExplanation(async fixture => {
    const { state, options, render, prompts, revalidations } = fixture
    let current = snapshot, preparedImages = 0
    const input = { ...options, currentSnapshot: () => current, pdf: { numPages: 3 } as NativeDocument,
      regionEvidence: { async prepare() { return {
        refId: 'pdfref_00000000-0000-4000-8000-000000000099', documentId: current.id, sourcePath: current.path,
        sourceDigest: current.reader.bytesHash, sourceVersion: current.sourceVersion,
        contentVersion: current.contentVersion, revision: current.revision, page: 2,
        rectPdf: [0, 0, 20, 20] as [number, number, number, number], mediaType: 'image/png' as const,
        width: 20, height: 20, bytes: new Uint8Array([1, 2, 3]),
      } } }, imageUnderstanding: { ...options.imageUnderstanding, async prepareReference(): Promise<never> {
        preparedImages++
        throw new Error('An image from an obsolete source must not be prepared')
      } } }
    await render(input)
    if (mixed) await saveNativeQuestion(fixture, selection, 'A text question.')
    else await act(async () => { state().start() })
    await act(async () => { state().beginRegion(); state().selectRegion(2, { rect: [0, 0, 20, 20], quadPoints: [] }) })
    await act(async () => { state().setEditor(editor => editor ? { ...editor, question: 'An image question.' } : editor) })
    await act(async () => { await state().saveQuestion() })
    assert.equal(state().active?.excerpts.length, mixed ? 2 : 1)
    const before = state().active
    current = annotationEdited(current)
    await render({ ...input, snapshot: current })
    await act(async () => { await state().submit() })
    assert.deepEqual(prompts, [])
    assert.deepEqual(state().active?.excerpts, before?.excerpts)
    assert.equal(state().error, 'reader.explain.sourceChanged')
    assert.equal(preparedImages, 0)
    assert.equal(revalidations.length, 0, 'text proof cannot refresh an image or a mixed explanation')
  })
})

test('text capture still uses the exact revision when an ordinary annotation changes during prepare', async () => {
  await withExplanation(async ({ state, options, render, prompts, revalidations }) => {
    let current = snapshot, finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const input = { ...options, currentSnapshot: () => current,
      textSelectionEvidence: { ...options.textSelectionEvidence!, async prepare(request: Parameters<TextEvidenceApi['prepare']>[0], signal?: AbortSignal) {
        const captured = await options.textSelectionEvidence!.prepare(request, signal)
        await gate
        return captured
      } } }
    await render(input)
    await act(async () => { state().start(selection) })
    await act(async () => { state().setEditor(editor => editor ? { ...editor, question: 'Keep my uncommitted question.' } : editor) })
    let pending!: Promise<void>
    await act(async () => { pending = state().saveQuestion() })
    current = annotationEdited(current)
    await render({ ...input, snapshot: current })
    await act(async () => { finish(); await pending })
    assert.equal(state().active?.excerpts.length, 0)
    assert.equal(state().editor?.question, 'Keep my uncommitted question.')
    assert.equal(state().error, 'reader.explain.sourceChanged')
    assert.equal(state().saving, false)
    assert.deepEqual(prompts, [])
    assert.equal(revalidations.length, 0, 'send-time proof renewal must not relax capture CAS')
  })
})

test('an unregistered saved ref cannot be replaced by the Client excerpt text during submission', async () => {
  await withExplanation(async fixture => {
    const { state, options, render, prompts, revalidations } = fixture
    const unknownRef = 'pdfref_00000000-0000-4000-8000-000000000098'
    await render({ ...options, textSelectionEvidence: { ...options.textSelectionEvidence!,
      async prepare(request, signal) {
        const captured = await options.textSelectionEvidence!.prepare(request, signal)
        return { ...captured, excerpts: captured.excerpts.map(item => ({ ...item, refId: unknownRef })) }
      } } })
    await saveNativeQuestion(fixture, selection, 'The UI text is not a native reference proof.')
    const before = state().active
    await act(async () => { await state().submit() })
    assert.equal(revalidations.length, 1)
    assert.deepEqual(revalidations[0]?.selections[0]?.refIds, [unknownRef])
    assert.deepEqual(prompts, [])
    assert.deepEqual(state().active?.excerpts, before?.excerpts)
    assert.equal(state().error, 'reader.explain.sourceChanged')
  })
})

test('a different Reader owner cannot accept a late successful text batch for the same document', async () => {
  await withExplanation(async fixture => {
    const { state, options, render, prompts } = fixture
    let current = snapshot, finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const input = { ...options, currentSnapshot: () => current,
      textSelectionEvidence: { ...options.textSelectionEvidence!, async revalidate(request: TextRevalidationRequest, signal?: AbortSignal) {
        const checked = await options.textSelectionEvidence!.revalidate(request, signal)
        await gate
        return checked
      } } }
    await render(input)
    await saveNativeQuestion(fixture, selection, 'Keep the original owner question.')
    const before = state().active
    current = annotationEdited(current)
    await render({ ...input, snapshot: current })
    let pending!: Promise<void>
    await act(async () => { pending = state().submit() })
    options.ownerSequence.current++
    await act(async () => { finish(); await pending })
    assert.deepEqual(prompts, [])
    assert.deepEqual(state().active?.excerpts, before?.excerpts)
    assert.equal(state().sending, false)
  })
})

test('saved text cannot be sent when the Host revalidation service is no longer available', async () => {
  await withExplanation(async fixture => {
    const { state, options, render, prompts, revalidations } = fixture
    await saveNativeQuestion(fixture, selection, 'Keep this question if the connection is lost.')
    await render({ ...options, textSelectionEvidence: undefined })
    await act(async () => { await state().submit() })
    assert.deepEqual(prompts, [])
    assert.deepEqual(revalidations, [])
    assert.equal(state().active?.excerpts[0]?.question, 'Keep this question if the connection is lost.')
    assert.equal(state().error, 'reader.explain.sourceChanged')
    assert.equal(state().sending, false)
  })
})

test('mixed explanations cannot admit a late image preparation after the revision or Reader owner changes', async t => {
  for (const changed of ['revision', 'owner'] as const) await t.test(changed, async () => {
    await withExplanation(async fixture => {
      const { state, options, render, prompts, revalidations } = fixture
      let current = snapshot, finish!: () => void, imageCalls = 0
      const gate = new Promise<void>(resolve => { finish = resolve })
      const regionRef = 'pdfref_00000000-0000-4000-8000-000000000099'
      const input: ReaderExplanationOptions = { ...options, currentSnapshot: () => current,
        pdf: { numPages: 3 } as NativeDocument,
        regionEvidence: { async prepare() { return {
          refId: regionRef, documentId: current.id, sourcePath: current.path,
          sourceDigest: current.reader.bytesHash, sourceVersion: current.sourceVersion,
          contentVersion: current.contentVersion, revision: current.revision, page: 2,
          rectPdf: [0, 0, 20, 20], mediaType: 'image/png', width: 20, height: 20, bytes: new Uint8Array([1, 2, 3]),
        } } },
        imageUnderstanding: { ...options.imageUnderstanding, async prepareReference(request) {
          imageCalls++
          const source = current
          await gate
          return { kind: 'direct-image', backendId: 'test', requestedRefId: request.refId,
            provenance: { backendId: 'test', mode: 'session-vision' },
            evidence: { refId: request.refId, documentId: source.id, page: 2,
              locator: { kind: 'pdf-region', rectPdf: [0, 0, 20, 20] },
              sourceDigest: source.reader.bytesHash, sourceVersion: source.sourceVersion,
              contentVersion: source.contentVersion, revision: source.revision,
              renderedImageSha256: source.reader.bytesHash },
            image: { mediaType: 'image/png', data: new Uint8Array([9, 9, 9]), width: 20, height: 20 } }
        } },
      }
      await render(input)
      await saveNativeQuestion(fixture, selection, 'Keep the verified text question.')
      await act(async () => { state().beginRegion(); state().selectRegion(2, { rect: [0, 0, 20, 20], quadPoints: [] }) })
      await act(async () => { state().setEditor(editor => editor ? { ...editor, question: 'Keep the image question too.' } : editor) })
      await act(async () => { await state().saveQuestion() })
      const before = state().active
      assert.equal(before?.excerpts.length, 2)
      let pending!: Promise<void>
      await act(async () => { pending = state().submit() })
      assert.equal(revalidations.length, 1, 'the native text batch completed before the image await')
      assert.equal(imageCalls, 1)
      assert.equal(state().sending, true)
      if (changed === 'revision') {
        current = annotationEdited(current)
        await render({ ...input, snapshot: current })
      } else options.ownerSequence.current++
      await act(async () => { finish(); await pending })
      assert.deepEqual(prompts, [], `${changed} changes while preparing a mixed image must prevent Session admission`)
      assert.deepEqual(state().active?.excerpts, before?.excerpts, 'both original questions and their material remain available')
      assert.equal(state().sending, false)
      if (changed === 'revision') assert.equal(state().error, 'reader.explain.sourceChanged')
    })
  })
})
