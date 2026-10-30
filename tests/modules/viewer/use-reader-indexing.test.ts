import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import React, { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { useReaderIndexing, type ReaderIndexingOptions } from '../../../src/modules/viewer/controllers/use-reader-indexing.tsx'
import type { PdfIndexingApi, PdfIndexingClientSnapshot } from '../../../src/modules/viewer/ports/indexing.ts'
import { ReaderToolbar, type ReaderToolbarActions, type ReaderToolbarState } from '../../../src/modules/viewer/components/ReaderToolbar.tsx'
import { readerLocales } from '../../../src/modules/viewer/locales.ts'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}
const t = (key: string) => readerLocales.en[key] ?? key
const baseState: ReaderToolbarState = {
  hasDocument: true, canPromptExplanation: false, explanationActive: false, explanationSending: false,
  screenshotActive: false, screenshotPreparing: false, busy: false, editable: false, ocrBusy: false,
  ocrAvailability: null, dirty: false, canUndo: false, canRedo: false, conflict: false, colorPending: false,
  saveAsPicking: false, hasUnappliedAnnotation: false, canGoBack: false, navigating: false,
  history: { revision: 0, positions: [] }, fit: 'width', zoom: 1,
}
const actions: ReaderToolbarActions = { onOpenMenu() {}, onToggleExplanation() {}, onScreenshot() {}, onNote() {},
  onOcr() {}, onReload() {}, onSaveAs() {}, onDiscard() {}, onUndo() {}, onRedo() {}, onSave() {},
  onBack() {}, onBackTo() {}, onZoom() {} }
const running = (): PdfIndexingClientSnapshot => ({ status: 'ready', enabled: true, revision: '1', tasks: [
  { documentId: 'a', title: 'alpha.pdf', occurrence: 1, state: 'running',
    progress: { indexedPages: 3, totalPages: 10, embeddedChunks: 2, totalChunks: 6 } },
  { documentId: 'b', title: 'beta.pdf', occurrence: 1, state: 'queued' },
] })
const idle = (): PdfIndexingClientSnapshot => ({ status: 'ready', enabled: true, tasks: [], revision: 'idle' })

