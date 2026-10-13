import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReaderDocument } from './reader-document.js'
import { useVirtualRows } from './use-virtual-rows.js'

const rowHeight = 218
const maximumWidth = 156
const maximumHeight = 168

function PageThumbnail({ pdf, pageNumber, t }: { pdf: ReaderDocument; pageNumber: number; t(key: string): string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    let render: ReturnType<Awaited<ReturnType<ReaderDocument['getPage']>>['render']> | undefined
    setFailed(false)
    void pdf.getPage(pageNumber).then(page => {
      if (cancelled || !canvas.current) return
      const natural = page.getViewport({ scale: 1 })
      const scale = Math.min(maximumWidth / natural.width, maximumHeight / natural.height)
      if (!(scale > 0) || !Number.isFinite(scale)) throw new Error('Invalid PDF thumbnail geometry')
      const viewport = page.getViewport({ scale })
      const node = canvas.current
      node.width = Math.max(1, Math.ceil(viewport.width))
      node.height = Math.max(1, Math.ceil(viewport.height))
      render = page.render({ canvas: node, viewport })
      return render.promise
    }).catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true; render?.cancel() }
  }, [pdf, pageNumber])

  return <span className="dsh-pdf-thumbnail-image">
    <canvas ref={canvas} aria-hidden="true" />
    {failed && <span className="dsh-pdf-thumbnail-error">{t('reader.sidebar.thumbnailUnavailable')}</span>}
  </span>
}

export function PageThumbnailPanel({ pdf, active, currentPage, onNavigatePage, t }: {
  pdf: ReaderDocument | null
  active: boolean
  currentPage: number
  onNavigatePage(page: number): void
  t(key: string): string
}) {
  const count = pdf?.numPages ?? 0
  const { root, start, end, scrollToRow, totalHeight } = useVirtualRows(count, rowHeight, active)
  const previousDocument = useRef<ReaderDocument | null>(null)

  useLayoutEffect(() => {
    if (!active || !pdf) return
    if (previousDocument.current !== pdf) {
      previousDocument.current = pdf
      scrollToRow(Math.max(0, currentPage - 1))
    } else scrollToRow(Math.max(0, currentPage - 1), true)
  }, [active, pdf, currentPage, scrollToRow])

  return <div className="dsh-pdf-thumbnail-panel">
    <div className="dsh-pdf-panel-heading"><h3>{t('reader.sidebar.pages')}</h3></div>
    {pdf ? <div ref={root} className="dsh-pdf-thumbnail-scroll" tabIndex={0} aria-label={t('reader.sidebar.pages')}>
      <div className="dsh-pdf-thumbnail-virtual" style={{ height: totalHeight }}>
        {Array.from({ length: end - start }, (_, offset) => {
          const page = start + offset + 1
          return <button key={page} type="button" className={`dsh-pdf-thumbnail-row${page === currentPage ? ' is-current' : ''}`}
            style={{ top: (page - 1) * rowHeight, height: rowHeight }} aria-current={page === currentPage ? 'page' : undefined}
            aria-label={`${t('reader.page')} ${page} / ${count}`} onClick={() => onNavigatePage(page)}>
            <PageThumbnail pdf={pdf} pageNumber={page} t={t} />
            <span className="dsh-pdf-thumbnail-number">{page}</span>
          </button>
        })}
      </div>
    </div> : <p className="dsh-pdf-sidebar-empty">{t('reader.loading')}</p>}
  </div>
}
