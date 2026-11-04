import { createDom } from '../../support/dom.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { ReaderSelection } from '../../../src/modules/viewer/model/reader-selection.ts'
import { defaultSettings, type WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import { translationContextLimit, TranslationRegistry, type TranslationEngine, type TranslationRequest } from '../../../src/translation/index.ts'
import type { HostOcrRecognition } from '../../../src/modules/viewer/ports/ocr.ts'
import { useReaderTranslation, type ReaderTranslationOptions } from '../../../src/modules/viewer/index.ts'
import { createHostTranslations, type TranslationHostContext } from '../../../src/adapters/host/dsh/translations.ts'
import { createHostTranslationEngine } from '../../../src/adapters/client/remote/translation-api.ts'

const source: ReaderSelection = { kind: 'text', revision: 4, text: 'contextual words',
  selectionBefore: 'before', selectionAfter: 'after',
  fragments: [{ page: 2, rect: [1, 2, 3, 4], quadPoints: [] }] }
const snapshot = { id: 'doc-1', revision: 4, contentVersion: 'v1' } as WorkspaceSnapshot
const transcript: HostOcrRecognition = { documentId: 'doc-1', page: 3, revision: 4, contentVersion: 'v1',
  text: '  First OCR sentence.\nSecond OCR sentence.  ', status: 'complete',
  source: { backendId: 'local-tesseract', backendVersion: '1' }, geometry: { status: 'none' }, warnings: [] }

async function withTranslation(run: (fixture: {
  state(): ReturnType<typeof useReaderTranslation>
  options: ReaderTranslationOptions
  render(options: ReaderTranslationOptions): Promise<void>
  opened(): number
  requests: TranslationRequest[]
  unmount(): Promise<void>
}) => Promise<void>, respond: TranslationEngine['translate'] = async () => ({ text: '译文', status: 'complete', warnings: [] })): Promise<void> {
  const { dom, restore: restoreDom, install: installDom } = createDom('<!doctype html><html><body><div id="root"></div></body></html>', { globals: [] })

  installDom({ window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })
  const root = createRoot(dom.document.getElementById('root')!)
  const registry = new TranslationRegistry({ timeoutMs: 1_000, maxInputCharacters: 200, maxOutputCharacters: 200 })
  const requests: TranslationRequest[] = []
  registry.register({ descriptor: { id: 'fake', name: 'Fake', version: '1', execution: 'local' },
    translate: async (request, config) => { requests.push(request); return respond(request, config) } })
  registry.select({ id: 'account', engineId: 'fake', configurationRevision: '1', config: {} })
  let latest: ReturnType<typeof useReaderTranslation> | undefined
  let current = snapshot
  let opened = 0
  const Harness = (props: ReaderTranslationOptions) => { latest = useReaderTranslation(props); return null }
  const options: ReaderTranslationOptions = { translation: registry, sessionId: 'chat-1',
    tabSignal: new AbortController().signal, snapshot, displayOwnerToken: 1,
    ownerSequence: { current: 1 }, currentSnapshot: () => current,
    selection: source, targetLanguage: 'zh', engine: 'fake', timeoutMs: 800,
    showSidebar: () => { opened++ } }
  const render = async (next: ReaderTranslationOptions) => {
    current = next.snapshot ?? current
    await act(async () => root.render(React.createElement(Harness, next)))
  }
  let unmounted = false
  const unmount = async () => { if (!unmounted) { unmounted = true; await act(async () => root.unmount()) } }
  try {
    await render(options)
    await run({ state: () => latest!, options, render, opened: () => opened, requests, unmount })
  } finally {
    await unmount()
    registry.dispose()
    restoreDom()

  }
}

test('translation captures selected text, nearby words, page and current session', async () => {
  await withTranslation(async ({ state, opened, requests }) => {
    await act(async () => state().begin())
    assert.equal(opened(), 1)
    assert.equal(state().selection?.text, source.text)
    assert.equal(state().selection?.targetLanguage, 'zh')
    const result = await state().translate({ text: source.text, targetLanguage: 'zh' })
    assert.equal(result.text, '译文')
    assert.deepEqual((requests[0] as { context: unknown }).context, {
      sessionId: 'chat-1', documentId: 'doc-1', contentVersion: 'v1', pages: [2],
      selectionBefore: 'before', selectionAfter: 'after',
    })
    await act(async () => state().close())
    assert.equal(state().selection, null)
  })
})

test('translation rejects a stale owner and resets when the source changes', async () => {
  await withTranslation(async ({ state, options, render, opened }) => {
    await render({ ...options, displayOwnerToken: 2 })
    await act(async () => state().begin())
    assert.equal(opened(), 0)
    await render(options)
    await act(async () => state().begin())
    assert.equal(state().selection?.documentId, 'doc-1')
    await act(async () => state().reset())
    assert.equal(state().selection, null)
    await act(async () => { await assert.rejects(state().translate({ text: source.text, targetLanguage: 'zh' })) })
  })
})

test('a text-only OCR transcript translates in full through the same session service and selected language', async () => {
  await withTranslation(async ({ state, options, render, opened, requests }) => {
    await render({ ...options, selection: null, targetLanguage: 'ja' })
    await act(async () => { assert.equal(state().beginOcr(transcript), true) })
    assert.equal(opened(), 1)
    assert.equal(state().selection?.text, transcript.text)
    assert.equal(state().selection?.targetLanguage, 'ja')
    assert.deepEqual(state().selection?.pages, [3])
    assert.equal(state().selection?.ocrRevision, 4)
    assert.equal(state().selection?.sourceKind, 'ocr')
    assert.equal((await state().translate({ text: transcript.text, targetLanguage: 'ja' })).text, '译文')
    assert.equal(requests[0]!.text, transcript.text, 'no trimming, correction or invented OCR geometry')
    assert.deepEqual(requests[0]!.context, { sessionId: 'chat-1', documentId: 'doc-1', contentVersion: 'v1', pages: [3] })
  })
})

test('partial OCR translation uses exact offsets even for repeated text and provides bounded adjacent context', async () => {
  await withTranslation(async ({ state, requests }) => {
    const text = `${'A'.repeat(300)}😀 repeat this; repeat this 😀${'Z'.repeat(300)}`
    const selected = 'repeat this', start = text.lastIndexOf(selected), end = start + selected.length
    await act(async () => { assert.equal(state().beginOcr({ ...transcript, text }, { start, end }), true) })
    assert.equal(state().selection!.text, selected)
    await state().translate({ text: selected, targetLanguage: 'zh' })
    const context = requests[0]!.context!
    assert.equal(context.selectionBefore, text.slice(start - translationContextLimit, start))
    assert.equal(context.selectionAfter, text.slice(end, end + translationContextLimit))
    assert.ok(context.selectionBefore!.length <= translationContextLimit && context.selectionAfter!.length <= translationContextLimit)
    assert.equal(requests[0]!.text, selected)
  })
})

test('OCR translation refuses stale identity, revision, owner, closed tab and unmounted callbacks', async () => {
  await withTranslation(async ({ state, options, render, opened, unmount }) => {
    for (const changed of [{ documentId: 'other' }, { contentVersion: 'old' }, { revision: 3 }, { page: 0 }]) {
      await act(async () => { assert.equal(state().beginOcr({ ...transcript, ...changed }), false) })
    }
    await render({ ...options, displayOwnerToken: 2 })
    await act(async () => { assert.equal(state().beginOcr(transcript), false) })
    const tab = new AbortController()
    await render({ ...options, tabSignal: tab.signal })
    tab.abort()
    await act(async () => { assert.equal(state().beginOcr(transcript), false) })
    await render(options)
    await unmount()
    assert.equal(state().beginOcr(transcript), false)
    assert.equal(opened(), 0)
  })
})

test('OCR ranges reject empty, invalid and half-surrogate selections without opening translation', async () => {
  await withTranslation(async ({ state, opened }) => {
    const result = { ...transcript, text: ' 😀 text  ' }
    for (const range of [{ start: 0, end: 0 }, { start: 0, end: 1 }, { start: 3, end: 2 },
      { start: -1, end: 3 }, { start: 0, end: 99 }, { start: 0.5, end: 4 },
      { start: 2, end: 5 }, { start: 0, end: 2 }, { start: NaN, end: 4 }]) {
      await act(async () => { assert.equal(state().beginOcr(result, range), false, JSON.stringify(range)) })
    }
    await act(async () => { assert.equal(state().beginOcr({ ...transcript, text: ' \n ' }), false) })
    assert.equal(opened(), 0)
    await act(async () => { assert.equal(state().beginOcr(result, { start: 1, end: 3 }), true) })
    assert.equal(state().selection?.text, '😀')
  })
})

test('OCR partial context never splits Unicode characters at its bounded edges', async () => {
  await withTranslation(async ({ state }) => {
    const length = translationContextLimit - 1
    const text = `😀${'A'.repeat(length)}pick${'Z'.repeat(length)}😀`
    const start = text.indexOf('pick'), end = start + 4
    await act(async () => { assert.equal(state().beginOcr({ ...transcript, text }, { start, end }), true) })
    assert.equal(state().selection?.selectionBefore, 'A'.repeat(length))
    assert.equal(state().selection?.selectionAfter, 'Z'.repeat(length))
  })
})

test('partial OCR paragraph translation crosses the real Client and Host input contract with bounded original context', async () => {
  const modelRequests: Array<{ text: string; target_language: string; nearby_text: { before: string; after: string } }> = []
  const host = createHostTranslations({
    get(key: string) {
      if (key !== 'llm') return undefined
      return { async *stream(options: { messages: Array<{ content: Array<{ text: string }> }> }) {
        modelRequests.push(JSON.parse(options.messages[0]!.content[0]!.text))
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ kind: 'sentence', translation: '泛化到未见过的样本。' }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } }
    },
    sessionController: { async resolveAgent() { return { agent: { session: {
      requestHeader: () => ({ config: { provider: 'controlled', model: 'controlled' } }),
    } } } } },
  } as unknown as TranslationHostContext, 'test', () => defaultSettings)
  const payloads: Record<string, unknown>[] = []
  try {
    await withTranslation(async ({ state, options, render }) => {
      options.translation.register(createHostTranslationEngine({ rpc: { async call(path, method, payload, active) {
        assert.equal(path, '/api'); assert.equal(method, 'pdf.translation'); assert.ok(active)
        const request = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
        payloads.push(request)
        return { ok: true, value: await host.dispatch('chat-1', request,
          { session: { id: 'chat-1', header: {} } }, active) }
      } } }, options.tabSignal, { id: 'dsh-model', name: 'DSH Model', version: '1', execution: 'remote' }))
      options.translation.select({ id: 'host-account', engineId: 'dsh-model', configurationRevision: '1', config: {} })
      await render({ ...options, engine: 'dsh-model', timeoutMs: 1000 })
      const before = 'The model learns from the training samples. '.repeat(8)
      const selected = 'generalize to unseen examples'
      const after = ' Evaluation uses a separate test set to estimate how well the model performs. '.repeat(7)
      const text = `${before}${selected}${after}`, start = before.length, end = start + selected.length
      assert.ok(before.length > 240 && after.length > 240, 'the page excerpt exceeds both the old UI and Host context bounds')
      await act(async () => { assert.equal(state().beginOcr({ ...transcript, text }, { start, end }), true) })
      const result = await state().translate({ text: selected, sourceLanguage: 'auto', targetLanguage: 'zh' })
      assert.equal(result.text, '泛化到未见过的样本。')
      assert.equal(payloads.length, 1)
      const context = payloads[0]!.context as TranslationRequest['context']
      assert.equal(context?.documentId, 'doc-1'); assert.deepEqual(context?.pages, [3])
      assert.equal(context?.selectionBefore, before.slice(-translationContextLimit))
      assert.equal(context?.selectionAfter, after.slice(0, translationContextLimit))
      assert.equal(modelRequests[0]!.text, selected, 'the selected text is never trimmed to satisfy context limits')
      assert.deepEqual(modelRequests[0]!.nearby_text, {
        before: before.slice(-translationContextLimit), after: after.slice(0, translationContextLimit),
      })
      assert.equal(modelRequests[0]!.target_language, 'zh')
    })
  } finally { host.registry.dispose() }
})

