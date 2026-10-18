import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { usePdfViewportSize } from '../src/client/use-pdf-viewport-size.ts'
import { usePdfWheelZoom } from '../src/client/use-pdf-wheel-zoom.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dshRequire = createRequire(join(root, '..', 'deepseek-harness', 'package.json'))
const { JSDOM } = dshRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

async function withDom(run: (dom: Window & typeof globalThis, viewport: HTMLElement,
  render: (element: React.ReactElement) => Promise<void>, frames: Map<number, FrameRequestCallback>) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><div id="mount"></div><div id="viewport"><div data-page-number="1"><div data-pdf-page="1"></div></div></div>',
    { url: 'http://localhost' }).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 1
  const globals = { window: dom, document: dom.document, Element: dom.Element, HTMLElement: dom.HTMLElement,
    Event: dom.Event, WheelEvent: dom.WheelEvent, MouseEvent: dom.MouseEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = nextFrame++
      frames.set(id, callback)
      return id
    },
    cancelAnimationFrame: (id: number) => { frames.delete(id) },
    IS_REACT_ACT_ENVIRONMENT: true }
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const mount = dom.document.getElementById('mount')!
  const viewport = dom.document.getElementById('viewport')!
  const view = createRoot(mount)
  try {
    await run(dom, viewport, async element => { await act(async () => { view.render(element) }) }, frames)
  } finally {
    await act(async () => { view.unmount() })
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('a hidden viewport clears its stale measurement, then reports the next visible size as initial', async () => {
  await withDom(async (_dom, viewport, render) => {
    let measured!: (entry: ResizeObserverEntry[]) => void
    const prior = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class {
      constructor(callback: (entry: ResizeObserverEntry[]) => void) { measured = callback }
      observe() {}
      disconnect() {}
    } })
    try {
      const sizes: Array<[number, number]> = []
      const Component = () => {
        usePdfViewportSize({ root: viewport, ownerKey: 'doc', preserveAnchor: true, size: { width: 0, height: 0 },
          onSize: size => { sizes.push([size.width, size.height]) } })
        return null
      }
      await render(React.createElement(Component))
      const report = (width: number, height: number) => measured([{ contentRect: { width, height } } as ResizeObserverEntry])
      report(800, 600)
      report(0, 0)
      report(900, 700)
      assert.deepEqual(sizes, [[800, 600], [900, 700]])
    } finally {
      if (prior) Object.defineProperty(globalThis, 'ResizeObserver', prior)
      else Reflect.deleteProperty(globalThis, 'ResizeObserver')
    }
  })
})

test('wheel zoom gives up a stale page layout after bounded restore retries and releases its preview', async () => {
  await withDom(async (dom, viewport, render, frames) => {
    const page = viewport.querySelector<HTMLElement>('[data-pdf-page]')!
    const rect = (width: number, height: number) => ({ left: 0, top: 0, right: width, bottom: height,
      width, height, x: 0, y: 0, toJSON() {} })
    page.getBoundingClientRect = () => rect(100, 100)
    viewport.getBoundingClientRect = () => rect(500, 500)
    Object.defineProperties(page, { offsetWidth: { configurable: true, value: 100 },
      offsetHeight: { configurable: true, value: 100 } })
    Object.defineProperties(viewport, { clientWidth: { configurable: true, value: 500 },
      clientHeight: { configurable: true, value: 500 } })
    const scales: number[] = []
    const Component = () => {
      usePdfWheelZoom({ root: viewport, enabled: true, views: new Map(), getScale: () => 1,
        onScale: scale => { scales.push(scale) }, ownerKey: 'doc' })
      return null
    }
    await render(React.createElement(Component))
    page.dispatchEvent(new dom.WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true,
      deltaY: -100, clientX: 50, clientY: 50 }))
    viewport.dispatchEvent(new dom.MouseEvent('pointerdown', { bubbles: true }))
    assert.equal(scales.length, 1)
    assert.equal(viewport.style.getPropertyValue('overflow-anchor'), 'none')
    // React has not committed the new scale: the page offset remains 100px.
    // The retry clock must eventually give up and clean up this preview.
    for (let attempt = 0; attempt < 65 && frames.size; attempt++) {
      const [id, callback] = frames.entries().next().value as [number, FrameRequestCallback]
      frames.delete(id)
      callback(16 * attempt)
    }
    assert.equal(frames.size, 0)
    assert.equal(page.style.transform, '')
    assert.equal(viewport.style.getPropertyValue('overflow-anchor'), '')
  })
})
