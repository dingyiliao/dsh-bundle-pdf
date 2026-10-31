import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import React, { act, useState } from 'react'
import { usePdfViewportSize, type PdfViewportSize } from '../../../src/modules/viewer/controllers/use-pdf-viewport-size.ts'
import { usePdfWheelZoom } from '../../../src/modules/viewer/controllers/use-pdf-wheel-zoom.ts'
import { WindowedPages } from '../../../src/modules/viewer/rendering/WindowedPages.tsx'
import { readingPageProbe } from '../../../src/modules/viewer/rendering/page-layout.ts'
import { clearWheelZoomReflow, pageIndexAtOffset, setWheelZoomReflow, setWindowLayout, wheelZoomReflow, windowLayout,
  type WheelZoomReflow } from '../../../src/modules/viewer/rendering/window-layout.ts'
import { readerPageScale } from '../../../src/modules/viewer/controllers/navigation-position.ts'
import { readingViewportBounds } from '../../../src/modules/viewer/rendering/pdf-viewport-geometry.ts'

const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
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
        usePdfViewportSize({ root: viewport, ownerKey: 'doc', size: { width: 0, height: 0 },
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

test('the viewport owns floating chrome gutters without reducing its measured full-width scrollport', async () => {
  await withDom(async (dom, viewport, render) => {
    let resized!: (entries: ResizeObserverEntry[]) => void
    const prior = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class {
      constructor(callback: (entries: ResizeObserverEntry[]) => void) { resized = callback }
      observe() {}
      disconnect() {}
    } })
    const body = dom.document.createElement('div'), rail = dom.document.createElement('nav'), sidebar = dom.document.createElement('aside')
    body.className = 'dsh-pdf-body'; rail.dataset.pdfToolRail = ''; sidebar.className = 'dsh-pdf-sidebar'
    body.append(rail, viewport, sidebar); dom.document.body.append(body)
    const rect = (left: number, width: number) => ({ left, right: left + width, top: 0, bottom: 600, width, height: 600 } as DOMRect)
    let panelWidth = 56
    viewport.getBoundingClientRect = () => rect(0, 1000)
    rail.getBoundingClientRect = () => rect(14, 56)
    sidebar.getBoundingClientRect = () => rect(1000 - 18 - panelWidth, panelWidth)
    viewport.style.paddingLeft = '86px'; viewport.style.paddingRight = '90px'
    Object.defineProperties(viewport, { clientWidth: { value: 1000 }, clientHeight: { value: 600 } })
    try {
      const sizes: PdfViewportSize[] = []
      const Component = () => {
        usePdfViewportSize({ root: viewport, ownerKey: 'doc', size: { width: 0, height: 0 }, onSize: size => sizes.push(size) })
        return null
      }
      await render(React.createElement(Component))
      assert.equal(viewport.style.getPropertyValue('--pdf-reading-gutter-left'), '86px')
      assert.equal(viewport.style.getPropertyValue('--pdf-reading-gutter-right'), '90px')
      assert.deepEqual(sizes.at(-1), { width: 1000, height: 600, paddingLeft: 86, paddingRight: 90 })
      panelWidth = 296
      // JSDOM does not resolve var() values; apply the computed CSS padding that
      // the browser obtains from the measured gutter before its next RO report.
      viewport.style.paddingRight = '330px'
      resized([{ target: sidebar, contentRect: rect(0, 296) } as unknown as ResizeObserverEntry])
      assert.equal(viewport.style.getPropertyValue('--pdf-reading-gutter-right'), '330px')
      assert.deepEqual(sizes.at(-1), { width: 1000, height: 600, paddingLeft: 86, paddingRight: 330 })
      assert.deepEqual(readingViewportBounds(viewport), { left: 86, right: 670, top: 0, bottom: 600, width: 584, height: 600 })
      const count = sizes.length
      resized([{ target: viewport, contentRect: rect(0, 584) } as unknown as ResizeObserverEntry])
      assert.equal(sizes.length, count, 'the padding-induced content-box resize cannot trigger a feedback loop')
    } finally {
      if (prior) Object.defineProperty(globalThis, 'ResizeObserver', prior)
      else Reflect.deleteProperty(globalThis, 'ResizeObserver')
    }
  })
})

