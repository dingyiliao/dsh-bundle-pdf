import React, { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_HIGHLIGHT_OPACITY, type PdfAnnotation, type PdfPageInfo, type PdfRect } from '../core/pdf-types.js'
import type { PdfOcrTextPart } from '../ocr/mapping.js'
import { viewportRectToPdf, pdfRectToViewport, overlapFraction, type PageView, type PageViewport, type ReaderSelection } from './reader-selection.js'
import { annotationAtPoint, annotationPatchBoxes, annotationPolygons, createAnnotationHitTester, createRectHitIndex, markupOverlappingPatches, pendingMarkupAnnotations, staleNativeAnnotations, visibleAnnotation, type AnnotationPoint } from './reader-annotations.js'
import { actionableLink, createLinkHitTester, linkAtPoint, namedLinkAction, safeLinkUrl, type PdfLink } from './reader-links.js'
import type { NativeDocument, NativePage } from './native/document.ts'
import { TileSurface } from './native/TileSurface.tsx'
import { renderNativeTextLayer } from './native/text-layer.ts'
import type { ExplanationExcerpt } from './explain-mode.js'

export interface PageProps {
  pdf: NativeDocument
  geometry: PdfPageInfo
  scale: number
  rotation: number
  mode: 'text' | 'region' | 'note'
  annotations: PdfAnnotation[]
  /** Annotation models baked into this immutable native document. */
  renderedAnnotations?: PdfAnnotation[]
  selectedAnnotation?: string
  selection: ReaderSelection | null
  explanationExcerpts?: readonly ExplanationExcerpt[]
  ocrWords?: PdfOcrTextPart[]
  /** Keep selectable text and its viewport while a selection spans offscreen pages. */
  retainTextLayer?: boolean
  scrollRoot: HTMLElement | null
  t(key: string): string
  onView(page: number, view: PageView | null): void
  onDestination(destination: unknown): void
  onNamedAction(action: string): void
  onAnnotation(id: string): void
  onBackground?(): void
  onRegion(page: number, geometry: { rect: PdfRect; quadPoints: number[] }): void
  onNote(page: number, point: number[]): void
  onError(message: string): void
}

interface LoadedPage { owner: NativeDocument; page: NativePage; links?: PdfLink[] }
const noLinks: PdfLink[] = []
const noAnnotations: PdfAnnotation[] = []
const noOcrWords: PdfOcrTextPart[] = []

