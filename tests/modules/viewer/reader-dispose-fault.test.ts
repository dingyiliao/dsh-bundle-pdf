import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { defaultSettings, type PdfClientApi, type WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import type { ReaderProps } from '../../../src/client/contracts.ts'
import { NativeDocument } from '../../../src/modules/viewer/index.ts'

registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: 'export default ""', shortCircuit: true }
  return next(url, context)
} })

const project = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

function snapshot(id: string): WorkspaceSnapshot {
  return {
    id, path: `/tmp/${id}.pdf`, sourceVersion: `source-${id}`, contentVersion: `content-${id}`,
    revision: 1, dirty: false, canUndo: false, canRedo: false, conflict: false,
    reader: { bytesHash: `sha256-${id}`, generation: 1, protocolVersion: 1 },
    document: { pageCount: 1, pages: [{ page: 1, cropBox: [0, 0, 400, 600], rotation: 0, userUnit: 1 }],
      annotations: [], signed: false, encrypted: false, readOnly: false },
  }
}

test('document cleanup faults do not fail a loaded replacement or a closing tab', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  Object.defineProperty(dom.HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => null })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator,
    HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Element: dom.Element,
    Node: dom.Node, Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
    PointerEvent: dom.PointerEvent ?? dom.MouseEvent, MutationObserver: dom.MutationObserver,
    DOMRect: dom.DOMRect, getComputedStyle: dom.getComputedStyle.bind(dom),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }

  const originalDispose = NativeDocument.prototype.dispose
  const originalWarn = console.warn
  const warnings: unknown[][] = []
  NativeDocument.prototype.dispose = async function () {
    await originalDispose.call(this)
    if (this.snapshot.id === 'old') throw new Error('old document cleanup failed')
    if (this.snapshot.id === 'stale') throw new Error('stale document cleanup failed')
  }
  console.warn = (...args: unknown[]) => { warnings.push(args) }

  let root: import('react-dom/client').Root | undefined
  const tab = new AbortController()
  try {
    const { Reader } = await import('../../../src/client/Reader.tsx')
    const { createRoot } = await import('react-dom/client')
    const container = dom.document.getElementById('root')!
    root = createRoot(container)
    const loaded: string[] = [], failed: string[] = []
    const api = {
      native: {
        async tile() { throw new Error('non-visible pages must not request tiles') },
        async text() { return { items: [], styles: {}, lang: null } },
        async links() { return [] }, async outline() { return null }, async destination() { return null },
      },
      bookmarks: { async list() { return [] }, async add() { return [] }, async rename() { return [] }, async remove() { return [] } },
      positions: { async get() { return null }, async set() {} },
      async open(_sessionId: string, address: string) {
        if (address.endsWith('/broken.pdf')) throw new Error('real open failure')
        return snapshot(address.endsWith('/stale.pdf') ? 'stale' : address.endsWith('/new.pdf') ? 'new'
          : address.endsWith('/fault.pdf') ? 'fault' : 'old')
      },
      subscribe() { return () => {} },
    } as unknown as PdfClientApi
    const props = {
      resourceAddress: 'file:///tmp/old.pdf', sessionId: 'session-1',
      scrollportRef() {}, useTabInfo: () => ({ tab: { id: 'tab-1', signal: tab.signal, visible: true } }),
      content: { kind: 'renderer', revision: 1, loaded: (value: string) => loaded.push(value), failed: () => failed.push('failed') },
      t: (key: string) => key, api,
      hostOcr: { async availability() { return { status: 'disabled' as const } }, async recognize() { throw new Error('not configured') } },
      imageUnderstanding: { async availability() { return { status: 'unavailable' as const, reason: 'not configured' } },
        async prepare() { throw new Error('not configured') } },
      translation: { list: () => [] }, settings: defaultSettings,
    } as unknown as ReaderProps
    const render = async (value: ReaderProps) => { await act(async () => {
      root!.render(React.createElement(Reader, value))
      await new Promise(resolve => setTimeout(resolve, 5))
    }) }

    await render(props)
    assert.ok(loaded.includes('source-old'))
    await render({ ...props, resourceAddress: 'file:///tmp/new.pdf', content: { ...props.content, revision: 2 } })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
    assert.ok(loaded.includes('source-new'), 'the replacement was accepted before the old owner was disposed')
    assert.deepEqual(failed, [], 'cleanup failure must not mark an already loaded document as failed')
    assert.equal(container.querySelector('[role="alert"]'), null)
    assert.ok(container.querySelector('.dsh-pdf-windowed-pages'))
    assert.ok(warnings.some(args => args[0] === '[pdf] Could not release the previous document'
      && args[1] instanceof Error && args[1].message === 'old document cleanup failed'))

    await render({ ...props, resourceAddress: 'file:///tmp/broken.pdf', content: { ...props.content, revision: 3 } })
    assert.deepEqual(failed, ['failed'], 'genuine open failures must still be reported')
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /real open failure/)

    // The preview owner is external to Reader. A valid PDF can still fail while
    // that owner acknowledges loading; report the callback failure instead of
    // silently treating the document as ready.
    let loadCallbackFailed = false
    await render({ ...props, resourceAddress: 'file:///tmp/fault.pdf', content: {
      ...props.content, revision: 4, loaded: () => {
        if (loadCallbackFailed) return
        loadCallbackFailed = true
        throw new Error('preview owner load callback failed')
      },
    } })
    assert.equal(loadCallbackFailed, true)
    assert.deepEqual(failed, ['failed', 'failed'], 'a failing preview owner must receive failed()')
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /preview owner load callback failed/)

    // A real tab close can race the microtask in which native opening settles.
    // Trigger it as soon as Reader asks for the native backend, before the
    // already-resolved openNativeDocument promise can publish its owner.
    const native = api.native
    Object.defineProperty(api, 'native', { configurable: true, get() {
      queueMicrotask(() => {
        act(() => { root!.unmount() })
        root = undefined
      })
      return native
    } })
    const failuresBeforeClose = failed.length
    await render({ ...props, resourceAddress: 'file:///tmp/stale.pdf', content: { ...props.content, revision: 5 } })
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(root, undefined, 'the tab closed before native opening settled')
    assert.equal(failed.length, failuresBeforeClose, 'stale cleanup must not fail a closed preview owner')
    assert.equal(loaded.includes('source-stale'), false)
    assert.ok(warnings.some(args => args[0] === '[pdf] Could not release a stale document'
      && args[1] instanceof Error && args[1].message === 'stale document cleanup failed'))
  } finally {
    if (root) await act(async () => { root!.unmount() })
    tab.abort()
    NativeDocument.prototype.dispose = originalDispose
    console.warn = originalWarn
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
