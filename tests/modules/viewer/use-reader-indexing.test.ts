import { createDom } from '../../support/dom.ts'
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import React, { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { useReaderIndexing, type ReaderIndexingOptions } from '../../../src/modules/viewer/controllers/use-reader-indexing.tsx'
import type { PdfIndexingApi, PdfIndexingClientSnapshot } from '../../../src/modules/viewer/ports/indexing.ts'
import { ReaderToolbar, type ReaderToolbarActions, type ReaderToolbarState } from '../../../src/modules/viewer/components/ReaderToolbar.tsx'
import { readerLocales } from '../../../src/modules/viewer/locales.ts'
import type { PdfDocumentIndexPolicy, PdfDocumentIndexSettings } from '../../../src/contracts/indexing.ts'

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
type Call = { action: string; sessionId: string; id: string; signal: AbortSignal;
  revision?: number; policy?: PdfDocumentIndexPolicy }
const policy: PdfDocumentIndexPolicy = { indexScanPages: true, indexImageDescriptions: false }
const documentSettings = (overrides: Partial<PdfDocumentIndexSettings> = {}): PdfDocumentIndexSettings => ({
  documentId: 'a', revision: 1, policy, activePolicy: policy, enabled: true, activeEnabled: true, pending: false, impact: 'none', ...overrides,
})

async function withIndexing(run: (f: {
  state(): ReturnType<typeof useReaderIndexing>; container: HTMLElement; options: ReaderIndexingOptions;
  api: PdfIndexingApi; calls: Call[];
  failures: unknown[]; publish(value: PdfIndexingClientSnapshot): Promise<void>;
  mirror(value: PdfIndexingClientSnapshot): void;
  render(next: ReaderIndexingOptions): Promise<void>;
}) => Promise<void>, initial = running(), timer?: TestContext) {
  const { dom, restore: restoreDom, install: installDom } = createDom('<!doctype html><html><body><div id="root"></div></body></html>', { globals: [] })

  installDom({ window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, Element: dom.Element,
    HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  timer?.mock.timers.enable({ apis: ['setTimeout'] })
  const container = dom.document.getElementById('root')!, root = createRoot(container)
  let current = initial
  const other = idle(), listeners = new Set<() => void>(), failures: unknown[] = []
  const calls: Call[] = []
  const api: PdfIndexingApi = {
    getSnapshot: session => session === 'session-a' ? current : other,
    subscribe(_session, listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async start(sessionId, id, signal) { calls.push({ action: 'start', sessionId, id, signal }) },
    async resume(sessionId, id, signal) { calls.push({ action: 'resume', sessionId, id, signal }) },
    async rebuild(sessionId, id, signal) { calls.push({ action: 'rebuild', sessionId, id, signal }) },
    async cancel(sessionId, id, signal) { calls.push({ action: 'cancel', sessionId, id, signal }) },
    async configure(sessionId, id, revision, policy, signal) { calls.push({ action: 'configure', sessionId, id, revision, policy, signal }) },
    async useDefaults(sessionId, id, revision, signal) { calls.push({ action: 'defaults', sessionId, id, revision, signal }) },
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
      mirror(value) { current = value },
      async publish(value) { current = value; await act(async () => { for (const listener of [...listeners]) listener() }) } })
  } finally {
    await act(async () => { root.unmount() })
    timer?.mock.timers.reset()
    restoreDom()

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
    assert.equal(f.calls.at(-1)?.action, 'resume')
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
    assert.equal(f.state().control!.statusLabel, 'Semantic search is disabled for this PDF')
    await f.render({ ...f.options, api: undefined })
    assert.equal(f.container.querySelector('.dsh-pdf-toolbar-index'), null)
  }, idle())
})

