import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PdfAnnotation } from '../../../core/pdf-types.js'
import type { NativeTextContent } from '../../../shared/native.js'
import { colorToHex } from '../model/reader-selection.js'
import { formatAnnotationListDate } from '../model/reader-dates.js'
import { annotationExcerpt } from '../../../shared/annotation-excerpt.js'
import type { NativeDocument } from '../rendering/document.js'
import { isStandaloneNote } from '../model/annotation-thread.js'
import { ToolbarIcon } from './ToolbarIcon.js'
import { ScrollablePanel } from './ScrollablePanel.js'

type AnnotationFilter = 'all' | 'Highlight' | 'Underline' | 'StrikeOut' | 'Text'
const filters: readonly AnnotationFilter[] = ['all', 'Highlight', 'Underline', 'StrikeOut', 'Text']
// Stable row geometry lets the existing panel scroll (and its overlay scrollbar)
// cover thousands of annotations without mounting thousands of buttons.
const headingHeight = 29
const rowHeight = 76
const groupFooterHeight = 8
const overscan = rowHeight * 3
const maxCachedExcerpts = 2048
const textAnnotations = new Set(['Highlight', 'Underline', 'StrikeOut'])
type CachedExcerpt = { annotation: PdfAnnotation; text: string | null }
type TextRequest = { controller: AbortController; promise: Promise<NativeTextContent>; consumers: number }
type TextLease = { promise: Promise<NativeTextContent>; release: () => void }

interface Props {
  annotations: readonly PdfAnnotation[]
  selectedId?: string
  pdf: NativeDocument | null
  details?: React.ReactNode
  onSelect: (annotation: PdfAnnotation) => void
  onDeselect: () => void
  t: (key: string) => string
}

interface PageGroup {
  page: number
  annotations: readonly PdfAnnotation[]
  top: number
  height: number
  firstIndex: number
}

function annotationLayout(annotations: readonly PdfAnnotation[], filter: AnnotationFilter) {
  const byPage = new Map<number, PdfAnnotation[]>()
  for (const annotation of annotations) {
    if (filter !== 'all' && annotation.subtype !== filter) continue
    const items = byPage.get(annotation.page) ?? []
    items.push(annotation)
    byPage.set(annotation.page, items)
  }
  const groups: PageGroup[] = []
  const rows: PdfAnnotation[] = []
  const positions: number[] = []
  let top = 0
  for (const [page, items] of [...byPage].sort(([a], [b]) => a - b)) {
    groups.push({ page, annotations: items, top, height: headingHeight + items.length * rowHeight + groupFooterHeight,
      firstIndex: rows.length })
    for (let index = 0; index < items.length; index++) {
      rows.push(items[index]!)
      positions.push(top + headingHeight + index * rowHeight)
    }
    top += headingHeight + items.length * rowHeight + groupFooterHeight
  }
  return { groups, rows, positions, height: top }
}

