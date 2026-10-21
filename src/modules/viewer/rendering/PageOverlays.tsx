import React, { memo, useEffect, useMemo, useRef, type RefObject } from 'react'
import type { PdfAnnotation, PdfRect } from '../../../core/pdf-types.js'
import { DEFAULT_HIGHLIGHT_OPACITY } from '../../../core/pdf-types.js'
import type { PdfOcrTextPart } from '../../../ocr/mapping.js'
import type { ExplanationExcerpt } from '../../explanation/index.js'
import { annotationPolygons, markupOverlappingPatches, pendingMarkupAnnotations, visibleAnnotation,
  type AnnotationPoint } from '../model/reader-annotations.js'
import { colorToHex, noteMarkerViewportPosition, pdfRectToViewport, type PageViewport, type ReaderSelection } from '../model/reader-selection.js'
import { namedLinkAction, safeLinkUrl, type PdfLink } from '../model/reader-links.js'
import { mergeSelectionRects } from '../model/selection-highlight.js'
import { createAnnotationThreadIndex, isStandaloneNote } from '../model/annotation-thread.js'
import { ToolbarIcon } from '../components/ToolbarIcon.js'

const noAnnotations: PdfAnnotation[] = []
const commentableMarks = new Set(['Highlight', 'Underline', 'StrikeOut'])
const NOTE_MARKER_SIZE = 22
const NOTE_DRAG_THRESHOLD = 5

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum))
}

function noteMarkerTravel(button: HTMLButtonElement, width: number, height: number) {
  const page = button.parentElement?.getBoundingClientRect()
  if (!page?.width || !page.height) return null
  const scaleX = page.width / width, scaleY = page.height / height
  const sidebar = button.closest('.dsh-pdf-reader')?.querySelector<HTMLElement>('.dsh-pdf-sidebar')?.getBoundingClientRect()
  // The floating sidebar covers the PDF's right edge. Stop before its frame
  // rather than persisting a note marker that can no longer be clicked.
  const sidebarOverlaps = sidebar && sidebar.left < page.right && sidebar.right > page.left
    && sidebar.top < page.bottom && sidebar.bottom > page.top
  const visibleRight = sidebarOverlaps ? sidebar.left - 8 : page.right
  return { scaleX, scaleY,
    maxX: Math.max(0, Math.min(width - NOTE_MARKER_SIZE,
      (visibleRight - page.left) / scaleX - NOTE_MARKER_SIZE)),
    maxY: Math.max(0, height - NOTE_MARKER_SIZE) }
}

function screenRect(viewport: PageViewport, rect: readonly number[]) {
  const value = pdfRectToViewport(viewport, rect)
  return { left: Math.min(value[0], value[2]), top: Math.min(value[1], value[3]),
    width: Math.abs(value[2] - value[0]), height: Math.abs(value[3] - value[1]) }
}