test('ready indexing remains visible across elapsed time, other PDF progress and task-panel reopening', async context => {
  await withIndexing(async f => {
    const ready = { ...running(), tasks: [{ ...running().tasks[0]!, state: 'ready' as const }, running().tasks[1]!] }
    await f.publish(ready)
    assert.equal(f.state().control!.disabled, false, 'a ready index can be rebuilt from search')
    assert.equal(f.state().control!.label, 'Update index')
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

test('closing a notification dismisses completion without changing the search rebuild action or hiding later work', async () => {
  await withIndexing(async f => {
    await f.publish({ ...running(), revision: 'ready', tasks: [{ ...running().tasks[0]!, state: 'ready' }] })
    const card = f.container.querySelector('[data-status-id="indexing:a"]')!
    assert.equal(card.getAttribute('data-tone'), 'success')
    const activity = f.container.querySelector<HTMLButtonElement>('.dsh-pdf-activity-trigger')!
    await act(async () => { activity.click() })
    await act(async () => {
      const close = card.querySelector<HTMLButtonElement>('[aria-label="Close notification: alpha.pdf"]')!
      close.focus(); close.click()
    })
    assert.equal(f.container.ownerDocument.activeElement, activity, 'closing a completed notification returns focus to the task entry')
    assert.equal(f.container.querySelector('[data-status-id="indexing:a"]'), null)
    assert.equal(f.state().control!.label, 'Update index')
    assert.equal(f.state().control!.statusLabel, 'Index ready')
    assert.equal(f.state().control!.disabled, false)
    await act(async () => { f.state().control!.onStart() })
    assert.equal(f.calls.at(-1)?.action, 'start', 'the ordinary action reuses work instead of forcing recomputation')
    await f.publish({ ...running(), revision: 'new-task', tasks: [{ ...running().tasks[0]!, occurrence: 2 }] })
    assert.ok(f.container.querySelector('[data-status-id="indexing:a"]'))
    assert.equal(f.state().control!.disabled, true)
  })
})

test('failed tasks resume their checkpoints from the task panel and search while disabled engines stay unavailable', async () => {
  await withIndexing(async f => {
    await f.publish({ ...running(), revision: 'failed', tasks: [{ ...running().tasks[0]!, state: 'failed' }] })
    assert.equal(f.state().control!.label, 'Retry indexing')
    assert.equal(f.state().control!.statusLabel, 'Indexing failed')
    const button = f.container.querySelector<HTMLButtonElement>('[aria-label="Retry indexing: alpha.pdf"]')!
    await act(async () => { button.click() })
    assert.deepEqual(f.calls.map(({ action, sessionId, id }) => ({ action, sessionId, id })),
      [{ action: 'resume', sessionId: 'session-a', id: 'a' }])
    await act(async () => { f.state().control!.onRebuild!() })
    assert.equal(f.calls.at(-1)!.action, 'rebuild', 'discarding progress remains an explicit separate action')
    await f.publish({ ...running(), revision: 'cancelled', tasks: [{ ...running().tasks[0]!, state: 'cancelled' }] })
    assert.equal(f.state().control!.label, 'Resume indexing')
    await f.publish({ ...idle(), enabled: false })
    assert.equal(f.state().control!.enabled, false)
    assert.equal(f.state().control!.disabled, true)
    assert.equal(f.state().control!.statusLabel, 'Semantic search is disabled for this PDF')
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

test('interrupted indexing resumes its accepted plan while pending choices require an explicit update', async () => {
  for (const state of ['cancelled', 'failed'] as const) {
    const desired = { indexScanPages: false, indexImageDescriptions: true }
    await withIndexing(async f => {
      assert.equal(f.state().control!.label, state === 'cancelled' ? 'Resume indexing' : 'Retry indexing')
      assert.ok(f.state().control!.onUpdate, 'pending choices have a separate explicit update action')
      const contextual = f.state().statuses.find(status => status.id === 'indexing:a')!.actions![0]!
      await act(async () => { contextual.onClick() })
      await act(async () => { f.state().control!.onStart() })
      assert.deepEqual(f.calls.map(call => call.action), ['resume', 'resume'], 'neither interruption entry point applies desired settings')
      assert.deepEqual(f.state().control!.configuration!.value.activePolicy, policy)
      assert.equal(f.state().control!.configuration!.value.pending, true)
      await act(async () => { f.state().control!.onUpdate!() })
      await act(async () => { f.state().control!.onRebuild!() })
      assert.deepEqual(f.calls.map(call => call.action), ['resume', 'resume', 'start', 'rebuild'])
      assert.deepEqual(f.state().control!.configuration!.value.policy, desired, 'the Host remains the settings owner')
    }, { ...idle(), tasks: [{ ...running().tasks[0]!, state }], documents: [documentSettings({
      policy: desired, pending: true, impact: 'content' })] })
  }
})

test('resume allows either desired or accepted enablement while explicit update still requires desired enablement', async () => {
  await withIndexing(async f => {
    assert.equal(f.state().control!.enabled, true, 'disabling desired settings does not stop continuation of the accepted plan')
    assert.equal(f.state().control!.disabled, false)
    assert.equal(f.state().control!.onUpdate, undefined)
    assert.equal(f.state().control!.onRebuild, undefined, 'forced rebuild must not silently reuse the old enabled plan')
    await act(async () => { f.state().control!.onStart() })
    assert.equal(f.calls.at(-1)?.action, 'resume')
    await f.publish({ ...idle(), tasks: [{ ...running().tasks[0]!, state: 'cancelled' }],
      documents: [documentSettings({ activeEnabled: false, pending: true, impact: 'embedding' })] })
    assert.equal(f.state().control!.disabled, false, 'an enabled candidate can resume before an accepted plan exists')
    assert.equal(f.state().statuses.find(status => status.id === 'indexing:a')!.actions![0]!.disabled, false)
    assert.equal(f.state().control!.updateDisabled, false, 'a newly enabled plan can still be applied')
    await act(async () => { f.state().control!.onStart() })
    assert.equal(f.calls.at(-1)?.action, 'resume', 'the Host owns validation of the retained candidate plan')
    await act(async () => { f.state().control!.onUpdate!() })
    assert.equal(f.calls.at(-1)?.action, 'start')
    await f.publish({ ...idle(), enabled: false, tasks: [{ ...running().tasks[0]!, state: 'cancelled' }],
      documents: [documentSettings({ enabled: false, activeEnabled: false })] })
    assert.equal(f.state().control!.disabled, true)
    assert.equal(f.state().statuses.find(status => status.id === 'indexing:a')!.actions![0]!.disabled, true)
    const before = f.calls.length
    await act(async () => { f.state().control!.onStart() })
    assert.equal(f.calls.length, before)
  }, { ...idle(), tasks: [{ ...running().tasks[0]!, state: 'cancelled' }], documents: [documentSettings({
    enabled: false, activeEnabled: true, pending: true, impact: 'embedding' })] })
})

test('the first candidate started after enabling indexing remains resumable before any completed plan exists', async () => {
  await withIndexing(async f => {
    assert.equal(f.state().control!.disabled, true)
    await f.publish({ ...idle(), documents: [documentSettings({ activeEnabled: false, pending: true, impact: 'embedding' })] })
    await act(async () => { f.state().control!.onStart() })
    assert.equal(f.calls.at(-1)?.action, 'start')
    await f.publish({ ...idle(), tasks: [{ ...running().tasks[0]!, state: 'cancelled' }],
      documents: [documentSettings({ activeEnabled: false, pending: true, impact: 'embedding' })] })
    assert.equal(f.state().control!.disabled, false, 'activeEnabled describes the previous accepted plan, not this interrupted candidate')
    const taskAction = f.state().statuses.find(status => status.id === 'indexing:a')!.actions![0]!
    assert.equal(taskAction.disabled, false)
    await act(async () => { taskAction.onClick() })
    await act(async () => { f.state().control!.onStart() })
    assert.deepEqual(f.calls.map(call => call.action), ['start', 'resume', 'resume'])
  }, { ...idle(), enabled: false, documents: [documentSettings({ enabled: false, activeEnabled: false })] })
})

test('resuming queues restoration without claiming the cancelled task is already running', async () => {
  await withIndexing(async f => {
    let reject!: (error: Error) => void
    const gate = new Promise<void>((_resolve, fail) => { reject = fail })
    f.api.resume = async (sessionId, id, signal) => {
      f.calls.push({ action: 'resume', sessionId, id, signal }); await gate
    }
    await act(async () => { f.state().control!.onStart(); f.state().control!.onStart() })
    assert.equal(f.calls.length, 1)
    assert.equal(f.state().control!.disabled, true)
    await f.publish({ ...running(), tasks: [{ ...running().tasks[0]!, state: 'queued', progress: {
      indexedPages: 3, totalPages: 10, embeddedChunks: 2, totalChunks: 6, phase: 'restoring', reusedChunks: 2, computedChunks: 0,
    } }] })
    assert.equal(f.state().control!.statusLabel, 'Restoring saved index…')
    assert.equal(f.state().statuses[0]!.tone, 'neutral', 'queued restoration retains its actual Host state')
    assert.equal(f.state().statuses[0]!.activity, 'progress')
    await f.render({ ...f.options, documentId: 'b' })
    assert.equal(f.calls[0]!.signal.aborted, true)
    await act(async () => { reject(new Error('late resumed task failure')) })
    assert.deepEqual(f.failures, [])
  }, { ...idle(), tasks: [{ ...running().tasks[0]!, state: 'cancelled' }] })
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

test('document choices save by revision even when semantic search is off and processing starts only on explicit update', async () => {
  const disabled = { ...policy, indexScanPages: false }
  await withIndexing(async f => {
    const configuration = f.state().control!.configuration!
    assert.equal(configuration.disabled, false, 'engine selection remains editable when indexing is disabled')
    assert.equal(f.state().control!.disabled, true)
    let finish!: () => void
    const configure = f.api.configure
    f.api.configure = async (...args) => { await configure(...args); await new Promise<void>(resolve => { finish = resolve }) }
    let saved!: Promise<boolean>
    await act(async () => { saved = configuration.configure(policy); await Promise.resolve() })
    assert.equal(f.state().control!.configuration!.saving, true)
    assert.deepEqual(f.calls.map(({ signal: _signal, ...call }) => call), [{ action: 'configure', sessionId: 'session-a',
      id: 'a', revision: 1, policy }])
    await f.publish({ ...idle(), enabled: false, documents: [documentSettings({ revision: 2, activePolicy: disabled,
      enabled: false, activeEnabled: false, pending: true, impact: 'content' })] })
    await act(async () => { finish(); assert.equal(await saved, true) })
    assert.equal(f.state().control!.configuration!.saving, false)
    assert.equal(f.state().control!.label, 'Update index')
    assert.equal(f.state().control!.configuration!.value.activeEnabled, false)
    assert.equal(f.state().control!.enabled, false, 'content switches cannot enable the globally disabled embedding engine')
    await f.publish({ ...idle(), documents: [documentSettings({ revision: 2, activePolicy: disabled, activeEnabled: false,
      pending: true, impact: 'embedding' })] })
    assert.equal(f.calls.length, 1, 'saving configuration must never start a model job')
    await act(async () => { f.state().control!.onStart() })
    assert.equal(f.calls.at(-1)!.action, 'start')
    await act(async () => { f.state().control!.onRebuild!() })
    assert.equal(f.calls.at(-1)!.action, 'rebuild', 'forced recomputation remains an explicit separate command')
    await act(async () => { assert.equal(await f.state().control!.configuration!.useDefaults(), true) })
    assert.equal(f.calls.at(-1)!.action, 'defaults')
    assert.equal(f.calls.at(-1)!.revision, 2, 'each choice uses the settings revision displayed by its render')
  }, { ...idle(), enabled: false, documents: [documentSettings({ policy: disabled, activePolicy: disabled, enabled: false, activeEnabled: false })] })
})

test('configuration errors reach the local editor, retain Host truth and cannot leak across document lifetimes', async () => {
  await withIndexing(async f => {
    const failure = new Error('revision conflict')
    f.api.configure = async () => { throw failure }
    await act(async () => { await assert.rejects(f.state().control!.configuration!.configure({ ...policy, indexImageDescriptions: true }), failure) })
    assert.equal(f.state().control!.configuration!.value.policy.indexImageDescriptions, false)
    assert.deepEqual(f.failures, [], 'the local editor owns settings errors rather than a second global error notice')
    let finish!: () => void, active!: AbortSignal
    f.api.useDefaults = async (_session, _id, _revision, signal) => { active = signal; await new Promise<void>(resolve => { finish = resolve }) }
    let accepted!: Promise<boolean>
    await act(async () => { accepted = f.state().control!.configuration!.useDefaults(); await Promise.resolve() })
    assert.equal(f.state().control!.configuration!.saving, true)
    await f.render({ ...f.options, documentId: 'b' })
    assert.equal(active.aborted, true)
    await act(async () => { finish(); assert.equal(await accepted, false) })
    assert.equal(f.state().control!.configuration, undefined)
    assert.deepEqual(f.failures, [])
  }, { ...idle(), documents: [documentSettings()] })
})

test('an old document-policy event cannot borrow a newer mirror revision before React receives that snapshot', async () => {
  await withIndexing(async f => {
    const rendered = f.state().control!.configuration!
    const otherViewPolicy = { ...policy, indexScanPages: false }
    let host = { ...idle(), revision: 'other-view-update', documents: [documentSettings({ revision: 2, policy: otherViewPolicy })] }
    const configure = f.api.configure
    f.api.configure = async (...args) => {
      await configure(...args)
      const [, , revision, submitted] = args
      if (revision !== host.documents[0]!.revision) throw Object.assign(new Error('PDF index settings changed'), { code: 'pdf/index-settings-stale' })
      host = { ...host, revision: 'accepted-update', documents: [{ ...host.documents[0]!, revision: revision + 1, policy: submitted }] }
      f.mirror(host)
    }
    // Adapter publication changes its mirror before notifying React listeners.
    // The event still belongs to the policy/revision displayed by the old render.
    f.mirror(host)
    assert.equal(f.api.getSnapshot('session-a').documents![0]!.revision, 2)
    assert.equal(f.state().control!.configuration, rendered)
    assert.equal(rendered.value.revision, 1)
    let failure: unknown, accepted: boolean | undefined
    await act(async () => {
      try { accepted = await rendered.configure({ ...rendered.value.policy, indexImageDescriptions: true }) }
      catch (error) { failure = error }
    })
    assert.equal(f.calls[0]!.revision, 1, 'a whole-policy edit must carry the revision that produced its displayed fields')
    assert.equal(accepted, undefined)
    assert.ok(failure instanceof Error && 'code' in failure && failure.code === 'pdf/index-settings-stale')
    assert.deepEqual(host.documents[0]!.policy, otherViewPolicy, 'the concurrent OCR switch cannot be overwritten by an old complete policy')
    assert.deepEqual(f.failures, [], 'the local settings editor owns the conflict and retry')

    await f.publish(host)
    const refreshed = f.state().control!.configuration!
    const merged = { ...refreshed.value.policy, indexImageDescriptions: true }
    await act(async () => { assert.equal(await refreshed.configure(merged), true) })
    assert.equal(f.calls[1]!.revision, 2)
    assert.deepEqual(host.documents[0]!.policy, { ...otherViewPolicy, indexImageDescriptions: true })
    assert.ok(f.calls.every(call => call.action === 'configure'), 'retrying settings must not start indexing')
  }, { ...idle(), documents: [documentSettings()] })
})

test('restoring defaults also uses the displayed document revision when the mirror advances before React', async () => {
  await withIndexing(async f => {
    const rendered = f.state().control!.configuration!
    const host = { ...idle(), revision: 'other-view-update', documents: [documentSettings({ revision: 2 })] }
    const useDefaults = f.api.useDefaults
    f.api.useDefaults = async (...args) => {
      await useDefaults(...args)
      if (args[2] !== host.documents[0]!.revision) throw Object.assign(new Error('PDF index settings changed'), { code: 'pdf/index-settings-stale' })
    }
    f.mirror(host)
    let failure: unknown
    await act(async () => {
      try { await rendered.useDefaults() } catch (error) { failure = error }
    })
    assert.equal(f.calls[0]!.revision, 1)
    assert.ok(failure instanceof Error && 'code' in failure && failure.code === 'pdf/index-settings-stale')
    await f.publish(host)
    await act(async () => { assert.equal(await f.state().control!.configuration!.useDefaults(), true) })
    assert.equal(f.calls[1]!.revision, 2)
    assert.deepEqual(f.failures, [])
  }, { ...idle(), documents: [documentSettings()] })
})

async function openDiagnosticMenu(container: HTMLElement, title = 'alpha.pdf'): Promise<HTMLElement> {
  const activity = container.querySelector<HTMLButtonElement>('.dsh-pdf-activity-trigger')!
  if (activity.getAttribute('aria-expanded') !== 'true') await act(async () => { activity.click() })
  const more = container.querySelector<HTMLButtonElement>(`[aria-label="More task actions: ${title}"]`)
  assert.ok(more, 'diagnostics are discovered through the task’s more-actions trigger')
  if (more.getAttribute('aria-expanded') !== 'true') await act(async () => { more.click() })
  const menu = container.ownerDocument.querySelector<HTMLElement>(`[role="group"][aria-label="More task actions: ${title}"]`)
  assert.ok(menu)
  assert.equal(menu.hidden, false)
  return menu
}

test('task cards expose one contextual action while diagnostics stay in the more menu and only completion can be dismissed', async () => {
  await withIndexing(async f => {
    f.api.diagnostics = async () => ({ directory: '/logs', report: 'report', canOpen: true })
    await f.render(f.options)
    for (const state of ['running', 'failed', 'cancelled', 'ready'] as const) {
      await f.publish({ ...running(), tasks: [{ ...running().tasks[0]!, state }] })
      const status = f.state().statuses.find(status => status.id === 'indexing:a')!
      assert.equal(status.menuActions?.length, 2)
      assert.deepEqual(status.menuActions?.map(action => action.label), ['Copy diagnostics', 'Open log folder'])
      if (state === 'ready') {
        assert.equal(status.actions?.length ?? 0, 0)
        assert.equal(status.dismiss?.ariaLabel, 'Close notification: alpha.pdf')
      } else {
        assert.equal(status.dismiss, undefined)
        assert.equal(status.actions?.length, 1)
        assert.equal(status.actions![0]!.label, state === 'running' ? 'Cancel' : state === 'failed' ? 'Retry indexing' : 'Resume indexing')
      }
    }
    assert.deepEqual(f.calls, [], 'presenting actions does not start, stop or clear the Host index')
  })
})

test('task diagnostics copy a Host report, acknowledge in the menu and open the fixed log directory', async () => {
  await withIndexing(async f => {
    assert.equal(f.container.querySelector('[aria-label="Copy diagnostics: alpha.pdf"]'), null, 'older adapters do not expose unusable controls')
    const invoked: unknown[][] = [], copied: string[] = []
    f.api.diagnostics = async (...args) => { invoked.push(args); return { directory: '/home/logs/pdf/desktop', report: 'safe diagnostic report', canOpen: true } }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text) } } })
    await f.render(f.options)
    const copy = () => f.container.querySelector<HTMLButtonElement>('[aria-label="Copy diagnostics: alpha.pdf"]')!
    await openDiagnosticMenu(f.container)
    await act(async () => { copy().click() })
    assert.deepEqual(copied, ['safe diagnostic report'])
    assert.deepEqual(invoked[0]!.slice(0, 4), ['session-a', 'a', 1, 'report'])
    assert.ok(invoked[0]![4] instanceof AbortSignal)
    await openDiagnosticMenu(f.container)
    assert.equal(copy().textContent, 'Copied')
    assert.doesNotMatch(f.container.textContent ?? '', /safe diagnostic report/, 'diagnostic text is copied, never rendered as document UI')
    await openDiagnosticMenu(f.container)
    await act(async () => { f.container.querySelector<HTMLButtonElement>('[aria-label="Open log folder: alpha.pdf"]')!.click() })
    assert.deepEqual(invoked[1]!.slice(0, 4), ['session-a', 'a', 1, 'open'])
    await f.publish({ ...running(), tasks: [{ ...running().tasks[0]!, occurrence: 2 }] })
    await openDiagnosticMenu(f.container)
    assert.equal(copy().textContent, 'Copy diagnostics', 'a new attempt does not inherit the old copy acknowledgment')
    assert.deepEqual(f.failures, [])
  })
})

test('diagnostic requests share their own pending guard and leave index cancellation available', async () => {
  await withIndexing(async f => {
    let finish!: () => void, calls = 0
    f.api.diagnostics = async () => { calls++; await new Promise<void>(resolve => { finish = resolve }); return { directory: '/logs', report: 'report', canOpen: true } }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } })
    await f.render(f.options)
    const status = f.state().statuses.find(value => value.id === 'indexing:a')!
    await act(async () => { status.menuActions![0]!.onClick(); status.menuActions![1]!.onClick() })
    assert.equal(calls, 1)
    assert.equal(f.container.querySelector<HTMLButtonElement>('[aria-label="Copy diagnostics: alpha.pdf"]')!.disabled, true)
    assert.equal(f.container.querySelector<HTMLButtonElement>('[aria-label="Open log folder: alpha.pdf"]')!.disabled, true)
    const cancel = f.container.querySelector<HTMLButtonElement>('[aria-label="Cancel indexing: alpha.pdf"]')!
    assert.equal(cancel.disabled, false)
    await act(async () => { cancel.click() })
    assert.equal(f.calls.at(-1)?.action, 'cancel')
    await act(async () => { finish() })
    assert.equal(f.container.querySelector<HTMLButtonElement>('[aria-label="Copy diagnostics: alpha.pdf"]')!.disabled, false)
  })
})

test('clipboard, Host and folder-opening failures reach the existing error owner without false acknowledgments', async () => {
  await withIndexing(async f => {
    f.api.diagnostics = async () => ({ directory: '/logs', report: 'report', canOpen: false })
    await f.render(f.options)
    const click = async (label: string) => { await openDiagnosticMenu(f.container); await act(async () => { f.container.querySelector<HTMLButtonElement>(`[aria-label="${label}: alpha.pdf"]`)!.click() }) }
    await click('Copy diagnostics')
    assert.match(String(f.failures.at(-1)), /Clipboard access is unavailable/)
    await click('Open log folder')
    assert.match(String(f.failures.at(-1)), /Opening the log folder is unavailable/)
    const denied = new Error('clipboard denied')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw denied } } })
    await click('Copy diagnostics')
    assert.equal(f.failures.at(-1), denied)
    const host = new Error('diagnostics unavailable')
    f.api.diagnostics = async () => { throw host }
    await click('Copy diagnostics')
    assert.equal(f.failures.at(-1), host)
    assert.equal(f.container.querySelector('[aria-label="Copy diagnostics: alpha.pdf"]')?.textContent, 'Copy diagnostics')
    assert.equal(f.failures.length, 4)
  })
})