function AnnotationPageGroup({ group, first, end, pinned, totalRows, selectedId, pdf, getText, cachedExcerpts, onSelect, t }: {
  group: PageGroup
  first: number
  end: number
  pinned?: number
  totalRows: number
  selectedId?: string
  pdf: NativeDocument | null
  getText: (pdf: NativeDocument, page: number) => TextLease
  cachedExcerpts: Map<string, CachedExcerpt>
  onSelect: Props['onSelect']
  t: Props['t']
}) {
  const indices = useMemo(() => {
    const result = Array.from({ length: end - first }, (_, offset) => first + offset)
    if (pinned !== undefined && (pinned < first || pinned >= end)) result.push(pinned)
    return result
  }, [first, end, pinned])
  const visible = useMemo(() => indices.map(index => group.annotations[index]!), [group.annotations, indices])
  const needsText = visible.some(annotation => textAnnotations.has(annotation.subtype)
    && cachedExcerpts.get(annotation.id)?.annotation !== annotation)
  const [loaded, setLoaded] = useState<{ pdf: NativeDocument; content: NativeTextContent }>()
  const content = loaded?.pdf === pdf ? loaded.content : undefined

  useEffect(() => {
    if (!pdf || !needsText || content) return
    let mounted = true
    const { promise, release } = getText(pdf, group.page)
    void promise.then(value => {
      if (mounted) setLoaded({ pdf, content: value })
    }).catch(() => undefined) // Previews are optional; the annotations remain usable.
    return () => { mounted = false; release() }
  }, [pdf, needsText, content, getText, group.page])

  const excerpts = useMemo(() => {
    const result = new Map<string, string>()
    if (content) for (const annotation of visible) {
      const excerpt = annotationExcerpt(annotation, content)
      if (excerpt) result.set(annotation.id, excerpt)
    }
    return result
  }, [content, visible])
  useEffect(() => {
    for (const annotation of visible) {
      if (!textAnnotations.has(annotation.subtype)) continue
      const previous = cachedExcerpts.get(annotation.id)
      if (!content && previous?.annotation !== annotation) continue
      // Refresh insertion order so recently revisited previews survive eviction.
      cachedExcerpts.delete(annotation.id)
      cachedExcerpts.set(annotation.id, previous?.annotation === annotation ? previous
        : { annotation, text: excerpts.get(annotation.id) ?? null })
      if (cachedExcerpts.size > maxCachedExcerpts) cachedExcerpts.delete(cachedExcerpts.keys().next().value!)
    }
  }, [visible, content, excerpts, cachedExcerpts])

  return <div className="dsh-pdf-annotation-group" role="group"
    aria-label={`${t('reader.annotationPagePrefix')}${group.page}${t('reader.annotationPageSuffix')}`}
    style={{ top: group.top, height: group.height }}>
    <h4 className="dsh-pdf-annotation-page">{t('reader.annotationPagePrefix')}{group.page}{t('reader.annotationPageSuffix')}</h4>
    {visible.map((annotation, offset) => {
      const index = indices[offset]!
      const type = annotation.supported ? t(`reader.type.${annotation.subtype}`) : annotation.subtype
      const cached = cachedExcerpts.get(annotation.id)
      const excerpt = excerpts.get(annotation.id) ?? (cached?.annotation === annotation ? cached.text ?? undefined : undefined)
      const comment = annotation.contents?.trim()
      const primary = excerpt ?? comment ?? type
      const date = annotation.modifiedAt ?? annotation.createdAt
      const formattedDate = date ? formatAnnotationListDate(date) : undefined
      return <div key={annotation.id} className="dsh-pdf-annotation-row" role="listitem"
        aria-posinset={group.firstIndex + index + 1} aria-setsize={totalRows}
        style={{ top: headingHeight + index * rowHeight, height: rowHeight }}>
        <button type="button" data-annotation-index={group.firstIndex + index}
          className={`dsh-pdf-comment-item${selectedId === annotation.id ? ' is-selected' : ''}`}
          aria-pressed={selectedId === annotation.id} onClick={() => onSelect(annotation)}>
          {isStandaloneNote(annotation)
            ? <span className="dsh-pdf-comment-note-icon" aria-hidden="true"><ToolbarIcon name="note" /></span>
            : <span className="dsh-pdf-comment-color" style={{ backgroundColor: colorToHex(annotation.color) }} aria-hidden="true" />}
          <span className="dsh-pdf-comment-content">
            <span className="dsh-pdf-comment-preview" title={primary}>{primary}</span>
            {excerpt && comment && <span className="dsh-pdf-comment-note" title={comment}>{comment}</span>}
            {(primary !== type || formattedDate) && <span className="dsh-pdf-comment-meta">
              {primary !== type && <span>{type}</span>}
              {formattedDate && <time>{formattedDate}</time>}
            </span>}
          </span>
        </button>
      </div>
    })}
  </div>
}

