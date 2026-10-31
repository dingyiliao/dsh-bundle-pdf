import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { usePdfWheelZoom } from '../../../src/modules/viewer/controllers/use-pdf-wheel-zoom.js'
import { usePdfViewportSize } from '../../../src/modules/viewer/controllers/use-pdf-viewport-size.js'
import { readerPageScale } from '../../../src/modules/viewer/controllers/navigation-position.js'
import { WindowedPages } from '../../../src/modules/viewer/rendering/WindowedPages.js'
import { TileSurface } from '../../../src/modules/viewer/rendering/TileSurface.js'
import { windowLayout } from '../../../src/modules/viewer/rendering/window-layout.js'
import type { NativePage } from '../../../src/modules/viewer/rendering/document.js'
import type { PageView } from '../../../src/modules/viewer/model/reader-selection.js'
import { NativeViewport } from '../../../src/shared/geometry/native-viewport.js'
import type { PdfPageInfo } from '../../../src/core/pdf-types.js'

const uniformPages = Array.from({ length: 18 }, (_, index) => ({ page: index + 1,
  mediaBox: [0, 0, 400, 560] as [number, number, number, number], cropBox: [0, 0, 400, 560] as [number, number, number, number], rotation: 0, userUnit: 1 }))
const mixedPages = uniformPages.map((page, index) => index % 2 ? { ...page,
  mediaBox: [0, 0, 600, 440] as [number, number, number, number], cropBox: [0, 0, 600, 440] as [number, number, number, number] } : page)
let blocked = false, release: (() => void) | undefined
let gate = Promise.resolve()
const errors: string[] = []
const lifetime = new AbortController()
const makeModels = (pages: readonly PdfPageInfo[]) => pages.map(geometry => ({
  pageNumber: geometry.page, rotate: 0, owner: { lifetime },
  getViewport({ scale, rotation }: { scale: number; rotation: number }) { return new NativeViewport(geometry, scale, rotation) },
  async tile(request: { width: number; height: number; x: number; y: number; rasterWidth: number; rasterHeight: number }, signal: AbortSignal) {
    if (blocked) await gate
    signal.throwIfAborted()
    const canvas = new OffscreenCanvas(request.width, request.height)
    const context = canvas.getContext('2d')!
    context.fillStyle = '#527ac2'; context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#94b5ee'
    const step = request.rasterWidth / 8
    for (let x = Math.floor(request.x / step) * step; x < request.x + request.width; x += step)
      context.fillRect(x - request.x, 0, step / 2, canvas.height)
    context.fillStyle = '#233d70'
    const line = request.rasterHeight / 14
    for (let y = Math.floor(request.y / line) * line; y < request.y + request.height; y += line)
      context.fillRect(0, y - request.y, canvas.width, Math.max(1, line / 12))
    return createImageBitmap(canvas)
  },
}) as unknown as NativePage)
const uniformModels = makeModels(uniformPages), mixedModels = makeModels(mixedPages)

function Surface({ page, model, scale, views, root }: { page: number; model: NativePage; scale: number; views: Map<number, PageView>; root: HTMLElement | null }) {
  const element = useRef<HTMLDivElement>(null)
  const viewport = model.getViewport({ scale, rotation: 0 })
  useLayoutEffect(() => {
    if (element.current) views.set(page, { element: element.current, page: model, viewport })
    return () => { views.delete(page) }
  }, [page, model, scale, views])
  return <div ref={element} data-pdf-page={page} style={{ position: 'relative', width: viewport.width, height: viewport.height }}>
    <TileSurface page={model} viewport={viewport} scrollRoot={root} patchBoxes={[]} onReady={() => {}} onError={error => errors.push(error)} />
  </div>
}

function Fixture() {
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const [fit, setFit] = useState<'width' | 'custom'>('width')
  const [zoom, setZoom] = useState(1)
  const [mixed, setMixed] = useState(false)
  const pages = mixed ? mixedPages : uniformPages, models = mixed ? mixedModels : uniformModels
  const [size, setSize] = useState({ width: 900, height: 600, paddingLeft: 86, paddingRight: 330 })
  const views = useRef(new Map<number, PageView>())
  const scaleForPage = useCallback((page: PdfPageInfo) => readerPageScale(page, { fit, zoom, size }), [fit, zoom, size])
  const getScale = useCallback((page: number) => scaleForPage(pages[page - 1]!), [scaleForPage, pages])
  const onScale = useCallback((value: number) => { setFit('custom'); setZoom(value) }, [])
  usePdfViewportSize({ root, size, onSize: setSize })
  usePdfWheelZoom({ root, enabled: true, views: views.current, getScale, onScale, ownerKey: `zoom-test-document:${mixed}` })
  Object.assign(window, { __pdfWheelHandoff: {
    state: () => ({ fit, zoom, errors }),
    configure(value: { fit: 'width' | 'custom'; zoom: number; mixed?: boolean }) { setFit(value.fit); setZoom(value.zoom); setMixed(!!value.mixed) },
    layout: () => root ? windowLayout(root) : null,
    hold() { blocked = true; gate = new Promise<void>(resolve => { release = resolve }) },
    release() { blocked = false; release?.() },
  } })
  return <div className="dsh-pdf-reader"><div className="dsh-pdf-body">
    <div ref={setRoot} className="dsh-pdf-scroll" style={{ width: '100%', height: 600, paddingLeft: 86, paddingRight: 330, overflow: 'auto', boxSizing: 'border-box' }}>
      <WindowedPages key={String(mixed)} ownerKey={`zoom-test-document:${mixed}`} pages={pages} rotation={0} zoom={zoom} fit={fit} size={size} scrollRoot={root} scaleForPage={scaleForPage}
        preserveAnchor renderPage={page => <Surface key={page.page} page={page.page} model={models[page.page - 1]!} scale={getScale(page.page)} views={views.current} root={root} />} />
    </div>
  </div></div>
}

createRoot(document.getElementById('zoom-handoff-root')!).render(<Fixture />)
