import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { PdfAnnotation } from '../core/pdf-types.js'
import { colorToHex } from './reader-selection.js'
import { formatAnnotationListDate } from './reader-dates.js'
import { annotationExcerpt } from './reader-annotation-excerpt.js'
import type { NativeDocument } from './native/document.js'

type AnnotationFilter = 'all' | 'Highlight' | 'Underline' | 'StrikeOut' | 'Text'
const filters: readonly AnnotationFilter[] = ['all', 'Highlight', 'Underline', 'StrikeOut', 'Text']

interface Props {
  annotations: readonly PdfAnnotation[]
  selectedId?: string
  pdf: NativeDocument | null
  details?: React.ReactNode
  onSelect: (annotation: PdfAnnotation) => void
  onDeselect: () => void
  t: (key: string) => string
}

function AnnotationPageGroup({ page, annotations, selectedId, pdf, onSelect, t }: Omit<Props, 'annotations' | 'details' | 'onDeselect'> & {
  page: number; annotations: readonly PdfAnnotation[]
}) {
  const root = useRef<HTMLDivElement>(null)
  const [excerpts, setExcerpts] = useState<Record<string, string>>({})

  useEffect(() => {
    const element = root.current
    if (!element || !pdf || !annotations.some(annotation => ['Highlight', 'Underline', 'StrikeOut'].includes(annotation.subtype))) return
    const controller = new AbortController()
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some(entry => entry.isIntersecting)) return
      observer.disconnect()
      void pdf.text(page, controller.signal).then(content => {
        if (controller.signal.aborted) return
        const next: Record<string, string> = {}
        for (const annotation of annotations) {
          const excerpt = annotationExcerpt(annotation, content)
          if (excerpt) next[annotation.id] = excerpt
        }
        setExcerpts(next)
      }).catch(() => undefined) // Text previews are optional; the annotations remain usable.
    }, { root: element.closest('.dsh-pdf-panel-scroll'), rootMargin: '160px 0px' })
    observer.observe(element)
    return () => { observer.disconnect(); controller.abort() }
  }, [pdf, page, annotations])

  return <div ref={root} className="dsh-pdf-annotation-group">
    <h4 className="dsh-pdf-annotation-page">{t('reader.annotationPagePrefix')}{page}{t('reader.annotationPageSuffix')}</h4>
    {annotations.map(annotation => {
      const type = annotation.supported ? t(`reader.type.${annotation.subtype}`) : annotation.subtype
      const excerpt = excerpts[annotation.id]
      const comment = annotation.contents?.trim()
      const primary = excerpt ?? comment ?? type
      const date = annotation.modifiedAt ?? annotation.createdAt
      const formattedDate = date ? formatAnnotationListDate(date) : undefined
      return <button type="button" key={annotation.id}
        className={`dsh-pdf-comment-item${selectedId === annotation.id ? ' is-selected' : ''}`}
        aria-pressed={selectedId === annotation.id}
        onClick={() => onSelect(annotation)}>
        <span className="dsh-pdf-comment-color" style={{ backgroundColor: colorToHex(annotation.color) }} aria-hidden="true" />
        <span className="dsh-pdf-comment-content">
          <span className="dsh-pdf-comment-preview" title={primary}>{primary}</span>
          {excerpt && comment && <span className="dsh-pdf-comment-note" title={comment}>{comment}</span>}
          {(primary !== type || formattedDate) && <span className="dsh-pdf-comment-meta">
            {primary !== type && <span>{type}</span>}
            {formattedDate && <time>{formattedDate}</time>}
          </span>}
        </span>
      </button>
    })}
  </div>
}

export function AnnotationList({ annotations, selectedId, pdf, details, onSelect, onDeselect, t }: Props) {
  const [filter, setFilter] = useState<AnnotationFilter>('all')
  const groups = useMemo(() => {
    const result = new Map<number, PdfAnnotation[]>()
    for (const annotation of annotations) {
      if (filter !== 'all' && annotation.subtype !== filter) continue
      const items = result.get(annotation.page) ?? []
      items.push(annotation)
      result.set(annotation.page, items)
    }
    return [...result].sort(([a], [b]) => a - b)
  }, [annotations, filter])

  return <>
    <div className="dsh-pdf-panel-heading dsh-pdf-annotations-heading">
      <h3>{t('reader.comments')} <span className="dsh-pdf-annotation-count">{annotations.length}</span></h3>
      <select aria-label={t('reader.filterAnnotations')} value={filter} onChange={event => {
        const next = event.target.value as AnnotationFilter
        setFilter(next)
        if (selectedId && next !== 'all' && !annotations.some(annotation => annotation.id === selectedId && annotation.subtype === next)) onDeselect()
      }}>
        {filters.map(value => <option key={value} value={value}>{value === 'all' ? t('reader.allAnnotations') : t(`reader.type.${value}`)}</option>)}
      </select>
    </div>
    {details}
    {groups.map(([page, items]) => <AnnotationPageGroup key={`${pdf?.snapshot.id ?? 'none'}:${pdf?.snapshot.reader.bytesHash ?? 'none'}:${page}`}
      page={page} annotations={items} selectedId={selectedId} pdf={pdf} onSelect={onSelect} t={t} />)}
    {!groups.length && (annotations.length > 0 || !details) && <p className="dsh-pdf-sidebar-empty">
      {t(annotations.length ? 'reader.noMatchingAnnotations' : 'reader.noAnnotations')}
    </p>}
  </>
}