test('diagnostics cannot copy or report late failures after attempt, view or cancellation boundaries', async () => {
  let finishAfterUnmount!: () => void, afterUnmountSignal!: AbortSignal
  let copied = 0
  await withIndexing(async f => {
    let finish!: () => void, reject!: (error: Error) => void, requestSignal!: AbortSignal
    f.api.diagnostics = async (_session, _id, _occurrence, _action, signal) => {
      requestSignal = signal
      await new Promise<void>((resolve, fail) => { finish = resolve; reject = fail })
      return { directory: '/logs', report: 'stale report', canOpen: true }
    }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { copied++ } } })
    await f.render(f.options)
    const click = async () => { await openDiagnosticMenu(f.container); await act(async () => { f.container.querySelector<HTMLButtonElement>('[aria-label="Copy diagnostics: alpha.pdf"]')!.click() }) }
    await click()
    await f.publish({ ...running(), tasks: [{ ...running().tasks[0]!, occurrence: 2 }] })
    await act(async () => { finish() })
    assert.equal(copied, 0, 'a report for a replaced attempt is not copied')
    await click()
    await f.render({ ...f.options, sessionId: 'session-b', documentId: 'b' })
    assert.equal(requestSignal.aborted, true)
    await act(async () => { reject(new Error('late session failure')) })
    assert.deepEqual(f.failures, [])
    const lifetime = new AbortController()
    await f.render({ ...f.options, signal: lifetime.signal })
    await click()
    lifetime.abort()
    await act(async () => { finish() })
    assert.equal(copied, 0)
    await f.render(f.options)
    await click()
    finishAfterUnmount = finish; afterUnmountSignal = requestSignal
  })
  assert.equal(afterUnmountSignal.aborted, true)
  await act(async () => { finishAfterUnmount() })
  assert.equal(copied, 0)
})