test('custom zoom retains the reading point and both page edges remain reachable when a floating sidebar expands', async () => {
  await withDom(async (dom, viewport, render) => {
    const mount = dom.document.getElementById('mount')!
    viewport.replaceChildren(mount)
    let size: PdfViewportSize = { width: 800, height: 600, paddingLeft: 86, paddingRight: 90 }
    Object.defineProperties(viewport, { clientWidth: { value: 800 }, clientHeight: { value: 600 } })
    const pages = [{ page: 1, cropBox: [0, 0, 400, 600] as [number, number, number, number], userUnit: 1, rotation: 0 }]
    const draw = () => render(React.createElement(WindowedPages, { pages, rotation: 0, zoom: 3, fit: 'custom', size,
      scrollRoot: viewport, scaleForPage: () => 3, preserveAnchor: true, renderPage: () => null }))
    await draw()
    viewport.scrollLeft = 200; viewport.scrollTop = 250
    size = { ...size, paddingRight: 330 }; await draw()
    const page = windowLayout(viewport)![0]!
    assert.equal(page.scale, 3); assert.equal(page.width, 1200)
    assert.equal(page.left, 86); assert.equal(viewport.scrollLeft, 200); assert.equal(viewport.scrollTop, 250)
    const canvasWidth = Number.parseFloat(mount.querySelector<HTMLElement>('.dsh-pdf-windowed-pages')!.style.width)
    const maxScroll = size.paddingLeft! + canvasWidth + size.paddingRight! - size.width
    assert.equal(page.left! - 0, size.paddingLeft, 'scrolling to zero exposes the left page edge beyond the tool rail')
    assert.equal(page.left! + page.width - maxScroll, size.width - size.paddingRight!,
      'the right tail allows the page edge to scroll completely out from behind the expanded sidebar')
  })
})

for (const fit of ['width', 'page'] as const) test(`numeric fit-${fit} reflow preserves a distant page at the reading inset without a mounted PageView`, async () => {
  await withDom(async (dom, viewport, render) => {
    const mount = dom.document.getElementById('mount')!
    viewport.replaceChildren(mount)
    let size: PdfViewportSize = { width: 432, height: 632 }
    Object.defineProperties(viewport, { clientWidth: { configurable: true, get: () => size.width },
      clientHeight: { configurable: true, get: () => size.height } })
    const pages = Array.from({ length: 1151 }, (_, index) => ({ page: index + 1,
      cropBox: [0, 0, 400, 600] as [number, number, number, number], userUnit: 1, rotation: 0 }))
    const draw = (nextSize: typeof size, preserveAnchor = true) => {
      size = nextSize
      return render(React.createElement(WindowedPages, {
        pages, rotation: 0, zoom: 1, fit, size, scrollRoot: viewport,
        scaleForPage: page => readerPageScale(page, { fit, zoom: 1, size }),
        preserveAnchor, renderPage: () => null,
      }))
    }
    await draw(size)
    viewport.scrollTop = windowLayout(viewport)![751]!.top - (readingPageProbe(size.height) - 1)
    for (const nextSize of [{ width: 620, height: 500 }, { width: 620, height: 500, paddingLeft: 86, paddingRight: 330 },
      { width: 500, height: 720 }, { width: 360, height: 400 }]) {
      await draw(nextSize)
      const layout = windowLayout(viewport)!
      assert.equal(layout[pageIndexAtOffset(layout, viewport.scrollTop + readingPageProbe(size.height))]!.page, 752)
      assert.equal(viewport.querySelector('[data-pdf-page]'), null,
        'reflow cannot depend on a PageView element that virtual rendering may have removed')
    }
    const beforeNavigation = viewport.scrollTop
    await draw({ width: 600, height: 650 }, false)
    assert.equal(viewport.scrollTop, beforeNavigation, 'an explicit navigation owns scroll while its target is pinned')
  })
})

