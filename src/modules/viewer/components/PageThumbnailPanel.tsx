import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReaderDocument } from '../ports/reader-document.js'
import { useVirtualRows } from '../controllers/use-virtual-rows.js'
import { ScrollablePanel } from './ScrollablePanel.js'

const rowHeight = 190
const maximumWidth = 108
const maximumHeight = 144
const twoColumnMinimumWidth = 268

export function thumbnailColumnCount(width: number): 1 | 2 {
  return width >= twoColumnMinimumWidth ? 2 : 1
}

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
      const renderViewport = page.getViewport({ scale: scale * Math.min(window.devicePixelRatio || 1, 2) })
      const node = canvas.current
      node.width = Math.max(1, Math.ceil(renderViewport.width))
      node.height = Math.max(1, Math.ceil(renderViewport.height))
      node.style.width = `${viewport.width}px`
      node.style.height = `${viewport.height}px`
      render = page.render({ canvas: node, viewport: renderViewport })
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
  const [columns, setColumns] = useState(2)
  const rowCount = Math.ceil(count / columns)
  const { root, start, end, scrollToRow, totalHeight } = useVirtualRows(rowCount, rowHeight, active, 1)
  const previousDocument = useRef<ReaderDocument | null>(null)

  useLayoutEffect(() => {
    const element = root.current
    if (!active || !element) return
    const update = () => { setColumns(thumbnailColumnCount(element.clientWidth)) }
    const observer = new ResizeObserver(update)
    observer.observe(element)
    update()
    return () => { observer.disconnect() }
  }, [active, root])

  useLayoutEffect(() => {
    if (!active || !pdf) return
    const currentRow = Math.floor((currentPage - 1) / columns)
    if (previousDocument.current !== pdf) {
      previousDocument.current = pdf
      scrollToRow(Math.max(0, currentRow))
    } else scrollToRow(Math.max(0, currentRow), true)
  }, [active, pdf, currentPage, columns, scrollToRow])

  return <ScrollablePanel ref={root} className="dsh-pdf-thumbnail-panel" title={t('reader.sidebar.pages')}
    verticalLabel={t('reader.verticalScroll')} horizontalLabel={t('reader.horizontalScroll')}
    scrollProps={{ className: 'dsh-pdf-thumbnail-scroll', 'aria-label': t('reader.sidebar.pages') }}>
    {pdf ? <>
      <div className="dsh-pdf-thumbnail-virtual" style={{ height: totalHeight }}>
        {Array.from({ length: end - start }, (_, offset) => {
          const row = start + offset
          return <div key={row} className={`dsh-pdf-thumbnail-grid-row${columns === 1 ? ' is-single' : ''}`}
            style={{ top: row * rowHeight, height: rowHeight }}>
            {Array.from({ length: Math.min(columns, count - row * columns) }, (_, column) => {
              const page = row * columns + column + 1
              return <button key={page} type="button" className={`dsh-pdf-thumbnail-tile${page === currentPage ? ' is-current' : ''}`}
                aria-current={page === currentPage ? 'page' : undefined}
                aria-label={`${t('reader.page')} ${page} / ${count}`} onClick={() => onNavigatePage(page)}>
                <PageThumbnail pdf={pdf} pageNumber={page} t={t} />
                <span className="dsh-pdf-thumbnail-number">{page}</span>
              </button>
            })}
          </div>
        })}
      </div>
    </> : <p className="dsh-pdf-sidebar-empty">{t('reader.loading')}</p>}
  </ScrollablePanel>
}