test('failed and cancelled cards retain last measured progress and visible failure codes', async () => {
  await withIndexing(async f => {
    for (const state of ['failed', 'cancelled'] as const) {
      const task = running().tasks[0]!
      await f.publish({ ...running(), tasks: [{ ...task, state, failureCode: 'pdf/embedding-timeout',
        progress: { ...task.progress!, failedPages: 2 } }] })
      const card = f.container.querySelector('[data-status-id="indexing:a"]')!
      assert.match(card.textContent ?? '', /pdf\/embedding-timeout/)
      assert.match(card.textContent ?? '', /Pages needing retry\s*2/)
      assert.equal(card.querySelector<HTMLProgressElement>('progress[aria-label="Read pages: alpha.pdf"]')?.value, 3)
      assert.equal(card.querySelector<HTMLProgressElement>('progress[aria-label="Indexed passages: alpha.pdf"]')?.value, 2)
      assert.match(card.textContent ?? '', /3\/10.*2\/6/)
    }
    let calls = 0
    f.api.diagnostics = async () => { calls++; return { directory: '/logs', report: 'report', canOpen: true } }
    await f.publish({ ...running(), status: 'unavailable' })
    await act(async () => { f.state().statuses.find(value => value.id === 'indexing:a')!.menuActions![0]!.onClick() })
    assert.equal(calls, 0, 'disconnected controls do not issue diagnostic requests')
    const lifetime = new AbortController(); lifetime.abort()
    await f.render({ ...f.options, signal: lifetime.signal })
    await act(async () => { f.state().statuses.find(value => value.id === 'indexing:a')!.menuActions![0]!.onClick() })
    assert.equal(calls, 0)
  })
})