test('wheel zoom keeps an off-center PDF point when committing a distant virtual page', async () => {
  await withDom(async (dom, viewport, render, frames) => {
    const mount = dom.document.getElementById('mount')!
    viewport.replaceChildren(mount)
    viewport.style.paddingLeft = '16px'; viewport.style.paddingRight = '16px'
    const rect = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width,
      bottom: top + height, width, height, x: left, y: top, toJSON() {} })
    viewport.getBoundingClientRect = () => rect(0, 0, 800, 600)
    Object.defineProperties(viewport, { clientWidth: { value: 800 }, clientHeight: { value: 600 },
      scrollWidth: { get: () => Number.parseFloat(mount.querySelector<HTMLElement>('.dsh-pdf-windowed-pages')?.style.width ?? '0') + 32 } })
    const pages = Array.from({ length: 20 }, (_, index) => ({ page: index + 1,
      cropBox: [0, 0, 400, 600] as [number, number, number, number], userUnit: 1, rotation: 0 }))
    const size = { width: 800, height: 600, paddingLeft: 16, paddingRight: 16 }
    let holdCommit = false, commitScale!: (scale: number) => void
    const requested: number[] = []
    function Reader() {
      const [scale, setScale] = useState(1)
      commitScale = setScale
      usePdfWheelZoom({ root: viewport, enabled: true, ownerKey: 'doc', views: new Map(), getScale: () => scale,
        maxScale: 3, onScale: value => { requested.push(value); if (!holdCommit) setScale(value) } })
      return React.createElement(WindowedPages, { ownerKey: 'doc', pages, rotation: 0, zoom: scale, fit: 'custom', size,
        scrollRoot: viewport, scaleForPage: () => scale, preserveAnchor: true,
        renderPage: page => React.createElement('div', { 'data-pdf-page': page.page, ref: (element: HTMLDivElement | null) => {
          if (!element) return
          const stage = () => element.closest<HTMLElement>('.dsh-pdf-page-stage')!
          Object.defineProperties(element, { offsetWidth: { configurable: true, get: () => Number.parseFloat(stage().style.width) },
            offsetHeight: { configurable: true, get: () => Number.parseFloat(stage().style.height) } })
          element.getBoundingClientRect = () => {
            const wrapper = element.closest<HTMLElement>('[data-page-number]')!
            const width = element.offsetWidth, height = element.offsetHeight
            return rect(16 + (Number.parseFloat(wrapper.style.width) - width) / 2 - viewport.scrollLeft,
              Number.parseFloat(wrapper.style.top) - viewport.scrollTop, width, height)
          }
        } }),
      })
    }
    const flush = async () => {
      for (let attempt = 0; frames.size; attempt++) {
        assert.ok(attempt < 20, 'zoom/layout must settle without another scrolling owner restarting it')
        await act(async () => {
          for (const id of [...frames.keys()]) {
            const callback = frames.get(id)
            if (callback) { frames.delete(id); callback(attempt * 16) }
          }
        })
      }
    }
    await render(React.createElement(Reader))
    await flush()
    viewport.scrollTop = windowLayout(viewport)![7]!.top + 100
    await act(async () => { viewport.dispatchEvent(new dom.Event('scroll')) })
    await flush()
    const page = viewport.querySelector<HTMLElement>('[data-pdf-page="8"]')!
    assert.ok(page, 'the pointer page starts inside the virtual window')
    const pointerY = 100
    const pdfY = pointerY - page.getBoundingClientRect().top
    await act(async () => {
      page.dispatchEvent(new dom.WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true,
        deltaY: -Math.log(2) / .002, clientX: 400, clientY: pointerY }))
      viewport.dispatchEvent(new dom.MouseEvent('pointerdown', { bubbles: true }))
    })
    await flush()
    const zoomed = viewport.querySelector<HTMLElement>('[data-pdf-page="8"]')!
    assert.ok(zoomed)
    assert.equal(zoomed.offsetHeight, 1200)
    assert.equal(zoomed.getBoundingClientRect().top + pdfY * 2, pointerY,
      'a gesture restores its pointer point rather than the generic viewport-center anchor')
    assert.equal(mount.querySelector<HTMLElement>('.dsh-pdf-windowed-pages')!.style.transform, '')
    assert.equal(wheelZoomReflow(viewport), undefined)

    // A trailing wheel event can arrive after the first scale was requested
    // but before React commits it. Its preview must use that new committed
    // baseline rather than scaling a second time from the original bitmap.
    holdCommit = true
    const wheel = () => zoomed.dispatchEvent(new dom.WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true,
      deltaY: -Math.log(1.1) / .002, clientX: 400, clientY: pointerY }))
    await act(async () => { wheel(); viewport.dispatchEvent(new dom.MouseEvent('pointerdown', { bubbles: true })); wheel() })
    const first = requested.at(-1)!
    await act(async () => { commitScale(first) })
    const stage = viewport.querySelector<HTMLElement>('[data-page-number="8"] .dsh-pdf-page-stage')!
    const previewRatio = Number(stage.style.transform.match(/scale\(([^)]+)\)/)?.[1])
    assert.ok(Math.abs(previewRatio - 1.1) < .000001, 'the in-flight continuation rebases on the newly committed layout')
    await act(async () => { viewport.dispatchEvent(new dom.MouseEvent('pointerdown', { bubbles: true })); commitScale(requested.at(-1)!) })
    await flush()
    const continued = viewport.querySelector<HTMLElement>('[data-pdf-page="8"]')!
    assert.ok(Math.abs(continued.getBoundingClientRect().top + pdfY * requested.at(-1)! - pointerY) < .000001)
    assert.equal(stage.style.transform, '')
    assert.equal(wheelZoomReflow(viewport), undefined)
    holdCommit = false
    const atMaximum = async () => {
      await act(async () => {
        continued.dispatchEvent(new dom.WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true,
          deltaY: -500, clientX: 400, clientY: pointerY }))
        viewport.dispatchEvent(new dom.MouseEvent('pointerdown', { bubbles: true }))
      })
      await flush()
    }
    await atMaximum()
    const positionAtMaximum = [viewport.scrollLeft, viewport.scrollTop]
    await atMaximum()
    assert.equal(requested.at(-1), 3)
    assert.deepEqual([viewport.scrollLeft, viewport.scrollTop], positionAtMaximum)
    assert.equal(wheelZoomReflow(viewport), undefined, 'a same-value React bailout releases the accepted wheel lease')
  })
})

