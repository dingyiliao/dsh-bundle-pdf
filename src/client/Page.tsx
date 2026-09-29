import React, { useEffect, useRef, useState } from 'react'
import { AnnotationMode, TextLayer, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist'
import type { PdfAnnotation, PdfPageInfo, PdfRect } from '../core/pdf-types.js'
import type { PdfOcrTextPart } from '../ocr/mapping.js'
import { viewportRectToPdf, pdfRectToViewport, overlapFraction, type PageView, type PageViewport, type ReaderSelection } from './reader-selection.js'

export interface PageProps {
  pdf: PDFDocumentProxy
  geometry: PdfPageInfo
  scale: number
  rotation: number
  mode: 'text' | 'region' | 'note'
  annotations: PdfAnnotation[]
  selectedAnnotation?: string
  selection: ReaderSelection | null
  ocrWords?: PdfOcrTextPart[]
  scrollRoot: HTMLElement | null
  t(key: string): string
  onView(page: number, view: PageView | null): void
  onDestination(destination: unknown): void
  onNamedAction(action: string): void
  onAnnotation(id: string): void
  onRegion(page: number, geometry: { rect: PdfRect; quadPoints: number[] }): void
  onNote(page: number, point: number[]): void
  onError(message: string): void
}

interface LinkAnnotation { id: string; rect: number[]; dest?: unknown; url?: string; action?: string; }

function screenRect(viewport: PageViewport, rect: readonly number[]) {
  const value = pdfRectToViewport(viewport, rect)
  return { left: Math.min(value[0], value[2]), top: Math.min(value[1], value[3]), width: Math.abs(value[2] - value[0]), height: Math.abs(value[3] - value[1]) }
}

function OcrWord({ word, viewport }: { word: PdfOcrTextPart; viewport: PageViewport }) {
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
  }}><span ref={(node) => {
    if (node) { const natural = node.scrollWidth; node.style.transform = natural ? `scaleX(${width / natural})` : '' }
  }}>{word.text} </span></span>
}

