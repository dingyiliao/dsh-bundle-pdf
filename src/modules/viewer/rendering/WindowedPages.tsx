import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PdfPageInfo } from '../../../core/pdf-types.js'
import { buildPageLayout, READING_TOP_INSET, readingPageProbe, windowForViewport, type PageGeometry } from './page-layout.ts'
import { clearWindowLayout, pageIndexAtOffset, setWindowLayout, wheelZoomPosition, wheelZoomReflow } from './window-layout.ts'
import type { PdfViewportSize } from '../controllers/use-pdf-viewport-size.js'

export interface WindowedPagesProps {
  /** Same document/content identity as the paired wheel-zoom controller. */
  ownerKey?: unknown
  pages: readonly PdfPageInfo[]
  rotation: number
  zoom: number
  fit: 'custom' | 'width' | 'page'
  size: PdfViewportSize
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
  const paddingLeft = size.paddingLeft ?? 16, paddingRight = size.paddingRight ?? 16
  const dimensions = useMemo(() => buildPageLayout(pages, scaleForPage, rotation, READING_TOP_INSET),
    [pages, scaleForPage, rotation, zoom, fit, size.width, size.height, paddingLeft, paddingRight])
  const totalWidth = dimensions.reduce((width, item) => Math.max(width, item.width), Math.max(0, size.width - paddingLeft - paddingRight))
  const layout = useMemo(() => dimensions.map(item => ({ ...item, left: paddingLeft + (totalWidth - item.width) / 2 })),
    [dimensions, totalWidth, paddingLeft])
  const [position, setPosition] = useState(() => scrollRoot?.scrollTop ?? 0)
  const previous = useRef<{ root: HTMLElement | null; layout: readonly PageGeometry[]; rotation: number; fit: WindowedPagesProps['fit']; size: PdfViewportSize } | null>(null)
  // Read the old scroll offset before React replaces the old page dimensions.
  // On a large zoom-out the browser may clamp scrollTop during that replacement.
  const prior = previous.current
  // Numeric layouts survive virtual page unmounts. One owner preserves the
  // reading point at the content inset during automatic fit resizes; ordinary
  // zoom and fit-mode changes retain the viewport's center instead.
  const viewportResized = prior && (Math.abs(prior.size.width - size.width) >= .25 || Math.abs(prior.size.height - size.height) >= .25)
  const paddingResized = prior && ((prior.size.paddingLeft ?? 16) !== paddingLeft || (prior.size.paddingRight ?? 16) !== paddingRight)
  const automaticResize = prior?.fit === fit && (paddingResized || viewportResized && fit !== 'custom')
  const pendingZoom = scrollRoot ? wheelZoomReflow(scrollRoot) : undefined
  const zoomOwner = pendingZoom && props.preserveAnchor && Object.is(pendingZoom.ownerKey, props.ownerKey)
    && prior?.root === scrollRoot && prior.layout === pendingZoom.source && prior.rotation === rotation
  const zoomPage = pendingZoom && layout[pendingZoom.page - 1]
  const gesture = zoomOwner && zoomPage && Math.abs(zoomPage.scale - pendingZoom!.scale) < .000001 ? pendingZoom : undefined
  const zoomAnchor = gesture && zoomPage ? wheelZoomPosition({ ...zoomPage, left: zoomPage.left! }, gesture,
    { width: totalWidth + paddingLeft + paddingRight, height: layout.at(-1)!.top + layout.at(-1)!.outerHeight }, size) : undefined
  const anchor = zoomAnchor ?? (props.preserveAnchor && prior?.root === scrollRoot && prior.layout !== layout && scrollRoot && prior.layout.length && layout.length
    ? (() => {
      const viewportX = automaticResize ? Math.min(paddingLeft, size.width / 2) : scrollRoot.clientWidth / 2
      const viewportY = automaticResize ? readingPageProbe(size.height) : scrollRoot.clientHeight / 2
      const oldX = scrollRoot.scrollLeft + (automaticResize ? Math.min(prior.size.paddingLeft ?? 16, prior.size.width / 2) : viewportX)
      const oldY = scrollRoot.scrollTop + (automaticResize ? readingPageProbe(prior.size.height) : viewportY)
      const index = pageIndexAtOffset(prior.layout, oldY)
      const oldPage = prior.layout[index], newPage = layout[index]
      if (!oldPage || !newPage) return null
      const within = oldY - oldPage.top
      const newWithin = within <= 0 ? within : within >= oldPage.height
        ? newPage.height + within - oldPage.height
        : within * newPage.height / oldPage.height
      return {
        top: newPage.top + newWithin - viewportY,
        left: Math.max(0, Math.min(totalWidth + paddingLeft + paddingRight - size.width,
          newPage.left + (oldX - oldPage.left!) * newPage.width / oldPage.width - viewportX)),
      }
    })() : null)
  useLayoutEffect(() => {
    previous.current = { root: scrollRoot, layout, rotation, fit, size: { ...size } }
    if (!scrollRoot) return
    // Parent hook cleanup is passive. Reject an old document/rotation lease
    // here, before this new layout could consume its scroll or completion.
    if (pendingZoom && !zoomOwner) pendingZoom.cancel()
    setWindowLayout(scrollRoot, layout)
    if (zoomAnchor) gesture!.prepare()
    if (anchor) {
      scrollRoot.scrollLeft = anchor.left
      scrollRoot.scrollTop = anchor.top
    }
    if (zoomAnchor) gesture!.complete()
    let frame = 0
    const update = () => { frame = 0; setPosition(scrollRoot.scrollTop) }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    // The active window must follow the new scroll offset before the first paint.
    setPosition(scrollRoot.scrollTop)
    scrollRoot.addEventListener('scroll', schedule, { passive: true }); schedule()
    scrollRoot.dispatchEvent(new Event('pdflayoutchange'))
    return () => { clearWindowLayout(scrollRoot); scrollRoot.removeEventListener('scroll', schedule); cancelAnimationFrame(frame) }
  }, [scrollRoot, layout, totalWidth, fit, size.width, size.height, paddingLeft, paddingRight, props.ownerKey, rotation])
  // Choose the new virtual window before React removes old PageViews. Otherwise
  // a distant pointer page disappears before its gesture can restore the anchor.
  const windowPosition = zoomAnchor?.top ?? position
  const range = windowForViewport(layout, windowPosition, scrollRoot?.clientHeight || size.height)
  const active = new Set<number>()
  for (let index = range.start; index < range.end; index++) active.add(index)
  for (const page of props.pinnedPages ?? []) if (page >= 1 && page <= pages.length) active.add(page - 1)
  const visible = pageIndexAtOffset(layout, windowPosition + readingPageProbe(scrollRoot?.clientHeight || size.height))
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