test('a new document, rotation or navigation rejects an old wheel lease before passive hook cleanup', async () => {
  await withDom(async (dom, viewport, render) => {
    const mount = dom.document.getElementById('mount')!
    viewport.replaceChildren(mount)
    Object.defineProperties(viewport, { clientWidth: { value: 800 }, clientHeight: { value: 600 } })
    const pages = [{ page: 1, cropBox: [0, 0, 400, 600] as [number, number, number, number], userUnit: 1, rotation: 0 }]
    let owner = 'one', rotation = 0, scale = 1, preserveAnchor = true, cancelled = 0, prepared = 0, completed = 0
    const draw = () => render(React.createElement(WindowedPages, { ownerKey: owner, pages, rotation, zoom: scale, fit: 'custom',
      size: { width: 800, height: 600 }, scrollRoot: viewport, scaleForPage: () => scale, preserveAnchor, renderPage: () => null }))
    const queue = () => {
      const request: WheelZoomReflow = { ownerKey: owner, source: windowLayout(viewport)!, page: 1, scale: scale + 1,
        fraction: [.2, .2], pointer: [120, 100], prepare() { prepared++ }, complete() { completed++ },
        cancel() { cancelled++; clearWheelZoomReflow(viewport, request) } }
      setWheelZoomReflow(viewport, request)
    }
    await draw(); queue()
    owner = 'two'; scale++; await draw()
    assert.equal(cancelled, 1); assert.equal(wheelZoomReflow(viewport), undefined)
    queue(); rotation = 180; scale++; await draw()
    assert.equal(cancelled, 2); assert.equal(wheelZoomReflow(viewport), undefined)
    queue(); preserveAnchor = false; scale++; await draw()
    assert.equal(cancelled, 3); assert.equal(wheelZoomReflow(viewport), undefined)
    preserveAnchor = true; queue()
    await render(React.createElement('div'))
    scale++; await draw()
    assert.equal(cancelled, 4, 'a new window instance cannot consume the previous instance\'s anchor')
    assert.equal(prepared, 0); assert.equal(completed, 0)
  })
})

