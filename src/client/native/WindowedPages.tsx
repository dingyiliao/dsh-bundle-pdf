import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PdfPageInfo } from '../../core/pdf-types.js'
import { buildPageLayout, READING_TOP_INSET, readingPageProbe, windowForViewport, type PageGeometry } from './page-layout.ts'
import { clearWindowLayout, pageIndexAtOffset, setWindowLayout } from './window-layout.ts'

export interface WindowedPagesProps {
  pages: readonly PdfPageInfo[]
  rotation: number
  zoom: number
  fit: 'custom' | 'width' | 'page'
  size: { width: number; height: number }
  scrollRoot: HTMLElement | null
  scaleForPage(page: PdfPageInfo): number
  pinnedPages?: ReadonlySet<number>
  selectedTextPages?: ReadonlySet<number>
  dragAnchorPage?: number | null
  preserveAnchor: boolean
  renderPage(page: PdfPageInfo, retainTextLayer: boolean): React.ReactNode
}

/** Numeric geometry is O(P); DOM, text layers and canvases contain only active pages. */
export function WindowedPages(props: WindowedPagesProps) {
  const { pages, scrollRoot, size, rotation, zoom, fit, scaleForPage } = props
  const layout = useMemo(() => buildPageLayout(pages, scaleForPage, rotation, READING_TOP_INSET), [pages, scaleForPage, rotation, zoom, fit, size.width, size.height])
  const [position, setPosition] = useState(() => scrollRoot?.scrollTop ?? 0)
  const totalWidth = layout.reduce((width, item) => Math.max(width, item.width + 32), size.width)
  const previous = useRef<{ root: HTMLElement | null; layout: readonly PageGeometry[]; width: number; fit: WindowedPagesProps['fit']; size: { width: number; height: number } } | null>(null)
  // Read the old scroll offset before React replaces the old page dimensions.
  // On a large zoom-out the browser may clamp scrollTop during that replacement.
  const prior = previous.current
  // Automatic-fit viewport resizes have their own point-preserving anchor in
  // usePdfViewportSize. Running this center-based anchor too scrolls twice
  // during sidebar dragging. A fit-mode change resets that hook, so keep this
  // anchor for the mode transition even if the viewport changed concurrently.
  const viewportResized = prior && (Math.abs(prior.size.width - size.width) >= .25 || Math.abs(prior.size.height - size.height) >= .25)
  const viewportAnchorOwnsChange = viewportResized && fit !== 'custom' && prior?.fit === fit
  const anchor = props.preserveAnchor && !viewportAnchorOwnsChange && prior?.root === scrollRoot && prior.layout !== layout && scrollRoot && prior.layout.length && layout.length
    ? (() => {
      const viewportX = scrollRoot.clientWidth / 2, viewportY = scrollRoot.clientHeight / 2
      const oldX = scrollRoot.scrollLeft + viewportX, oldY = scrollRoot.scrollTop + viewportY
      const index = pageIndexAtOffset(prior.layout, oldY)
      const oldPage = prior.layout[index], newPage = layout[index]
      if (!oldPage || !newPage) return null
      const within = oldY - oldPage.top
      const newWithin = within <= 0 ? within : within >= oldPage.height
        ? newPage.height + within - oldPage.height
        : within * newPage.height / oldPage.height
      return {
        top: newPage.top + newWithin - viewportY,
        left: totalWidth / 2 + (oldX - prior.width / 2) * newPage.width / oldPage.width - viewportX,
      }
    })() : null
  useLayoutEffect(() => {
    previous.current = { root: scrollRoot, layout, width: totalWidth, fit, size: { width: size.width, height: size.height } }
    if (!scrollRoot) return
    setWindowLayout(scrollRoot, layout)
    if (anchor) {
      scrollRoot.scrollLeft = anchor.left
      scrollRoot.scrollTop = anchor.top
    }
    let frame = 0
    const update = () => { frame = 0; setPosition(scrollRoot.scrollTop) }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    // The active window must follow the new scroll offset before the first paint.
    setPosition(scrollRoot.scrollTop)
    scrollRoot.addEventListener('scroll', schedule, { passive: true }); schedule()
    scrollRoot.dispatchEvent(new Event('pdflayoutchange'))
    return () => { clearWindowLayout(scrollRoot); scrollRoot.removeEventListener('scroll', schedule); cancelAnimationFrame(frame) }
  }, [scrollRoot, layout, totalWidth, fit, size.width, size.height])
  const range = windowForViewport(layout, position, scrollRoot?.clientHeight || size.height)
  const active = new Set<number>()
  for (let index = range.start; index < range.end; index++) active.add(index)
  for (const page of props.pinnedPages ?? []) if (page >= 1 && page <= pages.length) active.add(page - 1)
  const visible = pageIndexAtOffset(layout, position + readingPageProbe(scrollRoot?.clientHeight || size.height))
  if (props.dragAnchorPage) for (let index = Math.min(props.dragAnchorPage - 1, visible); index <= Math.max(props.dragAnchorPage - 1, visible); index++) active.add(index)
  const last = layout.at(-1)
  return <div className="dsh-pdf-windowed-pages" data-windowed-page-count={active.size}
    style={{ position: 'relative', width: totalWidth, height: last ? last.top + last.outerHeight : 0, overflowAnchor: 'none' }}>
    {[...active].sort((a, b) => a - b).map(index => {
      const item = layout[index]
      if (!item) return null
      const retainText = !!props.selectedTextPages?.has(item.page) || !!props.dragAnchorPage && index >= Math.min(props.dragAnchorPage - 1, visible) && index <= Math.max(props.dragAnchorPage - 1, visible)
      return <div key={item.page} className="dsh-pdf-page-wrap dsh-pdf-windowed-page"
        data-page-number={item.page}
        style={{ position: 'absolute', top: item.top, left: 0, width: totalWidth, height: item.outerHeight }}>
        <div className="dsh-pdf-page-stage" style={{ width: item.width, height: item.height }}>
          {props.renderPage(pages[index], retainText)}
        </div>
      </div>
    })}
  </div>
}
