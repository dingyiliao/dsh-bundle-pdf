import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { ReaderSelection, PageView } from '../../../src/modules/viewer/model/reader-selection.ts'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import { useReaderSelection, type ReaderSelectionOptions } from '../../../src/modules/viewer/index.ts'

const project = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}
const initial = { id: 'doc-1', revision: 4 } as WorkspaceSnapshot
const selected: ReaderSelection = {
  revision: 4, kind: 'text', text: 'copied words',
  fragments: [{ page: 1, rect: [10, 20, 30, 40], quadPoints: [] }],
}

async function withSelection(run: (fixture: {
  state(): ReturnType<typeof useReaderSelection>
  options: ReaderSelectionOptions
  render(options: ReaderSelectionOptions): Promise<void>
  root: HTMLElement
  frames: Map<number, FrameRequestCallback>
  flushFrame(): Promise<void>
  captured: (ReaderSelection | null)[]
  dragging(): number | null
}) => Promise<void>): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div><div id="scroll"><span>inside</span></div><div id="outside">outside</div></body></html>',
    { url: 'http://localhost' }).window
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, DOMRect: dom.DOMRect,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame },
    cancelAnimationFrame: (id: number) => { frames.delete(id) },
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const mount = createRoot(dom.document.getElementById('root')!)
  const scroll = dom.document.getElementById('scroll')!
  const tab = new AbortController()
  const ownerSequence = { current: 1 }
  let current = initial
  let dragging: number | null = 1
  const captured: (ReaderSelection | null)[] = []
  let latest: ReturnType<typeof useReaderSelection> | undefined
  const Harness = (props: ReaderSelectionOptions) => { latest = useReaderSelection(props); return null }
  const options: ReaderSelectionOptions = {
    mode: 'text', scrollRoot: scroll, snapshot: initial, views: { current: new Map<number, PageView>() },
    ownerSequence, currentSnapshot: () => current, tabSignal: tab.signal,
    setDraggingPage: value => { dragging = typeof value === 'function' ? value(dragging) : value },
    shouldIgnore: () => false, onCaptured: value => { captured.push(value) },
    onError: error => { throw error }, t: key => key,
  }
  const render = async (next: ReaderSelectionOptions) => {
    current = next.snapshot ?? current
    await act(async () => { mount.render(React.createElement(Harness, next)) })
  }
  const flushFrame = async () => {
    const pending = [...frames.values()]
    frames.clear()
    await act(async () => { for (const callback of pending) callback(0) })
  }
  try {
    await render(options)
    await run({ state: () => latest!, options, render, root: scroll, frames, flushFrame, captured,
      dragging: () => dragging })
  } finally {
    await act(async () => mount.unmount())
    tab.abort()
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('pointer capture waits for the next frame and drops stale owner or revision', async () => {
  await withSelection(async ({ state, options, render, flushFrame, captured, dragging }) => {
    await act(async () => state().scheduleCapture())
    assert.deepEqual(captured, [])
    await flushFrame()
    assert.deepEqual(captured, [null])
    assert.equal(dragging(), null)

    await act(async () => state().scheduleCapture())
    options.ownerSequence.current++
    await flushFrame()
    assert.equal(captured.length, 1)

    await act(async () => state().scheduleCapture())
    await render({ ...options, snapshot: { ...initial, revision: 5 } })
    await flushFrame()
    assert.equal(captured.length, 1)
  })
})

test('reset and clear invalidate queued capture; clear removes only this reader’s native range', async () => {
  await withSelection(async ({ state, root, frames, flushFrame, captured }) => {
    await act(async () => state().scheduleCapture())
    await act(async () => state().reset())
    assert.equal(frames.size, 0)
    await flushFrame()
    assert.deepEqual(captured, [])

    const range = document.createRange()
    range.selectNodeContents(root.firstElementChild!)
    window.getSelection()!.addRange(range)
    assert.equal(window.getSelection()?.rangeCount, 1)
    await act(async () => state().clear())
    assert.equal(window.getSelection()?.rangeCount, 0)

    const outside = document.getElementById('outside')!
    range.selectNodeContents(outside)
    window.getSelection()!.addRange(range)
    await act(async () => state().clear())
    assert.equal(window.getSelection()?.rangeCount, 1)
    window.getSelection()!.removeAllRanges()
  })
})

test('copy feedback belongs to the same selection, not a later one', async () => {
  await withSelection(async ({ state, options, render }) => {
    let finish: (() => void) | undefined
    const pending = new Promise<void>(resolve => { finish = resolve })
    const writes: string[] = []
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { writes.push(text); await pending },
    } })
    await act(async () => state().setSelection(selected))
    assert.equal(state().hasTextSelection, true)
    let copy: Promise<void> | undefined
    await act(async () => { copy = state().copyText(); await Promise.resolve() })
    await act(async () => state().setSelection({ ...selected, text: 'replacement' }))
    await act(async () => { finish!(); await copy })
    assert.deepEqual(writes, ['copied words'])
    assert.equal(state().textCopied, false)

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { writes.push(text) },
    } })
    await act(async () => { await state().copyText() })
    assert.deepEqual(writes, ['copied words', 'replacement'])
    assert.equal(state().textCopied, true)
    await render({ ...options, snapshot: { ...initial, revision: 5 } })
    assert.equal(state().hasTextSelection, false)
  })
})

test('PDF fragment anchors use page geometry and ignore offscreen fragments', async () => {
  await withSelection(async ({ state, options, render, root }) => {
    root.getBoundingClientRect = () => new DOMRect(0, 0, 500, 500)
    const element = document.createElement('div')
    element.getBoundingClientRect = () => new DOMRect(100, 200, 200, 200)
    const viewport = { convertToViewportPoint: (x: number, y: number) => [x, y] } as PageView['viewport']
    const view = { element, viewport, page: {} } as unknown as PageView
    const views = { current: new Map([[1, view]]) }
    await render({ ...options, views })
    const anchor = state().fragmentAnchor([{ page: 1, rect: [10, 20, 30, 40], quadPoints: [] }])
    assert.deepEqual(anchor && [anchor.left, anchor.top, anchor.width, anchor.height], [110, 220, 20, 20])
    element.getBoundingClientRect = () => new DOMRect(100, 600, 200, 200)
    assert.equal(state().fragmentAnchor([{ page: 1, rect: [10, 20, 30, 40], quadPoints: [] }]), null)
  })
})