function NoteMarker({ annotation, viewport, width, height, pageNumber, onOpen, onMove, label }: {
  annotation: PdfAnnotation
  viewport: PageViewport
  width: number
  height: number
  pageNumber: number
  onOpen(id: string): void
  onMove?(id: string, page: number, delta: { x: number; y: number }): Promise<boolean>
  label: string
}) {
  const marker = useRef<HTMLButtonElement>(null)
  const drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number;
    scaleX: number; scaleY: number; maxX: number; maxY: number; moved: boolean; deltaX: number; deltaY: number } | null>(null)
  const suppressClick = useRef(false)
  const moving = useRef(false)
  const { left, top } = noteMarkerViewportPosition(viewport, annotation.rect!, NOTE_MARKER_SIZE)
  const rectKey = annotation.rect?.join(',')

  useEffect(() => {
    if (!moving.current || !marker.current) return
    marker.current.style.transform = ''
    delete marker.current.dataset.moving
    moving.current = false
  }, [rectKey])

  const preview = (event: React.PointerEvent<HTMLButtonElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < NOTE_DRAG_THRESHOLD) return
    current.moved = true
    const dx = clamp((event.clientX - current.x) / current.scaleX, -current.left,
      current.maxX - current.left)
    const dy = clamp((event.clientY - current.y) / current.scaleY, -current.top,
      current.maxY - current.top)
    current.deltaX = dx * current.scaleX
    current.deltaY = dy * current.scaleY
    event.currentTarget.style.transform = `translate(${dx}px, ${dy}px)`
    event.currentTarget.dataset.dragging = 'true'
  }
  const cancel = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    event.currentTarget.style.transform = ''
    delete event.currentTarget.dataset.dragging
  }
  const commit = async (button: HTMLButtonElement, delta: { x: number; y: number }) => {
    moving.current = true
    button.dataset.moving = 'true'
    let saved = false
    try { saved = !!await onMove?.(annotation.id, pageNumber, delta) }
    catch { /* The Reader reports persistence errors. */ }
    if (saved) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    if (!button.isConnected) return
    button.style.transform = ''
    delete button.dataset.moving
    moving.current = false
  }

  return <button ref={marker} type="button" className="dsh-pdf-note-marker" data-pdf-note-id={annotation.id}
    style={{ left, top, width: NOTE_MARKER_SIZE, height: NOTE_MARKER_SIZE,
      '--pdf-note-tint': colorToHex(annotation.color) } as React.CSSProperties}
    title={annotation.contents || label} aria-label={annotation.contents || label}
    data-editable={annotation.editable && !!onMove ? 'true' : 'false'}
    onPointerDown={event => {
      event.stopPropagation()
      if (!annotation.editable || !onMove || moving.current || event.button !== 0 || event.isPrimary === false) return
      const travel = noteMarkerTravel(event.currentTarget, width, height)
      if (!travel) return
      suppressClick.current = false
      drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left, top,
        ...travel, moved: false, deltaX: 0, deltaY: 0 }
      try { event.currentTarget.setPointerCapture(event.pointerId) }
      catch { /* Embedded test hosts may not implement pointer capture. */ }
    }}
    onPointerMove={event => { if (drag.current) { event.stopPropagation(); preview(event) } }}
    onPointerUp={event => {
      event.stopPropagation()
      const current = drag.current
      if (!current || current.pointerId !== event.pointerId) return
      drag.current = null
      delete event.currentTarget.dataset.dragging
      if (!current.moved) return
      suppressClick.current = true
      void commit(event.currentTarget, { x: current.deltaX, y: current.deltaY })
    }}
    onPointerCancel={event => { event.stopPropagation(); cancel(event) }}
    onLostPointerCapture={cancel}
    onClick={event => {
      event.stopPropagation()
      if (suppressClick.current) { suppressClick.current = false; return }
      onOpen(annotation.id)
    }}
    onKeyDown={event => {
      if (!annotation.editable || !onMove || moving.current) return
      const distance = event.shiftKey ? 10 : 2
      const dx = event.key === 'ArrowLeft' ? -distance : event.key === 'ArrowRight' ? distance : 0
      const dy = event.key === 'ArrowUp' ? -distance : event.key === 'ArrowDown' ? distance : 0
      if (!dx && !dy) return
      event.preventDefault()
      event.stopPropagation()
      const travel = noteMarkerTravel(event.currentTarget, width, height)
      if (!travel) return
      const delta = { x: (clamp(left + dx, 0, travel.maxX) - left) * travel.scaleX,
        y: (clamp(top + dy, 0, travel.maxY) - top) * travel.scaleY }
      if (delta.x || delta.y) void commit(event.currentTarget, delta)
    }}><ToolbarIcon name="note" /></button>
}

function explanationFragmentRects(fragment: ReaderSelection['fragments'][number], viewport: PageViewport): PdfRect[] {
  const rects: PdfRect[] = []
  for (let index = 0; index + 7 < fragment.quadPoints.length; index += 8) {
    const points = Array.from({ length: 4 }, (_, corner) => viewport.convertToViewportPoint(
      fragment.quadPoints[index + corner * 2], fragment.quadPoints[index + corner * 2 + 1],
    ))
    const xs = points.map(point => point[0]), ys = points.map(point => point[1])
    rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)])
  }
  if (!rects.length) rects.push(pdfRectToViewport(viewport, fragment.rect))
  return rects
}