/** Canvas rendering is lazy. Text and native links share the identical PDF.js viewport. */
export function Page(props: PageProps) {
  const { pdf, geometry, scale, rotation, t } = props
  const outer = useRef<HTMLDivElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const canvasHost = useRef<HTMLDivElement>(null)
  const textHost = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  const [page, setPage] = useState<PDFPageProxy | null>(null)
  const [links, setLinks] = useState<LinkAnnotation[]>([])
  const [rendered, setRendered] = useState(false)
  const [nativeBoxes, setNativeBoxes] = useState<PdfRect[]>([])
  const [drag, setDrag] = useState<{ x: number; y: number; endX: number; endY: number } | null>(null)
  const callbacks = useRef(props)
  callbacks.current = props
  const angle = ((geometry.rotation + rotation) % 360 + 360) % 360
  const viewport = page?.getViewport({ scale, rotation: angle })
  const quarterTurn = angle % 180 !== 0
  const baseWidth = (geometry.cropBox[2] - geometry.cropBox[0]) * geometry.userUnit
  const baseHeight = (geometry.cropBox[3] - geometry.cropBox[1]) * geometry.userUnit
  const width = viewport?.width ?? (quarterTurn ? baseHeight : baseWidth) * scale
  const height = viewport?.height ?? (quarterTurn ? baseWidth : baseHeight) * scale

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { root: props.scrollRoot, rootMargin: '900px 0px' })
    if (outer.current) observer.observe(outer.current)
    return () => observer.disconnect()
  }, [props.scrollRoot])

  useEffect(() => {
    if (!near) return
    let active = true
    void pdf.getPage(geometry.page).then(async (loaded) => {
      if (!active) return
      setPage(loaded)
      const annotations = await loaded.getAnnotations({ intent: 'display' })
      if (active) setLinks(annotations.filter((annotation) => annotation.subtype === 'Link').map((annotation) => ({
        id: annotation.id, rect: annotation.rect, dest: annotation.dest, url: annotation.url, action: annotation.action,
      })))
    }).catch((error) => { if (active) callbacks.current.onError(String(error)) })
    return () => { active = false }
  }, [pdf, geometry.page, near])

  useEffect(() => {
    setPage(null)
    setLinks([])
    setRendered(false)
  }, [pdf])

  useEffect(() => {
    if (!page || !surface.current) return
    const nextViewport = page.getViewport({ scale, rotation: angle })
    callbacks.current.onView(geometry.page, { element: surface.current, page, viewport: nextViewport })
    return () => callbacks.current.onView(geometry.page, null)
  }, [page, scale, angle, geometry.page])

  useEffect(() => {
    if (!page || !canvasHost.current || !near) return
    let active = true
    const nextViewport = page.getViewport({ scale, rotation: angle })
    const canvas = document.createElement('canvas')
    // Bound high DPI canvases so zooming a large poster cannot allocate unbounded memory.
    const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(24_000_000 / (nextViewport.width * nextViewport.height)))
    canvas.width = Math.ceil(nextViewport.width * ratio)
    canvas.height = Math.ceil(nextViewport.height * ratio)
    canvas.style.width = `${nextViewport.width}px`
    canvas.style.height = `${nextViewport.height}px`
    canvas.setAttribute('aria-hidden', 'true')
    canvasHost.current.replaceChildren(canvas)
    setRendered(false)
    const task = page.render({ canvas, viewport: nextViewport, transform: [ratio, 0, 0, ratio, 0, 0], annotationMode: AnnotationMode.ENABLE })
    void task.promise.then(() => { if (active) setRendered(true) }).catch((error) => {
      if (active && error?.name !== 'RenderingCancelledException') callbacks.current.onError(String(error))
    })
    return () => { active = false; task.cancel(); canvas.width = 0; canvas.height = 0 }
  }, [page, scale, angle, near])

  useEffect(() => {
    if (!page || !textHost.current) return
    const host = textHost.current
    host.replaceChildren()
    const nextViewport = page.getViewport({ scale, rotation: angle })
    host.style.setProperty('--total-scale-factor', String(scale * geometry.userUnit))
    const layer = new TextLayer({ textContentSource: page.streamTextContent(), container: host, viewport: nextViewport })
    let active = true
    void layer.render().then(() => {
      if (!active || !surface.current) return
      const bounds = surface.current.getBoundingClientRect()
      setNativeBoxes(layer.textDivs.filter((span) => span.textContent?.trim()).map((span) => {
        const box = span.getBoundingClientRect()
        return [box.left - bounds.left, box.top - bounds.top, box.right - bounds.left, box.bottom - bounds.top] as PdfRect
      }))
    }).catch((error) => { if (active && error?.name !== 'AbortException') callbacks.current.onError(String(error)) })
    return () => { active = false; layer.cancel(); host.replaceChildren() }
  }, [page, scale, angle, geometry.userUnit])

  const pointer = (event: React.PointerEvent) => {
    const bounds = surface.current!.getBoundingClientRect()
    return { x: Math.max(0, Math.min(width, event.clientX - bounds.left)), y: Math.max(0, Math.min(height, event.clientY - bounds.top)) }
  }
  const region = props.selection?.kind === 'region' ? props.selection.fragments.find((f) => f.page === geometry.page) : undefined
  const selected = props.annotations.find((annotation) => annotation.id === props.selectedAnnotation)

  return <div ref={outer} className="dsh-pdf-page-wrap" data-page-number={geometry.page}>
    <div className="dsh-pdf-page-label">{t('reader.page')} {geometry.page}{props.ocrWords?.length ? ` · ${t('reader.ocrText')}` : ''}</div>
    <div ref={surface} data-pdf-page={geometry.page} className={`dsh-pdf-page dsh-pdf-mode-${props.mode}`}
      style={{ width, height }} onPointerDown={(event) => {
        if (!viewport || props.mode === 'text' || event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        const start = pointer(event)
        setDrag({ ...start, endX: start.x, endY: start.y })
      }} onPointerMove={(event) => {
        if (!drag) return
        const end = pointer(event)
        setDrag({ ...drag, endX: end.x, endY: end.y })
      }} onPointerUp={(event) => {
        if (!drag || !viewport) return
        const end = pointer(event)
        setDrag(null)
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        if (props.mode === 'note') props.onNote(geometry.page, viewport.convertToPdfPoint(end.x, end.y))
        else if (Math.abs(end.x - drag.x) > 3 && Math.abs(end.y - drag.y) > 3) {
          props.onRegion(geometry.page, viewportRectToPdf(viewport, [Math.min(drag.x, end.x), Math.min(drag.y, end.y), Math.max(drag.x, end.x), Math.max(drag.y, end.y)]))
        }
      }} onPointerCancel={() => setDrag(null)}>
      <div className="dsh-pdf-canvas" ref={canvasHost} />
      {!rendered && <div className="dsh-pdf-page-loading" role="status">{t('reader.loadingPage')}</div>}
      <div ref={textHost} className="textLayer dsh-pdf-text-layer" data-pdf-text="active" />
      {!!props.ocrWords?.length && viewport && <div className="dsh-pdf-ocr-layer" data-pdf-text="active">
        {props.ocrWords.filter((word) => word.pdf && !nativeBoxes.some((box) => overlapFraction(pdfRectToViewport(viewport, word.pdf!.rect), box) > 0.5))
          .map((word) => <OcrWord key={word.id} word={word} viewport={viewport} />)}
      </div>}
      {viewport && props.mode === 'text' && <div className="dsh-pdf-links">
        {links.map((link) => {
          const style = screenRect(viewport, link.rect)
          if (link.dest) return <button key={link.id} className="dsh-pdf-link" style={style} title={t('reader.internalLink')} aria-label={t('reader.internalLink')} onClick={() => props.onDestination(link.dest)} />
          if (link.action && ['NextPage', 'PrevPage', 'FirstPage', 'LastPage'].includes(link.action)) return <button key={link.id} className="dsh-pdf-link" style={style} aria-label={t('reader.internalLink')} onClick={() => props.onNamedAction(link.action!)} />
          if (link.url && /^(https?:|mailto:)/i.test(link.url)) return <a key={link.id} className="dsh-pdf-link" style={style} href={link.url} target="_blank" rel="noreferrer noopener" title={link.url} aria-label={link.url} />
          return null
        })}
        {props.annotations.filter((annotation) => annotation.subtype === 'Text' && annotation.rect).map((annotation) => <button
          key={annotation.id} className="dsh-pdf-note-marker" style={screenRect(viewport, annotation.rect!)}
          title={annotation.contents || t('reader.note')} aria-label={annotation.contents || t('reader.note')}
          onClick={() => props.onAnnotation(annotation.id)}>▤</button>)}
      </div>}
      {viewport && selected?.rect && <div className="dsh-pdf-annotation-focus" style={screenRect(viewport, selected.rect)} />}
      {viewport && region && <div className="dsh-pdf-region" style={screenRect(viewport, region.rect)} />}
      {drag && props.mode === 'region' && <div className="dsh-pdf-region" style={{ left: Math.min(drag.x, drag.endX), top: Math.min(drag.y, drag.endY), width: Math.abs(drag.endX - drag.x), height: Math.abs(drag.endY - drag.y) }} />}
    </div>
  </div>
}
