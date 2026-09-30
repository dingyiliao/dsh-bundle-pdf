import React, { useLayoutEffect, useMemo, useState } from 'react'
import type { PdfPageInfo } from '../../core/pdf-types.js'
import { buildPageLayout, windowForViewport } from './page-layout.ts'
import { clearWindowLayout, pageIndexAtOffset, setWindowLayout } from './window-layout.ts'

export interface WindowedPagesProps {
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
  renderPage(page: PdfPageInfo, retainTextLayer: boolean): React.ReactNode
}

/** Numeric geometry is O(P); DOM, text layers and canvases contain only active pages. */
export function WindowedPages(props: WindowedPagesProps) {
  const { pages, scrollRoot, size, rotation, zoom, fit, scaleForPage } = props
  const layout = useMemo(() => buildPageLayout(pages, scaleForPage, rotation), [pages, scaleForPage, rotation, zoom, fit, size.width, size.height])
  const [position, setPosition] = useState(() => scrollRoot?.scrollTop ?? 0)
  useLayoutEffect(() => {
    if (!scrollRoot) return
    setWindowLayout(scrollRoot, layout)
    let frame = 0
    const update = () => { frame = 0; setPosition(scrollRoot.scrollTop) }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    scrollRoot.addEventListener('scroll', schedule, { passive: true }); schedule()
    return () => { clearWindowLayout(scrollRoot); scrollRoot.removeEventListener('scroll', schedule); cancelAnimationFrame(frame) }
  }, [scrollRoot, layout])
  const range = windowForViewport(layout, position, scrollRoot?.clientHeight || size.height)
  const active = new Set<number>()
  for (let index = range.start; index < range.end; index++) active.add(index)
  for (const page of props.pinnedPages ?? []) if (page >= 1 && page <= pages.length) active.add(page - 1)
  const visible = pageIndexAtOffset(layout, position + 40)
  if (props.dragAnchorPage) for (let index = Math.min(props.dragAnchorPage - 1, visible); index <= Math.max(props.dragAnchorPage - 1, visible); index++) active.add(index)
  const last = layout.at(-1)
  const totalWidth = layout.reduce((width, item) => Math.max(width, item.width + 32), size.width)
  return <div className="dsh-pdf-windowed-pages" data-windowed-page-count={active.size}
    style={{ position: 'relative', width: totalWidth, height: last ? last.top + last.outerHeight : 0, overflowAnchor: 'none' }}>
    {[...active].sort((a, b) => a - b).map(index => {
      const item = layout[index]
      if (!item) return null
      const retainText = !!props.selectedTextPages?.has(item.page) || !!props.dragAnchorPage && index >= Math.min(props.dragAnchorPage - 1, visible) && index <= Math.max(props.dragAnchorPage - 1, visible)
      return <div key={item.page} className="dsh-pdf-page-wrap dsh-pdf-windowed-page"
        data-page-number={item.page}
        style={{ position: 'absolute', top: item.top, left: 0, width: totalWidth, height: item.outerHeight }}>
        <div className="dsh-pdf-page-label" style={{ height: 27, boxSizing: 'border-box' }}>{props.t('reader.page')} {item.page}{props.hasOcrText(item.page) ? ` · ${props.t('reader.ocrText')}` : ''}</div>
        <div className="dsh-pdf-page-stage" style={{ width: item.width, height: item.height }}>
          {props.renderPage(pages[index], retainText)}
        </div>
      </div>
    })}
  </div>
}