export function AnnotationList({ annotations, selectedId, pdf, details, onSelect, onDeselect, t }: Props) {
  const [filter, setFilter] = useState<AnnotationFilter>('all')
  const layout = useMemo(() => annotationLayout(annotations, filter), [annotations, filter])
  const list = useRef<HTMLDivElement>(null)
  const focusPending = useRef<number | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const focusedIndex = focusedId === null ? -1 : layout.rows.findIndex(annotation => annotation.id === focusedId)
  const textRequests = useRef(new WeakMap<NativeDocument, Map<number, TextRequest>>())
  const cachedExcerpts = useMemo(() => new Map<string, CachedExcerpt>(), [pdf])
  const [viewport, setViewport] = useState({ top: 0, height: 480 })

  useEffect(() => {
    if (!cachedExcerpts.size) return
    const current = new Map(annotations.map(annotation => [annotation.id, annotation]))
    for (const [id, entry] of cachedExcerpts) if (current.get(id) !== entry.annotation) cachedExcerpts.delete(id)
  }, [annotations, cachedExcerpts])

  const getText = useCallback((document: NativeDocument, page: number) => {
    let requests = textRequests.current.get(document)
    if (!requests) { requests = new Map(); textRequests.current.set(document, requests) }
    let request = requests.get(page)
    if (!request) {
      const controller = new AbortController()
      request = { controller, promise: document.text(page, controller.signal), consumers: 0 }
      requests.set(page, request)
      const current = requests
      const pending = request
      void pending.promise.then(() => { if (current.get(page) === pending) current.delete(page) },
        () => { if (current.get(page) === pending) current.delete(page) })
    }
    request.consumers++
    let released = false
    return { promise: request.promise, release: () => {
      if (released) return
      released = true
      if (--request.consumers === 0 && requests.get(page) === request) {
        requests.delete(page)
        request.controller.abort()
      }
    } }
  }, [])

  const measure = useCallback(() => {
    const element = list.current
    const scroll = element?.closest<HTMLElement>('.dsh-pdf-panel-scroll')
    if (!element || !scroll) return
    const top = scroll.getBoundingClientRect().top - element.getBoundingClientRect().top
    const height = scroll.clientHeight
    setViewport(previous => Math.abs(previous.top - top) < 1 && previous.height === height ? previous : { top, height })
  }, [])

  useEffect(() => {
    const element = list.current
    const scroll = element?.closest<HTMLElement>('.dsh-pdf-panel-scroll')
    if (!element || !scroll) return
    let frame = 0
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure() }) }
    const observer = new ResizeObserver(schedule)
    const watched = new Set<Element>()
    const observeLayout = () => {
      const next = new Set<Element>([scroll, element])
      // The selected annotation editor precedes this list. Resizing its textarea
      // moves the list without changing the list's own dimensions.
      for (let node: Element | null = element; node && node !== scroll; node = node.parentElement) {
        for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) next.add(sibling)
      }
      for (const old of watched) if (!next.has(old)) observer.unobserve(old)
      for (const item of next) if (!watched.has(item)) observer.observe(item)
      watched.clear()
      for (const item of next) watched.add(item)
    }
    observeLayout()
    const mutation = new MutationObserver(() => { observeLayout(); schedule() })
    mutation.observe(scroll, { childList: true })
    scroll.addEventListener('scroll', schedule, { passive: true })
    measure()
    return () => {
      scroll.removeEventListener('scroll', schedule)
      mutation.disconnect(); observer.disconnect(); cancelAnimationFrame(frame)
    }
  }, [layout.height, measure])
  // The editor above the list can change height without resizing the list itself.
  useEffect(() => { measure() })

  useEffect(() => {
    const index = focusPending.current
    if (index === null) return
    const button = list.current?.querySelector<HTMLButtonElement>(`[data-annotation-index="${index}"]`)
    if (button) { focusPending.current = null; button.focus() }
  }, [viewport, layout])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return
    const button = event.target instanceof HTMLElement ? event.target.closest<HTMLButtonElement>('[data-annotation-index]') : null
    if (event.target !== event.currentTarget && !button) return
    const selectedIndex = selectedId ? layout.rows.findIndex(item => item.id === selectedId) : -1
    const current = button ? Number(button.dataset.annotationIndex) : selectedIndex
    const last = layout.rows.length - 1
    if (last < 0) return
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? last
      : event.key === 'ArrowDown' ? Math.min(last, current + 1) : Math.max(0, current < 0 ? 0 : current - 1)
    event.preventDefault()
    const element = list.current
    const scroll = element?.closest<HTMLElement>('.dsh-pdf-panel-scroll')
    if (!element || !scroll) return
    const listTop = element.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop
    const itemTop = listTop + layout.positions[next]!
    if (itemTop < scroll.scrollTop + 48) scroll.scrollTop = Math.max(0, itemTop - 48)
    else if (itemTop + rowHeight > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = itemTop + rowHeight - scroll.clientHeight
    focusPending.current = next
    const target = element.querySelector<HTMLButtonElement>(`[data-annotation-index="${next}"]`)
    if (target) { focusPending.current = null; target.focus() }
    else requestAnimationFrame(measure)
  }

  const visibleStart = Math.max(0, viewport.top - overscan)
  const visibleEnd = Math.max(0, viewport.top + viewport.height + overscan)

  const heading = <div className="dsh-pdf-panel-heading dsh-pdf-annotations-heading">
      <h3>{t('reader.comments')} <span className="dsh-pdf-annotation-count">{annotations.length}</span></h3>
      <select aria-label={t('reader.filterAnnotations')} value={filter} onChange={event => {
        const next = event.target.value as AnnotationFilter
        setFilter(next)
        setFocusedId(null)
        const scroll = list.current?.closest<HTMLElement>('.dsh-pdf-panel-scroll')
        if (scroll) scroll.scrollTop = 0
        if (selectedId && next !== 'all' && !annotations.some(annotation => annotation.id === selectedId && annotation.subtype === next)) onDeselect()
      }}>
        {filters.map(value => <option key={value} value={value}>{value === 'all' ? t('reader.allAnnotations') : t(`reader.type.${value}`)}</option>)}
      </select>
    </div>
  return <ScrollablePanel className="dsh-pdf-comments" header={heading}
    verticalLabel={t('reader.verticalScroll')} horizontalLabel={t('reader.horizontalScroll')}>
    {details}
    {!!layout.groups.length && <div ref={list} className="dsh-pdf-annotation-virtual" role="list" tabIndex={0}
      aria-label={t('reader.comments')} onKeyDown={onKeyDown}
      onFocusCapture={event => {
        const button = event.target instanceof HTMLElement ? event.target.closest<HTMLButtonElement>('[data-annotation-index]') : null
        if (button) setFocusedId(layout.rows[Number(button.dataset.annotationIndex)]?.id ?? null)
      }}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocusedId(null) }}
      style={{ height: layout.height }}>
      {layout.groups.filter(group => group.top <= visibleEnd && group.top + group.height >= visibleStart
        || focusedIndex >= group.firstIndex && focusedIndex < group.firstIndex + group.annotations.length).map(group => {
        const first = Math.max(0, Math.floor((visibleStart - group.top - headingHeight) / rowHeight))
        const end = Math.max(first, Math.min(group.annotations.length, Math.ceil((visibleEnd - group.top - headingHeight) / rowHeight)))
        const pinned = focusedIndex >= group.firstIndex && focusedIndex < group.firstIndex + group.annotations.length
          ? focusedIndex - group.firstIndex : undefined
        return <AnnotationPageGroup key={group.page} group={group} first={first} end={end} pinned={pinned} totalRows={layout.rows.length}
          selectedId={selectedId} pdf={pdf} getText={getText} cachedExcerpts={cachedExcerpts} onSelect={onSelect} t={t} />
      })}
    </div>}
    {!layout.groups.length && (annotations.length > 0 || !details) && <p className="dsh-pdf-sidebar-empty">
      {t(annotations.length ? 'reader.noMatchingAnnotations' : 'reader.noAnnotations')}
    </p>}
  </ScrollablePanel>
}