test('OCR translation is cancelled when replaced and stale source revisions cannot publish a late result', async () => {
  let resolve!: (value: { text: string; status: 'complete'; warnings: string[] }) => void
  const gate = new Promise<{ text: string; status: 'complete'; warnings: string[] }>(done => { resolve = done })
  await withTranslation(async ({ state, requests, options, render }) => {
    await act(async () => { assert.equal(state().beginOcr(transcript), true) })
    const pending = state().translate({ text: transcript.text, targetLanguage: 'zh' })
    const rejected = assert.rejects(pending)
    for (let i = 0; i < 10 && !requests.length; i++) await Promise.resolve()
    await act(async () => { assert.equal(state().beginOcr(transcript, { start: 2, end: 7 }), true) })
    assert.equal(requests[0]!.signal!.aborted, true)
    resolve({ text: 'late', status: 'complete', warnings: [] })
    await rejected
    await render({ ...options, snapshot: { ...snapshot, revision: 5 } })
    await assert.rejects(state().translate({ text: 'First', targetLanguage: 'zh' }), { code: 'stale-result' })
  }, async () => gate)
})

for (const changed of [{ contentVersion: 'v2' }, { revision: 5 }]) test(`OCR result cannot publish after ${Object.keys(changed)[0]} changes while the engine is running`, async () => {
  let resolve!: (value: { text: string; status: 'complete'; warnings: string[] }) => void
  const gate = new Promise<{ text: string; status: 'complete'; warnings: string[] }>(done => { resolve = done })
  await withTranslation(async ({ state, requests, options, render }) => {
    await act(async () => { assert.equal(state().beginOcr(transcript), true) })
    const pending = state().translate({ text: transcript.text, targetLanguage: 'zh' })
    const rejected = assert.rejects(pending, { code: 'stale-result' })
    for (let i = 0; i < 10 && !requests.length; i++) await Promise.resolve()
    await render({ ...options, snapshot: { ...snapshot, ...changed } })
    assert.equal(requests[0]!.signal!.aborted, true, 'invalid OCR work is cancelled before the provider finishes')
    assert.equal(state().selection, null)
    resolve({ text: 'late', status: 'complete', warnings: [] })
    await rejected
  }, async () => gate)
})

test('OCR translation aborts immediately when its display owner changes or its tab closes', async () => {
  for (const reason of ['owner', 'tab'] as const) {
    await withTranslation(async ({ state, requests, options, render }) => {
      const tab = new AbortController()
      await render({ ...options, tabSignal: tab.signal })
      await act(async () => { assert.equal(state().beginOcr(transcript), true) })
      const pending = state().translate({ text: transcript.text, targetLanguage: 'zh' })
      const rejected = assert.rejects(pending, { code: 'stale-result' })
      for (let i = 0; i < 10 && !requests.length; i++) await Promise.resolve()
      if (reason === 'owner') await render({ ...options, tabSignal: tab.signal, displayOwnerToken: 2 })
      else await act(async () => { tab.abort() })
      assert.equal(requests[0]!.signal!.aborted, true)
      assert.equal(state().selection, null)
      await rejected
    }, () => new Promise(() => {}))
  }
})