function screenRect(viewport: PageViewport, rect: readonly number[]) {
  const value = pdfRectToViewport(viewport, rect)
  return { left: Math.min(value[0], value[2]), top: Math.min(value[1], value[3]), width: Math.abs(value[2] - value[0]), height: Math.abs(value[3] - value[1]) }
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

/** Native tiles, text and links share the same viewport. */
export function Page(props: PageProps) {
  const { pdf, geometry, scale, rotation, t } = props
  const patchClipId = `dsh-pdf-patch-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const outer = useRef<HTMLDivElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const textHost = useRef<HTMLDivElement>(null)
  const ocrHost = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  const textActive = near || !!props.retainTextLayer
  const [loaded, setLoaded] = useState<LoadedPage | null>(null)
  const loadedCache = useRef<LoadedPage | null>(null)
  const page = loaded?.page
  const pageOwner = loaded?.owner
  const [paintedAnnotations, setPaintedAnnotations] = useState<PdfAnnotation[]>([])
  const [links, setLinks] = useState<PdfLink[]>([])
  const [rendered, setRendered] = useState(false)
  const [nativeBoxes, setNativeBoxes] = useState<PdfRect[]>([])
  const [drag, setDrag] = useState<{ x: number; y: number; endX: number; endY: number } | null>(null)
  const dragPointer = useRef<{ element: HTMLElement; pointerId: number } | null>(null)
  const textPress = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | null>(null)
  const pendingLink = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hoveredText = useRef<{ element: HTMLElement; previous: string } | null>(null)
  const callbacks = useRef(props)
  callbacks.current = props
  const angle = ((geometry.rotation + rotation) % 360 + 360) % 360
  const viewport = useMemo(() => page?.getViewport({ scale, rotation: angle }), [page, scale, angle])
  const quarterTurn = angle % 180 !== 0
  const baseWidth = (geometry.cropBox[2] - geometry.cropBox[0]) * geometry.userUnit
  const baseHeight = (geometry.cropBox[3] - geometry.cropBox[1]) * geometry.userUnit
  const width = viewport?.width ?? (quarterTurn ? baseHeight : baseWidth) * scale
  const height = viewport?.height ?? (quarterTurn ? baseWidth : baseHeight) * scale
  const sourceAnnotations = props.renderedAnnotations ?? noAnnotations
  const staleNative = useMemo(() => staleNativeAnnotations(props.annotations, sourceAnnotations), [props.annotations, sourceAnnotations])
  const patchBoxes = useMemo(() => viewport ? staleNative.flatMap(annotation => annotationPatchBoxes(annotation, viewport)) : [],
    [staleNative, viewport])

  useEffect(() => {
    const root = props.scrollRoot, element = outer.current
    if (!root || !element) return
    const update = () => {
      const bounds = root.getBoundingClientRect(), box = element.getBoundingClientRect()
      setNear(box.bottom > bounds.top - 900 && box.top < bounds.bottom + 900
        && box.right > bounds.left && box.left < bounds.right)
    }
    // A page mounted after a distant scroll can be visible before the observer
    // delivers its first entry. Check its geometry now and after scrolls too.
    const observer = new IntersectionObserver(update, { root, rootMargin: '900px 0px' })
    observer.observe(element)
    root.addEventListener('scroll', update, { passive: true })
    update()
    return () => { observer.disconnect(); root.removeEventListener('scroll', update) }
  }, [props.scrollRoot])

  useEffect(() => {
    if (!textActive) return
    const cached = loadedCache.current
    if (cached?.owner === pdf && cached.page.pageNumber === geometry.page && cached.links) {
      setLoaded(cached)
      setLinks(cached.links)
      return
    }
    let active = true
    void pdf.getPage(geometry.page).then(async (loaded) => {
      if (!active) return
      const record: LoadedPage = { owner: pdf, page: loaded }
      loadedCache.current = record
      setLoaded(record)
      const annotations = await loaded.getAnnotations()
      const nativeLinks = annotations.filter((annotation) => annotation.subtype === 'Link').map((annotation) => ({
        id: annotation.id, rect: annotation.rect, quadPoints: annotation.quadPoints ? Array.from(annotation.quadPoints) as number[] : undefined,
        dest: annotation.dest, url: annotation.url, action: annotation.action,
      }))
      record.links = nativeLinks
      if (active) setLinks(nativeLinks)
    }).catch((error) => { if (active) callbacks.current.onError(String(error)) })
    return () => { active = false }
  }, [pdf, geometry.page, textActive])

  useEffect(() => {
    if (!textActive || !page || pageOwner !== pdf || !surface.current) return
    const nextViewport = page.getViewport({ scale, rotation: angle })
    callbacks.current.onView(geometry.page, { element: surface.current, page, viewport: nextViewport })
    return () => callbacks.current.onView(geometry.page, null)
  }, [textActive, pageOwner, pdf, page, scale, angle, geometry.page])

  useEffect(() => {
    if (!near) {
      setRendered(false)
      setPaintedAnnotations([])
    }
  }, [near, pdf])

  useEffect(() => {
    if (!textActive) { setNativeBoxes([]); return }
    if (!page || pageOwner !== pdf || !textHost.current) return
    const host = textHost.current
    host.replaceChildren()
    const nextViewport = page.getViewport({ scale, rotation: angle })
    host.style.width = `${nextViewport.width}px`
    host.style.height = `${nextViewport.height}px`
    let active = true
    void page.getTextContent().then((content) => {
      if (!active || !surface.current) return
      const spans = renderNativeTextLayer(host, content, nextViewport)
      const bounds = surface.current.getBoundingClientRect()
      setNativeBoxes(spans.filter((span) => span.textContent?.trim()).map((span) => {
        const box = span.getBoundingClientRect()
        return [box.left - bounds.left, box.top - bounds.top, box.right - bounds.left, box.bottom - bounds.top] as PdfRect
      }))
    }).catch((error) => { if (active && error?.name !== 'AbortException') callbacks.current.onError(String(error)) })
    return () => { active = false; host.replaceChildren() }
  }, [textActive, pageOwner, pdf, page, scale, angle, geometry.userUnit])

  const pointer = (event: React.PointerEvent) => {
    const bounds = surface.current!.getBoundingClientRect()
    return { x: Math.max(0, Math.min(width, event.clientX - bounds.left)), y: Math.max(0, Math.min(height, event.clientY - bounds.top)) }
  }
  const activeLinks = pageOwner === pdf && loaded?.links === links ? links : noLinks
  const hitLink = useMemo(() => near ? createLinkHitTester(activeLinks) : undefined, [near, activeLinks])
  const hitAnnotation = useMemo(() => near && viewport ? createAnnotationHitTester(props.annotations, viewport) : undefined,
    [near, props.annotations, viewport])
  const keyboardLinks = useMemo(() => activeLinks.filter(actionableLink), [activeLinks])
  const nativeIndex = useMemo(() => createRectHitIndex(textActive ? nativeBoxes.map(rect => ({ rect, value: rect })) : []), [textActive, nativeBoxes])
  const visibleOcrWords = useMemo(() => {
    if (!textActive || !viewport || !props.ocrWords?.length) return noOcrWords
    return props.ocrWords.filter(word => {
      if (!word.pdf) return false
      if (!nativeBoxes.length) return true
      const rect = pdfRectToViewport(viewport, word.pdf.rect)
      return !nativeIndex.intersect(rect).some(box => overlapFraction(rect, box) > 0.5)
    })
  }, [textActive, viewport, props.ocrWords, nativeBoxes, nativeIndex])
  useLayoutEffect(() => {
    const host = ocrHost.current
    if (!host) return
    // Read every intrinsic width first, then write transforms in one batch.
    const words = Array.from(host.querySelectorAll<HTMLElement>('[data-ocr-width]')).map(node => ({
      node, target: Number(node.dataset.ocrWidth), natural: node.scrollWidth,
    }))
    for (const { node, target, natural } of words) node.style.transform = natural ? `scaleX(${target / natural})` : ''
  }, [visibleOcrWords, viewport])
  const cancelLinkClick = () => {
    if (pendingLink.current) clearTimeout(pendingLink.current)
    pendingLink.current = undefined
  }
  const clearLinkCursor = () => {
    const previous = hoveredText.current
    if (previous) previous.element.style.cursor = previous.previous
    hoveredText.current = null
  }
  const clearDrag = () => {
    const captured = dragPointer.current
    dragPointer.current = null
    setDrag(null)
    if (captured) {
      try {
        if (captured.element.hasPointerCapture(captured.pointerId)) captured.element.releasePointerCapture(captured.pointerId)
      } catch { /* The pointer or page may already have been removed. */ }
    }
  }
  const updateLinkCursor = (event: React.PointerEvent) => {
    if (props.mode !== 'text' || !viewport || !activeLinks.length || !(event.target instanceof HTMLElement)
      || event.target.closest('button,a,input,textarea')) { clearLinkCursor(); return }
    const point = pointer(event)
    const link = hitLink ? hitLink(viewport, [point.x, point.y]) : linkAtPoint(activeLinks, viewport, [point.x, point.y])
    if (!link) { clearLinkCursor(); return }
    if (hoveredText.current?.element === event.target) return
    clearLinkCursor()
    hoveredText.current = { element: event.target, previous: event.target.style.cursor }
    // The actual text span owns its cursor; its native selection events remain untouched.
    event.target.style.cursor = 'pointer'
  }
  const followLink = (link: PdfLink) => {
    if (link.dest) callbacks.current.onDestination(link.dest)
    else if (namedLinkAction(link.action)) callbacks.current.onNamedAction(link.action)
    else {
      const url = safeLinkUrl(link.url)
      if (url) window.open(url, '_blank', 'noopener,noreferrer')
    }
  }
  useEffect(() => () => {
    cancelLinkClick()
    clearLinkCursor()
    clearDrag()
    textPress.current = null
  }, [pdf, props.mode, near])
  const region = props.selection?.kind === 'region' ? props.selection.fragments.find((f) => f.page === geometry.page) : undefined
  const selected = useMemo(() => props.annotations.find((annotation) => annotation.id === props.selectedAnnotation),
    [props.annotations, props.selectedAnnotation])
  const pending = useMemo(() => near ? pendingMarkupAnnotations(props.annotations, paintedAnnotations) : noAnnotations,
    [near, props.annotations, paintedAnnotations])
  const overlapping = useMemo(() => near && viewport ? markupOverlappingPatches(props.annotations, pending, patchBoxes, viewport) : noAnnotations,
    [near, props.annotations, pending, patchBoxes, viewport])
  const noteMarkers = useMemo(() => near ? props.annotations.filter(annotation => annotation.subtype === 'Text'
    && annotation.rect && visibleAnnotation(annotation)) : noAnnotations, [near, props.annotations])
  const explanationPolygons = useMemo(() => {
    if (!near || !viewport) return []
    return (props.explanationExcerpts ?? []).flatMap(excerpt => excerpt.fragments
      .filter(fragment => fragment.page === geometry.page)
      .flatMap(fragment => {
        const polygons: string[] = []
        for (let index = 0; index + 7 < fragment.quadPoints.length; index += 8) {
          const points = Array.from({ length: 4 }, (_, corner) => viewport.convertToViewportPoint(
            fragment.quadPoints[index + corner * 2], fragment.quadPoints[index + corner * 2 + 1],
          ))
          polygons.push(points.map(point => point.join(',')).join(' '))
        }
        if (!polygons.length) {
          const [left, top, right, bottom] = pdfRectToViewport(viewport, fragment.rect)
          polygons.push(`${left},${top} ${right},${top} ${right},${bottom} ${left},${bottom}`)
        }
        return polygons
      }))
  }, [near, viewport, props.explanationExcerpts, geometry.page])

  return <div ref={outer} className="dsh-pdf-page-wrap" data-page-number={geometry.page}>
    <div className="dsh-pdf-page-label">{t('reader.page')} {geometry.page}{props.ocrWords?.length ? ` · ${t('reader.ocrText')}` : ''}</div>
    <div ref={surface} data-pdf-page={geometry.page} className={`dsh-pdf-page dsh-pdf-mode-${props.mode}`}
      style={{ width, height }} onPointerDown={(event) => {
        cancelLinkClick()
        if (!viewport || event.button !== 0) return
        if (props.mode === 'text') {
          if (event.target instanceof Element && event.target.closest('button,a,input,textarea')) return
          textPress.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false }
          return
        }
        event.preventDefault()
        clearDrag()
        event.currentTarget.setPointerCapture(event.pointerId)
        dragPointer.current = { element: event.currentTarget, pointerId: event.pointerId }
        const start = pointer(event)
        setDrag({ ...start, endX: start.x, endY: start.y })
      }} onPointerMove={(event) => {
        updateLinkCursor(event)
        if (textPress.current && Math.hypot(event.clientX - textPress.current.x, event.clientY - textPress.current.y) > 3) textPress.current.moved = true
        if (props.mode === 'text' || !drag || dragPointer.current?.pointerId !== event.pointerId) return
        const end = pointer(event)
        setDrag({ ...drag, endX: end.x, endY: end.y })
      }} onPointerUp={(event) => {
        if (props.mode === 'text') {
          const press = textPress.current
          textPress.current = null
          const selection = window.getSelection()
          // Let a normal text drag, double click, or link click complete untouched.
          if (!press || press.pointerId !== event.pointerId || press.moved || !viewport
            || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 3
            || (selection && !selection.isCollapsed)) return
          const point = pointer(event)
          // IntersectionObserver can lag one frame after a programmatic jump.
          const annotation = hitAnnotation ? hitAnnotation([point.x, point.y]) : annotationAtPoint(props.annotations, viewport, [point.x, point.y])
          const link = hitLink ? hitLink(viewport, [point.x, point.y]) : linkAtPoint(activeLinks, viewport, [point.x, point.y])
          if (annotation && !(link && (event.ctrlKey || event.metaKey))) props.onAnnotation(annotation.id)
          else if (link) {
            const owner = pdf
            // Wait for the second click so selecting a linked word never jumps first.
            pendingLink.current = setTimeout(() => {
              pendingLink.current = undefined
              if (callbacks.current.pdf === owner && callbacks.current.mode === 'text') followLink(link)
            }, 500)
          } else props.onBackground?.()
          return
        }
        if (!drag || !viewport || dragPointer.current?.pointerId !== event.pointerId) return
        const end = pointer(event)
        clearDrag()
        if (props.mode === 'note') props.onNote(geometry.page, viewport.convertToPdfPoint(end.x, end.y))
        else if (Math.abs(end.x - drag.x) > 3 && Math.abs(end.y - drag.y) > 3) {
          props.onRegion(geometry.page, viewportRectToPdf(viewport, [Math.min(drag.x, end.x), Math.min(drag.y, end.y), Math.max(drag.x, end.x), Math.max(drag.y, end.y)]))
        }
      }} onPointerOver={updateLinkCursor} onPointerLeave={() => { clearLinkCursor(); if (textPress.current) textPress.current.moved = true }}
      onDoubleClick={cancelLinkClick} onPointerCancel={() => { clearDrag(); textPress.current = null; cancelLinkClick(); clearLinkCursor() }}
      onLostPointerCapture={(event) => { if (dragPointer.current?.pointerId === event.pointerId) clearDrag() }}>
      <div className="dsh-pdf-canvas">
        {near && page && viewport && <TileSurface page={page} viewport={viewport} scrollRoot={props.scrollRoot} patchBoxes={patchBoxes}
          onReady={() => { if (pageOwner !== pdf) return; setPaintedAnnotations(sourceAnnotations); setRendered(true) }}
          onError={(message) => { if (pageOwner === pdf) props.onError(message) }} />}
      </div>
      {near && viewport && (pending.length > 0 || overlapping.length > 0) && <svg className="dsh-pdf-annotation-overlay" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        {overlapping.length > 0 && <><defs><clipPath id={patchClipId}>
          {patchBoxes.map(([left, top, right, bottom], index) => <rect key={index} x={left} y={top} width={right - left} height={bottom - top} />)}
        </clipPath></defs><g clipPath={`url(#${patchClipId})`}>
          {overlapping.map(annotation => <PendingMarkup key={annotation.id} annotation={annotation} viewport={viewport} />)}
        </g></>}
        {pending.map((annotation) => <PendingMarkup key={annotation.id} annotation={annotation} viewport={viewport} />)}
      </svg>}
      {!rendered && <div className="dsh-pdf-page-loading" role="status">{t('reader.loadingPage')}</div>}
      <div ref={textHost} className="textLayer dsh-pdf-text-layer" data-pdf-text="active" />
      {textActive && !!visibleOcrWords.length && viewport && <div ref={ocrHost} className="dsh-pdf-ocr-layer" data-pdf-text="active">
        {visibleOcrWords.map((word) => <OcrWord key={word.id} word={word} viewport={viewport} />)}
      </div>}
      {near && viewport && props.mode === 'text' && <div className="dsh-pdf-keyboard-links">
        {keyboardLinks.map((link) => {
          const url = safeLinkUrl(link.url)
          if (url && !link.dest && !namedLinkAction(link.action)) return <a key={link.id} href={url} target="_blank" rel="noreferrer noopener">{url}</a>
          return <button key={link.id} type="button" onClick={() => followLink(link)}>{t('reader.internalLink')}</button>
        })}
      </div>}
      {near && viewport && props.mode === 'text' && <div className="dsh-pdf-links">
        {noteMarkers.map((annotation) => <button
          key={annotation.id} className="dsh-pdf-note-marker" style={screenRect(viewport, annotation.rect!)}
          title={annotation.contents || t('reader.note')} aria-label={annotation.contents || t('reader.note')}
          onClick={() => props.onAnnotation(annotation.id)}>▤</button>)}
      </div>}
      {viewport && selected && <svg className="dsh-pdf-annotation-outline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        {annotationPolygons(selected, viewport).map((points, index) => <polygon key={index} points={points.map((point) => point.join(',')).join(' ')} fill="none" stroke="var(--pdf-accent)" strokeWidth="1.5" />)}
      </svg>}
      {!!explanationPolygons.length && <svg className="dsh-pdf-explanation-overlay" width={width} height={height}
        viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        {explanationPolygons.map((points, index) => <polygon key={index} data-pdf-explanation-mark=""
          points={points} />)}
      </svg>}
      {viewport && region && <div className="dsh-pdf-region" style={screenRect(viewport, region.rect)} />}
      {drag && props.mode === 'region' && <div className="dsh-pdf-region" style={{ left: Math.min(drag.x, drag.endX), top: Math.min(drag.y, drag.endY), width: Math.abs(drag.endX - drag.x), height: Math.abs(drag.endY - drag.y) }} />}
    </div>
  </div>
}
