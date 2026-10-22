import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { PdfAnnotation } from '../../../src/core/pdf-types.ts'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import type { ReaderSelection } from '../../../src/modules/viewer/model/reader-selection.ts'
import { useReaderScreenshot, type ReaderScreenshotOptions } from '../../../src/modules/viewer/controllers/use-reader-screenshot.ts'

const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

const annotation = (id: string, page: number) => ({ id, page }) as PdfAnnotation
const snapshot = { id: 'doc-1', revision: 7, document: { annotations: [annotation('current-2', 2), annotation('current-3', 3)] } } as WorkspaceSnapshot
const region = { rect: [10, 20, 30, 40] as [number, number, number, number], quadPoints: [10, 20, 30, 20, 10, 40, 30, 40] }
const image = () => ({ blob: new Blob(['png'], { type: 'image/png' }), width: 40, height: 50 })

async function withScreenshot(run: (fixture: {
  state(): ReturnType<typeof useReaderScreenshot>
  options: ReaderScreenshotOptions
  render(options: ReaderScreenshotOptions): Promise<void>
  events: string[]
  mode(): string
  selection(): ReaderSelection | null
  errors: string[]
  tab: AbortController
}) => Promise<void>): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const root = createRoot(dom.document.getElementById('root')!)
  const tab = new AbortController()
  const events: string[] = [], errors: string[] = []
  const purpose: ReaderScreenshotOptions['regionPurpose'] = { current: null }
  let mode = 'text'
  let selection: ReaderSelection | null = null
  let latest: ReturnType<typeof useReaderScreenshot> | undefined
  const Harness = (props: ReaderScreenshotOptions) => { latest = useReaderScreenshot(props); return null }
  const options: ReaderScreenshotOptions = {
    pdf: {} as ReaderScreenshotOptions['pdf'], snapshot,
    tabSignal: tab.signal, displayOwnerToken: 1, ownerSequence: { current: 1 }, regionPurpose: purpose,
    currentSnapshot: () => snapshot, documentReady: () => true,
    setMode(value) { mode = typeof value === 'function' ? value(mode as 'text' | 'region' | 'note') : value },
    setSelection(value) { selection = typeof value === 'function' ? value(selection) : value },
    clearSelection() { selection = null; events.push('clear-selection') },
    clearAnnotation() { events.push('clear-annotation') },
    closeToolsMenu() { events.push('close-menu') }, clearError() { events.push('clear-error') },
    onError(error) { errors.push(error instanceof Error ? error.message : String(error)) },
    t: key => key,
    captureRegion: async () => image(),
  }
  const render = async (next: ReaderScreenshotOptions) => { await act(async () => { root.render(React.createElement(Harness, next)) }) }
  try {
    await render(options)
    await run({ state: () => latest!, options, render, events, mode: () => mode, selection: () => selection, errors, tab })
  } finally {
    await act(async () => root.unmount())
    tab.abort()
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('screenshot begins only for the mounted owner and clears competing contextual UI', async () => {
  await withScreenshot(async ({ state, options, render, events, mode, errors }) => {
    await render({ ...options, displayOwnerToken: null })
    await act(async () => { state().begin(false) })
    assert.deepEqual(errors, ['reader.notReady'])
    assert.equal(mode(), 'text')
    await render(options)
    await act(async () => { state().begin(true) })
    assert.equal(mode(), 'text', 'explanation mode excludes standalone screenshots')
    await act(async () => { state().begin(false) })
    assert.equal(mode(), 'region')
    assert.equal(options.regionPurpose.current, 'screenshot')
    assert.deepEqual(events, ['clear-selection', 'clear-annotation', 'close-menu'])
  })
})

test('screenshot captures the selected region without sending annotations to the renderer', async () => {
  await withScreenshot(async ({ state, options, render, mode, selection, events }) => {
    let captured: { page: number; options: object } | undefined
    await render({ ...options, captureRegion: async (_pdf, page, _rect, captureOptions) => {
      captured = { page, options: captureOptions ?? {} }
      return image()
    } })
    await act(async () => { state().begin(false) })
    await act(async () => { await state().takeRegion(2, region) })
    assert.equal(mode(), 'text')
    assert.equal(options.regionPurpose.current, null)
    assert.equal(captured?.page, 2)
    assert.deepEqual(Object.keys(captured?.options ?? {}), ['signal'])
    assert.deepEqual(selection(), { kind: 'region', revision: 7, text: '', fragments: [{ page: 2, ...region }] })
    assert.equal(state().screenshot?.page, 2)
    assert.equal(state().screenshot?.revision, 7)
    assert.equal(state().phase, null)
    assert.ok(events.includes('clear-error'))
    await act(async () => { state().close() })
    assert.equal(state().screenshot, null)
    assert.equal(selection(), null)
  })
})

test('screenshot refuses a stale native document before capture', async () => {
  await withScreenshot(async ({ state, options, render, errors, mode }) => {
    let captures = 0
    await render({ ...options, documentReady: () => false,
      captureRegion: async () => { captures++; return image() } })
    await act(async () => { state().begin(false); await state().takeRegion(2, region) })
    assert.equal(mode(), 'text')
    assert.equal(captures, 0)
    assert.deepEqual(errors, ['reader.notReady'])
  })
})

test('late screenshot from a superseded revision is never published', async () => {
  await withScreenshot(async ({ state, options, render }) => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    let current = snapshot
    await render({ ...options, currentSnapshot: () => current,
      captureRegion: async () => { await gate; return image() } })
    let pending: Promise<void> | undefined
    await act(async () => { pending = state().takeRegion(2, region); await Promise.resolve() })
    assert.equal(state().phase, 'preparing')
    current = { ...snapshot, revision: 8 }
    await act(async () => { release!(); await pending })
    assert.equal(state().screenshot, null)
    assert.equal(state().phase, null)
  })
})

test('late screenshot from a previous display owner cannot leak into the next resource', async () => {
  await withScreenshot(async ({ state, options, render }) => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    await render({ ...options, captureRegion: async () => { await gate; return image() } })
    let pending: Promise<void> | undefined
    await act(async () => { pending = state().takeRegion(2, region); await Promise.resolve() })
    options.ownerSequence.current = 2
    await act(async () => { release!(); await pending })
    assert.equal(state().screenshot, null)
    assert.equal(state().phase, null)
  })
})

test('cancel and tab abort suppress a late screenshot and settle progress', async () => {
  await withScreenshot(async ({ state, options, render, tab, errors, mode }) => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    await render({ ...options, captureRegion: async () => { await gate; return image() } })
    let pending: Promise<void> | undefined
    await act(async () => { state().begin(false); pending = state().takeRegion(2, region); await Promise.resolve() })
    await act(async () => { state().cancel() })
    assert.equal(mode(), 'text')
    assert.equal(state().phase, 'cancelling')
    assert.equal(state().controller.current?.signal.aborted, true)
    await act(async () => { tab.abort(); release!(); await pending })
    assert.equal(state().phase, null)
    assert.equal(state().screenshot, null)
    assert.deepEqual(errors, [])
  })
})