const PendingMarkup = memo(function PendingMarkup({ annotation, viewport }: { annotation: PdfAnnotation; viewport: PageViewport }) {
  const polygons = annotationPolygons(annotation, viewport)
  const color = `rgb(${(annotation.color ?? [1, 0.85, 0]).map((value) => Math.round(value * 255)).join(',')})`
  if (annotation.subtype === 'Highlight') {
    const path = polygons.map((points) => `M ${points.map(([x, y]) => `${x} ${y}`).join(' L ')} Z`).join(' ')
    return <g data-annotation-id={annotation.id}>
      <path d={path} fill={color} opacity={annotation.opacity ?? DEFAULT_HIGHLIGHT_OPACITY} style={{ mixBlendMode: 'multiply' }} />
    </g>
  }
  return <g data-annotation-id={annotation.id} opacity={annotation.opacity ?? 1}>
    {polygons.map((points, index) => {
      const ratio = annotation.subtype === 'StrikeOut' ? 0.5 : 0.06
      const interpolate = (bottom: AnnotationPoint, top: AnnotationPoint): AnnotationPoint => [bottom[0] + (top[0] - bottom[0]) * ratio, bottom[1] + (top[1] - bottom[1]) * ratio]
      const first = interpolate(points[3], points[0]), second = interpolate(points[2], points[1])
      const thickness = Math.max(0.75, Math.hypot(points[0][0] - points[3][0], points[0][1] - points[3][1]) * 0.065)
      return <line key={index} x1={first[0]} y1={first[1]} x2={second[0]} y2={second[1]} stroke={color} strokeWidth={thickness} />
    })}
  </g>
})

export function PageMarkupOverlay({ near, viewport, width, height, annotations, paintedAnnotations, patchBoxes, clipId }: {
  near: boolean
  viewport?: PageViewport
  width: number
  height: number
  annotations: readonly PdfAnnotation[]
  paintedAnnotations: readonly PdfAnnotation[]
  patchBoxes: PdfRect[]
  clipId: string
}) {
  const pending = useMemo(() => near ? pendingMarkupAnnotations(annotations, paintedAnnotations) : noAnnotations,
    [near, annotations, paintedAnnotations])
  const overlapping = useMemo(() => near && viewport ? markupOverlappingPatches(annotations, pending, patchBoxes, viewport) : noAnnotations,
    [near, annotations, pending, patchBoxes, viewport])
  if (!near || !viewport || (!pending.length && !overlapping.length)) return null
  return <svg className="dsh-pdf-annotation-overlay" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
    {overlapping.length > 0 && <><defs><clipPath id={clipId}>
      {patchBoxes.map(([left, top, right, bottom], index) => <rect key={index} x={left} y={top} width={right - left} height={bottom - top} />)}
    </clipPath></defs><g clipPath={`url(#${clipId})`}>
      {overlapping.map(annotation => <PendingMarkup key={annotation.id} annotation={annotation} viewport={viewport} />)}
    </g></>}
    {pending.map(annotation => <PendingMarkup key={annotation.id} annotation={annotation} viewport={viewport} />)}
  </svg>
}

const OcrWord = memo(function OcrWord({ word, viewport }: { word: PdfOcrTextPart; viewport: PageViewport }) {
  if (!word.pdf) return null
  const q = word.pdf.quad
  const [x0, y0] = viewport.convertToViewportPoint(q[0], q[1])
  const [x1, y1] = viewport.convertToViewportPoint(q[2], q[3])
  const [x2, y2] = viewport.convertToViewportPoint(q[4], q[5])
  const width = Math.hypot(x1 - x0, y1 - y0), height = Math.hypot(x2 - x0, y2 - y0)
  if (!width || !height) return null
  return <span className="dsh-pdf-ocr-word" style={{
    left: x0, top: y0, width, height, fontSize: height * 0.9,
    transform: `matrix(${(x1 - x0) / width},${(y1 - y0) / width},${(x2 - x0) / height},${(y2 - y0) / height},0,0)`,
  }}><span data-ocr-width={width}>{word.text} </span></span>
})