async function withIndexing(run: (f: {
  state(): ReturnType<typeof useReaderIndexing>; container: HTMLElement; options: ReaderIndexingOptions;
  api: PdfIndexingApi; calls: Array<{ action: string; sessionId: string; id: string; signal: AbortSignal }>;
  failures: unknown[]; publish(value: PdfIndexingClientSnapshot): Promise<void>;
  render(next: ReaderIndexingOptions): Promise<void>;
}) => Promise<void>, initial = running(), timer?: TestContext) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, Node: dom.Node, Element: dom.Element,
    HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  timer?.mock.timers.enable({ apis: ['setTimeout'] })
  const container = dom.document.getElementById('root')!, root = createRoot(container)
  let current = initial
  const other = idle(), listeners = new Set<() => void>(), failures: unknown[] = []
  const calls: Array<{ action: string; sessionId: string; id: string; signal: AbortSignal }> = []
  const api: PdfIndexingApi = {
    getSnapshot: session => session === 'session-a' ? current : other,
    subscribe(_session, listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async start(sessionId, id, signal) { calls.push({ action: 'start', sessionId, id, signal }) },
    async rebuild(sessionId, id, signal) { calls.push({ action: 'rebuild', sessionId, id, signal }) },
    async cancel(sessionId, id, signal) { calls.push({ action: 'cancel', sessionId, id, signal }) },
    dismiss(sessionId, id, occurrence) {
      assert.equal(sessionId, 'session-a')
      current = { ...current, dismissed: { ...current.dismissed, [id]: occurrence } }
      for (const listener of [...listeners]) listener()
    },
  }
  const options: ReaderIndexingOptions = { api, sessionId: 'session-a', documentId: 'a',
    signal: new AbortController().signal, t, onError: error => { failures.push(error) } }
  let latest!: ReturnType<typeof useReaderIndexing>
  function Harness(props: ReaderIndexingOptions) {
    latest = useReaderIndexing(props)
    const ref = useRef<HTMLDetailsElement>(null)
    return React.createElement(ReaderToolbar, { t, menuRef: ref, state: baseState,
      actions, statuses: latest.statuses })
  }
  const render = async (next: ReaderIndexingOptions) => { await act(async () => { root.render(React.createElement(Harness, next)) }) }
  try {
    await render(options)
    await run({ state: () => latest, container, options, api, calls, failures, render,
      async publish(value) { current = value; await act(async () => { for (const listener of [...listeners]) listener() }) } })
  } finally {
    await act(async () => { root.unmount() })
    timer?.mock.timers.reset()
    dom.close()
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('each PDF uses the existing task entry with accessible page and passage progress and cancel actions', async () => {
  await withIndexing(async f => {
    const trigger = f.container.querySelector<HTMLButtonElement>('.dsh-pdf-activity-trigger')!
    assert.equal(trigger.getAttribute('aria-label'), 'Activity: 2')
    assert.equal(trigger.querySelector('progress'), null, 'the trigger keeps rich progress inside its popover')
    await act(async () => { trigger.click() })
    const popover = f.container.querySelector<HTMLElement>('.dsh-pdf-activity-popover')!
    assert.equal(popover.hidden, false)
    const pages = popover.querySelector<HTMLProgressElement>('progress[aria-label="Read pages: alpha.pdf"]')!
    const chunks = popover.querySelector<HTMLProgressElement>('progress[aria-label="Indexed passages: alpha.pdf"]')!
    assert.equal(pages.max, 10); assert.equal(pages.value, 3)
    assert.equal(chunks.hasAttribute('value'), false, 'the passage denominator is incomplete while pages are still being read')
    assert.match(popover.textContent ?? '', /alpha\.pdf.*3\/10.*2\/6/)
    await f.publish({ ...running(), revision: '2', tasks: [{ ...running().tasks[0]!,
      progress: { indexedPages: 10, totalPages: 10, embeddedChunks: 7, totalChunks: 12 } }, running().tasks[1]!] })
    assert.equal(chunks.value, 7); assert.equal(chunks.max, 12)
    await act(async () => { popover.querySelector<HTMLButtonElement>('[aria-label="Cancel indexing: alpha.pdf"]')!.click() })
    assert.deepEqual(f.calls.map(({ action, sessionId, id }) => ({ action, sessionId, id })), [{ action: 'cancel', sessionId: 'session-a', id: 'a' }])
    assert.equal(f.state().statuses.find(status => status.id === 'indexing:a')?.activity, 'progress', 'an accepted command does not fabricate Host completion')
    await f.publish({ ...running(), tasks: [{ ...running().tasks[0]!, state: 'cancelled' }] })
    await act(async () => { popover.querySelector<HTMLButtonElement>('[aria-label="Resume indexing: alpha.pdf"]')!.click() })
    assert.equal(f.calls.at(-1)?.action, 'start')
  })
})

test('the search control starts the current PDF once, respects unavailable connections and aborts old session commands', async () => {
  await withIndexing(async f => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const start = f.api.start
    f.api.start = async (...args) => { await start(...args); await gate; throw new Error('late old-session failure') }
    assert.equal(f.container.querySelector('.dsh-pdf-toolbar-index'), null, 'indexing does not own a permanent rail button')
    assert.equal(f.state().control!.disabled, false)
    await act(async () => { f.state().control!.onStart(); f.state().control!.onStart() })
    assert.equal(f.calls.length, 1)
    assert.equal(f.state().control!.disabled, true)
    await f.render({ ...f.options, sessionId: 'session-b', documentId: 'b' })
    assert.equal(f.calls[0]!.signal.aborted, true)
    await act(async () => { release() })
    assert.deepEqual(f.failures, [])
    await f.render(f.options)
    await f.publish({ ...running(), status: 'unavailable' })
    assert.equal(f.state().control!.disabled, true)
    assert.equal(f.state().control!.statusLabel, 'Indexing connection unavailable')
    assert.equal(f.container.querySelector('.dsh-pdf-indexing-status .dsh-pdf-floating-status-spinner'), null)
    await f.publish({ ...idle(), enabled: false })
    assert.equal(f.state().control!.disabled, true)
    assert.equal(f.state().control!.statusLabel, 'Enable semantic search in PDF settings first')
    await f.render({ ...f.options, api: undefined })
    assert.equal(f.container.querySelector('.dsh-pdf-toolbar-index'), null)
  }, idle())
})

test('ready indexing remains visible across elapsed time, other PDF progress and task-panel reopening', async context => {
  await withIndexing(async f => {
    const ready = { ...running(), tasks: [{ ...running().tasks[0]!, state: 'ready' as const }, running().tasks[1]!] }
    await f.publish(ready)
    assert.equal(f.state().control!.disabled, false, 'a ready index can be rebuilt from search')
    assert.equal(f.state().control!.label, 'Rebuild index')
    assert.ok(f.container.querySelector('[data-status-id="indexing:a"]'))
    await act(async () => { context.mock.timers.tick(2000) })
    await f.publish({ ...ready, revision: 'other-pdf-progress', tasks: [ready.tasks[0]!, { ...ready.tasks[1]!, state: 'running' }] })
    await act(async () => { context.mock.timers.tick(60_000) })
    const readyCard = f.container.querySelector('[data-status-id="indexing:a"]')!
    assert.equal(readyCard.getAttribute('data-tone'), 'success')
    assert.match(readyCard.textContent ?? '', /Index ready/)
    assert.equal(f.state().statuses.find(status => status.id === 'indexing:a')?.durationMs, undefined)
    const trigger = f.container.querySelector<HTMLButtonElement>('.dsh-pdf-activity-trigger')!
    await act(async () => { trigger.click(); trigger.click(); trigger.click() })
    assert.equal(f.container.querySelector<HTMLElement>('.dsh-pdf-activity-popover')!.hidden, false)
    assert.ok(f.container.querySelector('[data-status-id="indexing:a"]'))
    assert.ok(f.container.querySelector('[data-status-id="indexing:b"]'))
    await f.publish({ ...running(), tasks: [{ ...running().tasks[0]!, occurrence: 2 }] })
    assert.ok(f.container.querySelector('[data-status-id="indexing:a"]'))
    assert.equal(f.container.querySelector('progress[aria-label="Read pages: alpha.pdf"]')?.getAttribute('value'), '3')
  }, running(), context)
})

test('Done dismisses completion without changing the search rebuild action or hiding later work', async () => {
  await withIndexing(async f => {
    await f.publish({ ...running(), revision: 'ready', tasks: [{ ...running().tasks[0]!, state: 'ready' }] })
    const card = f.container.querySelector('[data-status-id="indexing:a"]')!
    assert.equal(card.getAttribute('data-tone'), 'success')
    await act(async () => { card.querySelector<HTMLButtonElement>('[aria-label="Done: alpha.pdf"]')!.click() })
    assert.equal(f.container.querySelector('[data-status-id="indexing:a"]'), null)
    assert.equal(f.state().control!.label, 'Rebuild index')
    assert.equal(f.state().control!.statusLabel, 'Index ready')
    assert.equal(f.state().control!.disabled, false)
    await act(async () => { f.state().control!.onStart() })
    assert.equal(f.calls.at(-1)?.action, 'rebuild')
    await f.publish({ ...running(), revision: 'new-task', tasks: [{ ...running().tasks[0]!, occurrence: 2 }] })
    assert.ok(f.container.querySelector('[data-status-id="indexing:a"]'))
    assert.equal(f.state().control!.disabled, true)
  })
})

test('failed tasks offer rebuild in the task panel and search while disabled engines stay unavailable', async () => {
  await withIndexing(async f => {
    await f.publish({ ...running(), revision: 'failed', tasks: [{ ...running().tasks[0]!, state: 'failed' }] })
    assert.equal(f.state().control!.label, 'Rebuild index')
    assert.equal(f.state().control!.statusLabel, 'Indexing failed')
    const button = f.container.querySelector<HTMLButtonElement>('[aria-label="Rebuild index: alpha.pdf"]')!
    await act(async () => { button.click() })
    assert.deepEqual(f.calls.map(({ action, sessionId, id }) => ({ action, sessionId, id })),
      [{ action: 'rebuild', sessionId: 'session-a', id: 'a' }])
    await f.publish({ ...idle(), enabled: false })
    assert.equal(f.state().control!.enabled, false)
    assert.equal(f.state().control!.disabled, true)
    assert.equal(f.state().control!.statusLabel, 'Enable semantic search in PDF settings first')
  })
})

test('switching PDFs in the same session aborts view commands and does not show their late failures', async () => {
  await withIndexing(async f => {
    let reject!: (error: Error) => void
    const delayed = new Promise<void>((_resolve, fail) => { reject = fail })
    const start = f.api.start
    f.api.start = async (...args) => { await start(...args); await delayed }
    await act(async () => { f.state().control!.onStart() })
    assert.equal(f.calls.length, 1)
    assert.equal(f.state().control!.disabled, true)
    await f.render({ ...f.options, documentId: 'b' })
    assert.equal(f.calls[0]!.signal.aborted, true)
    assert.equal(f.state().control!.disabled, false, 'the next PDF has its own available action')
    await act(async () => { reject(new Error('late previous-PDF failure')) })
    assert.deepEqual(f.failures, [])
  }, idle())
})

test('Host task removal clears a ready document without carrying readiness into another session', async context => {
  await withIndexing(async f => {
    const ready = { ...running(), tasks: [{ ...running().tasks[0]!, state: 'ready' as const }] }
    await f.publish(ready)
    await act(async () => { context.mock.timers.tick(60_000) })
    assert.ok(f.container.querySelector('[data-status-id="indexing:a"]'))
    await f.publish({ ...ready, revision: 'new-completion', tasks: [{ ...ready.tasks[0]!, occurrence: 2 }] })
    await act(async () => { context.mock.timers.tick(60_000) })
    assert.ok(f.container.querySelector('[data-status-id="indexing:a"]'))
    await f.render({ ...f.options, sessionId: 'session-b', documentId: 'b' })
    assert.equal(f.container.querySelector('[data-status-id="indexing:a"]'), null)
    assert.equal(f.state().control!.label, 'Index PDF')
    await f.render(f.options)
    assert.ok(f.container.querySelector('[data-status-id="indexing:a"]'))
    await f.publish(idle())
    assert.equal(f.container.querySelector('[data-status-id="indexing:a"]'), null)
    assert.equal(f.state().control!.label, 'Index PDF')
  }, running(), context)
})

test('indexing states map to outcome colors and disconnected tasks do not claim completion', async () => {
  await withIndexing(async f => {
    const tone = () => f.container.querySelector('[data-status-id="indexing:a"]')?.getAttribute('data-tone')
    assert.equal(tone(), 'progress')
    for (const [state, expected] of [['queued', 'neutral'], ['cancelled', 'neutral'], ['ready', 'success'], ['failed', 'error']] as const) {
      await f.publish({ ...running(), revision: state, tasks: [{ ...running().tasks[0]!, state }] })
      assert.equal(tone(), expected)
    }
    await f.publish({ ...running(), status: 'unavailable', revision: 'offline', tasks: [{ ...running().tasks[0]!, state: 'ready' }] })
    assert.equal(tone(), 'neutral')
    assert.equal(f.container.querySelector('[data-status-id="indexing-connection"]')?.getAttribute('data-tone'), 'error')
  })
})

test('task text distinguishes restoration, native extraction and new embeddings without inventing readiness', async () => {
  await withIndexing(async f => {
    for (const [phase, label] of [['restoring', 'Restoring saved index…'], ['extracting', 'Reading new pages…'],
      ['embedding', 'Computing embeddings…'], ['ready', 'Preparing search…']] as const) {
      await f.publish({ ...running(), revision: phase, tasks: [{ ...running().tasks[0]!,
        progress: { indexedPages: 10, totalPages: 10, embeddedChunks: 6, totalChunks: 6,
          phase, reusedChunks: 4, computedChunks: 2 } }] })
      const card = f.container.querySelector('[data-status-id="indexing:a"]')!
      assert.match(card.textContent ?? '', new RegExp(label))
      assert.match(card.textContent ?? '', /Reused passages: 4 · Newly computed: 2/)
      assert.equal(card.getAttribute('data-tone'), 'progress')
      assert.equal(f.state().control!.statusLabel, label)
      assert.equal(f.state().control!.label, 'Index PDF', 'progress never replaces the action label')
    }
    await f.publish({ ...running(), tasks: [{ ...running().tasks[0]!, state: 'ready',
      progress: { indexedPages: 10, totalPages: 10, embeddedChunks: 6, totalChunks: 6,
        phase: 'ready', reusedChunks: 6, computedChunks: 0 } }] })
    const card = f.container.querySelector('[data-status-id="indexing:a"]')!
    assert.match(card.textContent ?? '', /Index ready.*Reused passages: 6 · Newly computed: 0/)
    assert.equal(card.getAttribute('data-tone'), 'success')
  })
})