class DeferredClipboardItem {
  constructor(readonly data: Record<string, Promise<Blob>>) {}
}
async function withClipboardConstructor(constructor: unknown, run: () => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem')
  Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: constructor })
  try { await run() }
  finally {
    if (previous) Object.defineProperty(globalThis, 'ClipboardItem', previous)
    else Reflect.deleteProperty(globalThis, 'ClipboardItem')
  }
}

test('modern clipboard writes start within the click gesture and resolve the report bytes after RPC completion', async () => {
  await withClipboardConstructor(DeferredClipboardItem, () => withIndexing(async f => {
    let finish!: () => void
    const order: string[] = [], copied: string[] = []
    f.api.diagnostics = async () => {
      order.push('rpc-start')
      await new Promise<void>(resolve => { finish = resolve })
      order.push('rpc-end')
      return { directory: '/logs', report: 'deferred report', canOpen: true }
    }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      async write(items: DeferredClipboardItem[]) {
        order.push('clipboard-start')
        const blob = await items[0]!.data['text/plain']!
        assert.equal(blob.type, 'text/plain')
        copied.push(await blob.text())
      },
    } })
    await f.render(f.options)
    await openDiagnosticMenu(f.container)
    await act(async () => {
      f.container.querySelector<HTMLButtonElement>('[aria-label="Copy diagnostics: alpha.pdf"]')!.click()
      assert.deepEqual(order, ['rpc-start', 'clipboard-start'], 'write must be admitted before the report is available')
    })
    assert.deepEqual(copied, [])
    await act(async () => { finish() })
    assert.deepEqual(copied, ['deferred report'])
    assert.equal(f.container.querySelector('[aria-label="Copy diagnostics: alpha.pdf"]')?.textContent, 'Copied')
    assert.deepEqual(f.failures, [])
  }))
})