export interface PageContextOverlaysProps {
  near: boolean
  textActive: boolean
  viewport?: PageViewport
  width: number
  height: number
  pageNumber: number
  mode: 'text' | 'region' | 'note'
  annotations: readonly PdfAnnotation[]
  selectedAnnotation?: string
  selection: ReaderSelection | null
  explanationExcerpts?: readonly ExplanationExcerpt[]
  explanationDraft?: { index: number; fragment: ReaderSelection['fragments'][number] }
  ocrWords: readonly PdfOcrTextPart[]
  ocrHost: RefObject<HTMLDivElement>
  keyboardLinks: readonly PdfLink[]
  drag: { x: number; y: number; endX: number; endY: number } | null
  followLink(link: PdfLink): void
  onAnnotation(id: string, intent?: 'select' | 'comment' | 'note'): void
  onMoveNoteMarker?(id: string, page: number, delta: { x: number; y: number }): Promise<boolean>
  onExplanationMark?(id: string, marker: HTMLElement): void
  t(key: string): string
}

/** Independent layers preserve the native tile, text and pointer surface underneath. */
export function PageContextOverlays(props: PageContextOverlaysProps) {
  const { near, textActive, viewport, width, height, pageNumber, mode, annotations, selectedAnnotation,
    selection, explanationExcerpts, explanationDraft, ocrWords, ocrHost, keyboardLinks, drag,
    followLink, onAnnotation, onMoveNoteMarker, onExplanationMark, t } = props
  const region = selection?.kind === 'region' ? selection.fragments.find(fragment => fragment.page === pageNumber) : undefined
  const selected = useMemo(() => annotations.find(annotation => annotation.id === selectedAnnotation),
    [annotations, selectedAnnotation])
  const noteMarkers = useMemo(() => near ? annotations.filter(annotation => isStandaloneNote(annotation)
    && annotation.id !== selectedAnnotation
    && annotation.rect && visibleAnnotation(annotation)) : noAnnotations, [near, annotations, selectedAnnotation])
  const commentMarkers = useMemo(() => {
    if (!near || !viewport) return []
    const threadIndex = createAnnotationThreadIndex(annotations)
    const roots = new Map<string, PdfAnnotation>()
    for (const annotation of annotations) {
      if (!annotation.contents?.trim()) continue
      const root = threadIndex.rootOf(annotation)
      if (root.rect && visibleAnnotation(root) && commentableMarks.has(root.subtype)) roots.set(root.id, root)
    }
    return [...roots.values()].flatMap(annotation => {
      const first = annotationPolygons(annotation, viewport)[0]
      const box = first?.length ? {
        left: Math.min(...first.map(point => point[0])),
        top: Math.min(...first.map(point => point[1])),
        right: Math.max(...first.map(point => point[0])),
      } : screenRect(viewport, annotation.rect!)
      // Keep the 22px marker completely above the markup with a 2px gap. It
      // may overlap a nearby PDF line, but it must never cover the selected text.
      return [{ annotation, left: Math.max(0, Math.min(width - 22, ('right' in box ? box.right : box.left) - 12)), top: Math.max(0, box.top - 24) }]
    })
  }, [near, viewport, annotations, width])
  const explanationMarks = useMemo(() => {
    if (!near || !viewport) return []
    return (explanationExcerpts ?? []).flatMap((excerpt, index) => {
      const boxes = excerpt.fragments.filter(fragment => fragment.page === pageNumber)
        .flatMap(fragment => explanationFragmentRects(fragment, viewport))
      const rects = mergeSelectionRects(boxes)
      return rects.length ? [{ id: excerpt.id, index: index + 1, rects, kind: excerpt.kind }] : []
    })
  }, [near, viewport, explanationExcerpts, pageNumber])
  const draftExplanationMark = useMemo(() => {
    if (!near || !viewport || !explanationDraft || explanationDraft.fragment.page !== pageNumber) return null
    const rects = mergeSelectionRects(explanationFragmentRects(explanationDraft.fragment, viewport))
    return rects.length ? { index: explanationDraft.index, rect: rects[0]! } : null
  }, [near, viewport, explanationDraft, pageNumber])

  return <>
    {textActive && !!ocrWords.length && viewport && <div ref={ocrHost} className="dsh-pdf-ocr-layer" data-pdf-text="active">
      {ocrWords.map(word => <OcrWord key={word.id} word={word} viewport={viewport} />)}
    </div>}
    {near && viewport && mode === 'text' && <div className="dsh-pdf-keyboard-links">
      {keyboardLinks.map(link => {
        const url = safeLinkUrl(link.url)
        if (url && !link.dest && !namedLinkAction(link.action)) return <a key={link.id} href={url} target="_blank" rel="noreferrer noopener">{url}</a>
        return <button key={link.id} type="button" onClick={() => followLink(link)}>{t('reader.internalLink')}</button>
      })}
    </div>}
    {near && viewport && mode === 'text' && <div className="dsh-pdf-links">
      {noteMarkers.map(annotation => <NoteMarker key={annotation.id} annotation={annotation} viewport={viewport}
        width={width} height={height} pageNumber={pageNumber} label={t('reader.note')}
        onOpen={id => onAnnotation(id, 'note')} onMove={onMoveNoteMarker} />)}
      {commentMarkers.map(({ annotation, left, top }) => <button key={annotation.id} type="button"
        className={`dsh-pdf-comment-marker${selectedAnnotation === annotation.id ? ' is-selected' : ''}`}
        data-pdf-comment-id={annotation.id}
        style={{ left, top }} title={t('reader.commentText')}
        aria-label={`${t('reader.comments')} · ${t('reader.page')} ${pageNumber}`}
        onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); onAnnotation(annotation.id, 'comment') }}>
        <ToolbarIcon name="commentedMark" />
      </button>)}
    </div>}
    {viewport && selected && !isStandaloneNote(selected) && <svg className="dsh-pdf-annotation-outline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {annotationPolygons(selected, viewport).map((points, index) => <polygon key={index} points={points.map(point => point.join(',')).join(' ')} fill="none" stroke="var(--pdf-accent)" strokeWidth="1.5" />)}
    </svg>}
    {(!!explanationMarks.length || !!draftExplanationMark) && <div className="dsh-pdf-explanation-overlay">
      {explanationMarks.flatMap(mark => mark.rects.map(([left, top, right, bottom], index) =>
        <div key={`${mark.id}:${index}`} className={`dsh-pdf-explanation-mark${mark.kind === 'region' ? ' is-region' : ''}`}
          data-pdf-explanation-mark="" data-pdf-explanation-kind={mark.kind}
          aria-hidden="true" style={{ left, top, width: right - left, height: bottom - top }} />))}
      {explanationMarks.map(mark => {
        const [left, top] = mark.rects[0]!
        const hasMargin = left >= 32
        return <button key={mark.id} type="button" className="dsh-pdf-explanation-index"
          data-pdf-explanation-id={mark.id}
          aria-label={`${t('reader.explain.editQuestion')} ${mark.index}`}
          style={{ left: hasMargin ? left - 30 : left, top: hasMargin ? top : Math.max(0, top - 28) }}
          onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
          onClick={event => { event.stopPropagation(); onExplanationMark?.(mark.id, event.currentTarget) }}>
          {mark.index}
        </button>
      })}
      {draftExplanationMark && <span className="dsh-pdf-explanation-index" data-pdf-explanation-preview="" aria-hidden="true"
        style={{ left: draftExplanationMark.rect[0] >= 32 ? draftExplanationMark.rect[0] - 30 : draftExplanationMark.rect[0],
          top: draftExplanationMark.rect[0] >= 32 ? draftExplanationMark.rect[1] : Math.max(0, draftExplanationMark.rect[1] - 28) }}>
        {draftExplanationMark.index}
      </span>}
    </div>}
    {viewport && region && <div className="dsh-pdf-region" style={screenRect(viewport, region.rect)} />}
    {drag && mode === 'region' && <div className="dsh-pdf-region" style={{ left: Math.min(drag.x, drag.endX), top: Math.min(drag.y, drag.endY), width: Math.abs(drag.endX - drag.x), height: Math.abs(drag.endY - drag.y) }} />}
  </>
}
