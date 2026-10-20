import React, { useEffect, useMemo, useRef, useState } from 'react'
import { currentOutlineKey, outlineAncestorKeys } from '../model/bookmark-current.js'
import type { ReaderDocument, ReaderOutlineItem } from '../ports/reader-document.js'
import { safeLinkUrl } from '../model/reader-links.js'
import { useVirtualRows } from '../controllers/use-virtual-rows.js'
import { PersonalBookmarks, type BookmarkAccess } from './PersonalBookmarks.js'

export type { BookmarkAccess } from './PersonalBookmarks.js'

interface OutlineRow { key: string; depth: number; item: ReaderOutlineItem; children: boolean }
const rowHeight = 36
const destinationKinds = new Set(['XYZ', 'Fit', 'FitB', 'FitH', 'FitBH', 'FitV', 'FitBV', 'FitR'])

function OutlineEntry({ pdf, row, index, expanded, current, toggle, onNavigateDestination, t }: {
  pdf: ReaderDocument
  row: OutlineRow
  index: number
  expanded: boolean
  current: boolean
  toggle(key: string): void
  onNavigateDestination(destination: unknown): void
  t(key: string): string
}) {
  const href = safeLinkUrl(row.item.url ?? undefined)
  const [target, setTarget] = useState<{ valid: boolean; reason?: string }>()
  useEffect(() => {
    if (row.item.dest === undefined || row.item.dest === null) return
    let cancelled = false
    const resolve = async () => {
      const value = typeof row.item.dest === 'string' ? await pdf.getDestination(row.item.dest) : row.item.dest
      if (!Array.isArray(value) || value.length < 2 || !destinationKinds.has(value[1]?.name)) throw new Error(t('reader.sidebar.bookmarkUnavailable'))
      const page = typeof value[0] === 'number' ? value[0] : await pdf.getPageIndex(value[0] as Parameters<ReaderDocument['getPageIndex']>[0])
      if (!Number.isInteger(page) || page < 0 || page >= pdf.numPages) throw new Error(t('reader.sidebar.bookmarkUnavailable'))
      if (!cancelled) setTarget({ valid: true })
    }
    void resolve().catch(cause => {
      if (!cancelled) setTarget({ valid: false, reason: cause instanceof Error ? cause.message : t('reader.sidebar.bookmarkUnavailable') })
    })
    return () => { cancelled = true }
  }, [pdf, row.item.dest, t])

  const title = row.item.title || t('reader.sidebar.untitledBookmark')
  const content = <span className="dsh-pdf-bookmark-title" title={target?.reason ?? title}>{title}</span>
  return <div className={`dsh-pdf-bookmark-row${current ? ' is-current' : ''}`} role="treeitem" aria-level={row.depth}
    aria-current={current ? 'location' : undefined}
    aria-expanded={row.children ? expanded : undefined}
    style={{ top: index * rowHeight, height: rowHeight, paddingLeft: Math.min(18 + (row.depth - 1) * 14, 116) }}>
    {row.children ? <button type="button" className="dsh-pdf-bookmark-toggle"
      aria-label={t(expanded ? 'reader.sidebar.collapseBookmark' : 'reader.sidebar.expandBookmark')}
      aria-expanded={expanded} onClick={() => toggle(row.key)}>
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="m6 4 4 4-4 4" />
      </svg>
    </button>
      : <span className="dsh-pdf-bookmark-spacer" />}
    {row.item.dest !== undefined && row.item.dest !== null
      ? <button type="button" className="dsh-pdf-bookmark-link" disabled={!target?.valid}
        title={target?.reason ?? title} onClick={() => onNavigateDestination(row.item.dest)}>{content}</button>
      : href ? <a className="dsh-pdf-bookmark-link" href={href} target="_blank" rel="noopener noreferrer">{content}</a>
        : <span className="dsh-pdf-bookmark-label" title={row.children ? title : t('reader.sidebar.bookmarkUnavailable')}>{content}</span>}
    {target?.valid === false && <span className="dsh-pdf-bookmark-unavailable" title={target.reason}>{t('reader.sidebar.bookmarkUnavailable')}</span>}
    {!row.children && !href && (row.item.dest === undefined || row.item.dest === null)
      && <span className="dsh-pdf-bookmark-unavailable">{t('reader.sidebar.bookmarkUnavailable')}</span>}
  </div>
}

