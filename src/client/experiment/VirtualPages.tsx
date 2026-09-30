import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { PdfPageInfo } from '../../core/pdf-types.js'
import { buildPageLayout, windowForViewport, type VirtualPageWindow } from './virtual-page-layout.js'

interface MountedWindow extends VirtualPageWindow { visible: number }

function firstPageEndingAfter(root: HTMLElement, offset: number): number {
  let low = 0, high = root.children.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const element = root.children[middle] as HTMLElement
    if (element.offsetTop + element.offsetHeight <= offset) low = middle + 1
    else high = middle
  }
  return low
}

function windowForRoot(root: HTMLElement, fallbackHeight: number): MountedWindow {
  const count = root.children.length
  if (!count) return { start: 0, end: 0, visible: 0 }
  const height = Math.max(1, root.clientHeight || fallbackHeight)
  const top = Math.max(0, root.scrollTop)
  const start = Math.min(count - 1, firstPageEndingAfter(root, top - height))
  const end = Math.max(start + 1, Math.min(count, firstPageEndingAfter(root, top + height * 2) + 1))
  const visible = Math.min(count - 1, firstPageEndingAfter(root, top + 40))
  return { start, end, visible }
}

export interface VirtualPagesProps {
  pages: readonly PdfPageInfo[]
  rotation: number
  zoom: number
  fit: 'custom' | 'width' | 'page'
  size: { width: number; height: number }
  scrollRoot: HTMLElement | null
  t(key: string): string
  scaleForPage(page: PdfPageInfo): number
  hasOcrText(page: number): boolean
  pinnedPages?: ReadonlySet<number>
  selectedTextPages?: ReadonlySet<number>
  dragAnchorPage?: number | null
  previewForPage?(page: number): string | undefined
  subscribePreviews(listener: () => void): () => void
  renderPage(page: PdfPageInfo, retainTextLayer: boolean): React.ReactNode
}

function VirtualPreview({ page, previewForPage, subscribePreviews }: {
  page: number
  previewForPage: (page: number) => string | undefined
  subscribePreviews(listener: () => void): () => void
}) {
  const url = useSyncExternalStore(subscribePreviews, () => previewForPage(page), () => undefined)
  return url ? <div className="dsh-pdf-virtual-preview" aria-hidden="true">
    <img src={url} alt="" draggable={false} />
  </div> : null
}

/** Retain the scroll geometry of every page while mounting PDF.js pages near the viewport. */
export function VirtualPages({ pages, rotation, zoom, fit, size, scrollRoot, t, scaleForPage,
  hasOcrText, pinnedPages, selectedTextPages, dragAnchorPage, previewForPage,
  subscribePreviews, renderPage }: VirtualPagesProps) {
  // pageScale reads Reader's current size, fit, and zoom through a stable callback.
  const layout = useMemo(() => buildPageLayout(pages, scaleForPage, rotation),
    [pages, scaleForPage, rotation, zoom, fit, size.width, size.height])
  const [range, setRange] = useState<MountedWindow>(() => ({
    ...windowForViewport(layout, scrollRoot?.scrollTop ?? 0, scrollRoot?.clientHeight || size.height), visible: 0,
  }))
  const dragAnchorIndex = useMemo(() => dragAnchorPage === null || dragAnchorPage === undefined
    ? -1 : pages.findIndex(page => page.page === dragAnchorPage), [pages, dragAnchorPage])

  useEffect(() => {
    if (!scrollRoot) return
    let frame = 0
    const update = () => {
      frame = 0
      // The DOM holds the browser's exact label line box and rounded offsets.
      const next = windowForRoot(scrollRoot, size.height)
      setRange((previous) => previous.start === next.start && previous.end === next.end && previous.visible === next.visible
        ? previous : next)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    scrollRoot.addEventListener('scroll', schedule, { passive: true })
    // Run after Reader's layout effects restore zoom or resize anchors.
    schedule()
    return () => { scrollRoot.removeEventListener('scroll', schedule); cancelAnimationFrame(frame) }
  }, [scrollRoot, layout, size.height])

  const start = Math.min(range.start, Math.max(0, pages.length - 1))
  const end = Math.min(pages.length, Math.max(range.end, start + 1))
  return <>{layout.map((geometry, index) => {
    const inDragSpan = dragAnchorIndex >= 0 && index >= Math.min(dragAnchorIndex, range.visible)
      && index <= Math.max(dragAnchorIndex, range.visible)
    const inWindow = index >= start && index < end
    const active = inWindow || !!pinnedPages?.has(geometry.page) || inDragSpan
    const retainTextLayer = !!selectedTextPages?.has(geometry.page) || inDragSpan
    return <div key={geometry.page} className="dsh-pdf-page-wrap dsh-pdf-virtual-page"
      data-page-number={geometry.page} data-virtual-page-active={active ? 'true' : undefined}
      >
      <div className="dsh-pdf-page-label">{t('reader.page')} {geometry.page}{hasOcrText(geometry.page) ? ` · ${t('reader.ocrText')}` : ''}</div>
      <div className="dsh-pdf-virtual-stage" style={{ width: geometry.width, height: geometry.height }}>
        {active && renderPage(pages[index]!, retainTextLayer)}
        {inWindow && previewForPage && <VirtualPreview page={geometry.page}
          previewForPage={previewForPage} subscribePreviews={subscribePreviews} />}
      </div>
    </div>
  })}</>
}