test('deferred clipboard data rejects after owner replacement without copying or acknowledging stale bytes', async () => {
  await withClipboardConstructor(DeferredClipboardItem, () => withIndexing(async f => {
    let finish!: () => void, copied = 0, writes = 0
    f.api.diagnostics = async () => {
      await new Promise<void>(resolve => { finish = resolve })
      return { directory: '/logs', report: 'old report', canOpen: true }
    }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      async write(items: DeferredClipboardItem[]) { writes++; await items[0]!.data['text/plain']; copied++ },
    } })
    await f.render(f.options)
    await openDiagnosticMenu(f.container)
    await act(async () => { f.container.querySelector<HTMLButtonElement>('[aria-label="Copy diagnostics: alpha.pdf"]')!.click() })
    assert.equal(writes, 1)
    await f.publish({ ...running(), tasks: [{ ...running().tasks[0]!, occurrence: 2 }] })
    await act(async () => { finish() })
    assert.equal(copied, 0)
    assert.equal(f.container.querySelector('[aria-label="Copy diagnostics: alpha.pdf"]')?.textContent, 'Copy diagnostics')
    assert.deepEqual(f.failures, [])
  }))
})

test('synchronous ClipboardItem and write failures observe deferred report rejection without unhandled promises', async () => {
  for (const stage of ['constructor', 'write'] as const) {
    const error = new Error(`${stage} denied`)
    const constructor = stage === 'constructor' ? class { constructor() { throw error } } : DeferredClipboardItem
    await withClipboardConstructor(constructor, () => withIndexing(async f => {
      let reject!: (error: Error) => void
      f.api.diagnostics = () => new Promise((_resolve, fail) => { reject = fail })
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        write() { assert.equal(stage, 'write'); throw error },
      } })
      await f.render(f.options)
      await openDiagnosticMenu(f.container)
    await act(async () => { f.container.querySelector<HTMLButtonElement>('[aria-label="Copy diagnostics: alpha.pdf"]')!.click() })
      assert.deepEqual(f.failures, [error])
      await act(async () => {
        reject(new Error('late report rejection'))
        await new Promise<void>(resolve => setImmediate(resolve))
      })
      assert.deepEqual(f.failures, [error], 'the original clipboard failure has a single owner')
      assert.equal(f.container.querySelector('[aria-label="Copy diagnostics: alpha.pdf"]')?.textContent, 'Copy diagnostics')
    }))
  }
})