function visibleRows(items: readonly ReaderOutlineItem[], expanded: ReadonlySet<string>): OutlineRow[] {
  const result: OutlineRow[] = []
  const stack = items.map((item, index) => ({ item, key: String(index), depth: 1 })).reverse()
  while (stack.length) {
    const next = stack.pop()!
    const children = next.item.items.length > 0
    result.push({ ...next, children })
    if (children && expanded.has(next.key)) {
      for (let index = next.item.items.length - 1; index >= 0; index--) {
        stack.push({ item: next.item.items[index]!, key: `${next.key}/${index}`, depth: next.depth + 1 })
      }
    }
  }
  return result
}

export function BookmarkPanel({ pdf, active, currentPage, bookmarks, onNavigateDestination, t }: {
  pdf: ReaderDocument | null
  active: boolean
  currentPage: number
  bookmarks?: BookmarkAccess
  onNavigateDestination(destination: unknown): void
  t(key: string): string
}) {
  const [loaded, setLoaded] = useState<{ pdf: ReaderDocument; items: ReaderOutlineItem[] | null; error?: string }>()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const revealed = useRef(false)
  const pendingReveal = useRef<string>()
  const outline = loaded?.pdf === pdf ? loaded : undefined
  const rows = useMemo(() => visibleRows(outline?.items ?? [], expanded), [outline, expanded])
  const currentKey = useMemo(() => currentOutlineKey(outline?.items ?? [], currentPage, pdf?.numPages ?? 0),
    [outline?.items, currentPage, pdf?.numPages])
  const { root, start, end, scrollToRow, totalHeight } = useVirtualRows(rows.length, rowHeight, active)

  useEffect(() => {
    setExpanded(new Set())
    setLoaded(undefined)
    revealed.current = false
    pendingReveal.current = undefined
  }, [pdf])
  useEffect(() => {
    if (!active || !pdf || loaded?.pdf === pdf) return
    let cancelled = false
    void pdf.getOutline().then(items => {
      if (!cancelled) setLoaded({ pdf, items })
    }).catch(error => {
      if (!cancelled) setLoaded({ pdf, items: null, error: error instanceof Error ? error.message : String(error) })
    })
    return () => { cancelled = true }
  }, [active, pdf, loaded])

  useEffect(() => {
    if (!active) { revealed.current = false; pendingReveal.current = undefined; return }
    if (!outline?.items || revealed.current) return
    revealed.current = true
    if (!currentKey) return
    pendingReveal.current = currentKey
    const ancestors = outlineAncestorKeys(currentKey)
    if (ancestors.length) setExpanded(previous => new Set([...previous, ...ancestors]))
  }, [active, outline?.items, currentKey])

  useEffect(() => {
    const key = pendingReveal.current
    if (!active || !key) return
    const index = rows.findIndex(row => row.key === key)
    if (index < 0) return
    scrollToRow(index, true)
    pendingReveal.current = undefined
  }, [active, rows, scrollToRow])

  const toggle = (key: string) => setExpanded(previous => {
    const next = new Set(previous)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  return <div className="dsh-pdf-bookmark-panel">
    <div className="dsh-pdf-panel-heading"><h3>{t('reader.sidebar.bookmarks')}</h3></div>
    <PersonalBookmarks access={bookmarks} document={pdf} active={active} t={t} />
    <div className="dsh-pdf-bookmark-section-heading dsh-pdf-bookmark-native-heading"><h4>{t('reader.sidebar.pdfBookmarks')}</h4></div>
    {!pdf ? <p className="dsh-pdf-sidebar-empty">{t('reader.loading')}</p>
      : !outline ? <p className="dsh-pdf-sidebar-empty" role="status">{t('reader.sidebar.bookmarksLoading')}</p>
        : outline.error ? <div className="dsh-pdf-sidebar-empty" role="alert">{t('reader.sidebar.bookmarksError')}: {outline.error}
          <button type="button" onClick={() => setLoaded(undefined)}>{t('reader.sidebar.retryBookmarks')}</button>
        </div>
          : !rows.length ? <p className="dsh-pdf-sidebar-empty">{t('reader.sidebar.bookmarksEmpty')}</p>
            : <div ref={root} className="dsh-pdf-bookmark-scroll" role="tree" tabIndex={0} aria-label={t('reader.sidebar.bookmarks')}>
              <div className="dsh-pdf-bookmark-virtual" style={{ height: totalHeight }}>
                {rows.slice(start, end).map((row, offset) => <OutlineEntry key={row.key} pdf={pdf} row={row}
                  index={start + offset} expanded={expanded.has(row.key)} current={row.key === currentKey} toggle={toggle}
                  onNavigateDestination={onNavigateDestination} t={t} />)}
              </div>
            </div>}
  </div>
}