test('a standalone Page keeps its local pointer preview and settles an unchanged maximum scale', async () => {
  await withDom(async (dom, viewport, render, frames) => {
    const page = viewport.querySelector<HTMLElement>('[data-pdf-page]')!
    let actualScale = 1
    const rect = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width,
      bottom: top + height, width, height, x: left, y: top, toJSON() {} })
    page.getBoundingClientRect = () => rect(20 - viewport.scrollLeft, 30 - viewport.scrollTop, 100 * actualScale, 100 * actualScale)
    viewport.getBoundingClientRect = () => rect(0, 0, 500, 500)
    Object.defineProperties(page, { offsetWidth: { get: () => 100 * actualScale }, offsetHeight: { get: () => 100 * actualScale } })
    Object.defineProperties(viewport, { clientWidth: { value: 500 }, clientHeight: { value: 500 } })
    function Reader() {
      const [scale, setScale] = useState(1)
      actualScale = scale
      usePdfWheelZoom({ root: viewport, enabled: true, ownerKey: 'page', views: new Map(), getScale: () => scale,
        onScale: setScale, maxScale: 2 })
      return null
    }
    const frame = async () => act(async () => {
      for (const id of [...frames.keys()]) {
        const callback = frames.get(id)
        if (callback) { frames.delete(id); callback(16) }
      }
    })
    await render(React.createElement(Reader))
    await act(async () => {
      page.dispatchEvent(new dom.WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true,
        deltaY: -Math.log(2) / .002, clientX: 50, clientY: 70 }))
    })
    await frame()
    assert.equal(page.style.transform, 'scale(2)')
    await act(async () => { viewport.dispatchEvent(new dom.MouseEvent('pointerdown', { bubbles: true })) })
    assert.equal(page.getBoundingClientRect().left + 60, 50)
    assert.equal(page.getBoundingClientRect().top + 80, 70)
    assert.equal(page.style.transform, '')
    const before = [viewport.scrollLeft, viewport.scrollTop]
    await act(async () => {
      page.dispatchEvent(new dom.WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true,
        deltaY: -100, clientX: 50, clientY: 70 }))
      viewport.dispatchEvent(new dom.MouseEvent('pointerdown', { bubbles: true }))
    })
    await frame()
    assert.equal(actualScale, 2)
    assert.deepEqual([viewport.scrollLeft, viewport.scrollTop], before)
    assert.equal(page.style.transform, '')
    assert.equal(viewport.style.getPropertyValue('overflow-anchor'), '')
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
    setWindowLayout(viewport, [{ page: 1, left: 0, top: 0, width: 100, height: 100, outerHeight: 116, scale: 1 }])
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
    assert.ok(wheelZoomReflow(viewport), 'an accepted scale has one pending window-layout owner')
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
    assert.equal(wheelZoomReflow(viewport), undefined, 'an abandoned commit cannot affect a later gesture')
  })
})

test('disabling, changing document and unmounting release pending wheel reflow ownership', async () => {
  await withDom(async (dom, viewport, render) => {
    const page = viewport.querySelector<HTMLElement>('[data-pdf-page]')!
    const rect = { left: 0, top: 0, right: 400, bottom: 600, width: 400, height: 600, x: 0, y: 0, toJSON() {} }
    page.getBoundingClientRect = () => rect
    viewport.getBoundingClientRect = () => rect
    Object.defineProperties(page, { offsetWidth: { configurable: true, value: 400 }, offsetHeight: { configurable: true, value: 600 } })
    Object.defineProperties(viewport, { clientWidth: { value: 400 }, clientHeight: { value: 600 } })
    setWindowLayout(viewport, [{ page: 1, left: 0, top: 0, width: 400, height: 600, outerHeight: 616, scale: 1 }])
    function Reader({ enabled, owner }: { enabled: boolean; owner: string }) {
      usePdfWheelZoom({ root: viewport, enabled, ownerKey: owner, views: new Map(), getScale: () => 1, onScale() {} })
      return null
    }
    const begin = async () => {
      await act(async () => {
        page.dispatchEvent(new dom.WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true,
          deltaY: -100, clientX: 120, clientY: 100 }))
        viewport.dispatchEvent(new dom.MouseEvent('pointerdown', { bubbles: true }))
      })
      assert.ok(wheelZoomReflow(viewport))
    }
    await render(React.createElement(Reader, { enabled: true, owner: 'one' }))
    await begin()
    await render(React.createElement(Reader, { enabled: false, owner: 'one' }))
    assert.equal(wheelZoomReflow(viewport), undefined)
    await render(React.createElement(Reader, { enabled: true, owner: 'one' }))
    await begin()
    await render(React.createElement(Reader, { enabled: true, owner: 'two' }))
    assert.equal(wheelZoomReflow(viewport), undefined)
    await begin()
    await render(React.createElement('div'))
    assert.equal(wheelZoomReflow(viewport), undefined)
    assert.equal(viewport.style.getPropertyValue('overflow-anchor'), '')
  })
})
