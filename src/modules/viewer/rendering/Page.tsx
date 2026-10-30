import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PdfAnnotation, PdfFormField, PdfPageInfo, PdfRect } from '../../../core/pdf-types.js'
import type { PdfOcrTextPart } from '../../../ocr/mapping.js'
import { viewportRectToPdf, pdfRectToViewport, overlapFraction, type PageView, type ReaderSelection } from '../model/reader-selection.js'
import { annotationAtPoint, createAnnotationHitTester, createRectHitIndex, nativeAppearancePatchBoxes } from '../model/reader-annotations.js'
import { actionableLink, createLinkHitTester, linkAtPoint, namedLinkAction, safeLinkUrl, type PdfLink } from '../model/reader-links.js'
import { TileSurface } from './TileSurface.js'
import { renderNativeTextLayer } from './text-layer.js'
import type { NativeDocument, NativePage } from './document.js'
import { selectedTextRects } from '../model/selection-highlight.js'
import type { ExplanationExcerpt } from '../../explanation/index.js'
import { PageContextOverlays, PageMarkupOverlay } from './PageOverlays.js'
import { FormWidgets } from './FormWidgets.js'

export interface PageProps {
  pdf: NativeDocument
  geometry: PdfPageInfo
  scale: number
  rotation: number
  mode: 'text' | 'region' | 'note'
  annotations: PdfAnnotation[]
  formFields?: readonly PdfFormField[]
  onFormChange?(fieldId: string, value: string | boolean | string[]): Promise<boolean | void>
  /** Annotation models baked into this immutable native document. */
  renderedAnnotations?: PdfAnnotation[]
  selectedAnnotation?: string
  selection: ReaderSelection | null
  explanationExcerpts?: readonly ExplanationExcerpt[]
  explanationDraft?: { index: number; fragment: ReaderSelection['fragments'][number] }
  onExplanationMark?(id: string, marker: HTMLElement): void
  ocrWords?: PdfOcrTextPart[]
  /** Keep selectable text and its viewport while a selection spans offscreen pages. */
  retainTextLayer?: boolean
  scrollRoot: HTMLElement | null
  t(key: string): string
  onView(page: number, view: PageView | null): void
  onDestination(destination: unknown): void
  onNamedAction(action: string): void
  onAnnotation(id: string, intent?: 'select' | 'comment' | 'note'): void
  onMoveNoteMarker?(id: string, page: number, delta: { x: number; y: number }): Promise<boolean>
  onBackground?(): void
  onRegion(page: number, geometry: { rect: PdfRect; quadPoints: number[] }): void
  onNote(page: number, point: number[]): void
  onError(message: string): void
}

interface LoadedPage { owner: NativeDocument; page: NativePage; links?: PdfLink[] }
const noLinks: PdfLink[] = []
const noAnnotations: PdfAnnotation[] = []
const noOcrWords: PdfOcrTextPart[] = []
const isCancelledNativeRead = (error: unknown) => error !== null && typeof error === 'object'
  && 'name' in error && (error.name === 'AbortError' || error.name === 'AbortException')

/** Native tiles, text and links share the same viewport. */
export function Page(props: PageProps) {
  const { pdf, geometry, scale, rotation, t } = props
  const patchClipId = `dsh-pdf-patch-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const outer = useRef<HTMLDivElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const textHost = useRef<HTMLDivElement>(null)
  const paintedText = useRef<{ owner: NativeDocument; page: NativePage; angle: number; width: number; height: number; boxes: PdfRect[] } | null>(null)
  const selectionHost = useRef<HTMLDivElement>(null)
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
  const patchBoxes = useMemo(() => viewport ? nativeAppearancePatchBoxes(props.annotations, sourceAnnotations, viewport) : [],
    [props.annotations, sourceAnnotations, viewport])

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
    }).catch((error) => { if (active && !isCancelledNativeRead(error)) callbacks.current.onError(String(error)) })
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
    const host = textHost.current
    if (!host) return
    if (!textActive || !page || pageOwner !== pdf) {
      host.replaceChildren()
      host.style.transform = ''
      paintedText.current = null
      setNativeBoxes([])
      return
    }
    const nextViewport = page.getViewport({ scale, rotation: angle })
    const previous = paintedText.current
    if (previous?.owner === pdf && previous.page === page && previous.angle === angle) {
      // Keep the selectable layer in the same PDF coordinates as the old
      // bitmap while text geometry is rebuilt. Repeated resizes always scale
      // from the last painted layer, not from an intermediate CSS transform.
      host.style.width = `${previous.width}px`
      host.style.height = `${previous.height}px`
      host.style.transformOrigin = '0 0'
      host.style.transform = `scale(${nextViewport.width / previous.width}, ${nextViewport.height / previous.height})`
      setNativeBoxes(previous.boxes.map(([left, top, right, bottom]) => [
        left * nextViewport.width / previous.width, top * nextViewport.height / previous.height,
        right * nextViewport.width / previous.width, bottom * nextViewport.height / previous.height,
      ]))
    } else {
      // A different document or rotation cannot reuse old hit targets.
      host.replaceChildren()
      host.style.transform = ''
      paintedText.current = null
      setNativeBoxes([])
    }
    let active = true
    const rebuild = () => {
      void page.getTextContent().then((content) => {
        if (!active || !surface.current) return
        host.style.transform = ''
        host.style.width = `${nextViewport.width}px`
        host.style.height = `${nextViewport.height}px`
        const spans = renderNativeTextLayer(host, content, nextViewport)
        const bounds = surface.current.getBoundingClientRect()
        const boxes = spans.filter((span) => span.textContent?.trim()).map((span) => {
          const box = span.getBoundingClientRect()
          return [box.left - bounds.left, box.top - bounds.top, box.right - bounds.left, box.bottom - bounds.top] as PdfRect
        })
        paintedText.current = { owner: pdf, page, angle, width: nextViewport.width, height: nextViewport.height, boxes }
        setNativeBoxes(boxes)
      }).catch((error) => { if (active && !isCancelledNativeRead(error)) callbacks.current.onError(String(error)) })
    }
    // A drag can resize the viewport every frame. CSS scales the selectable
    // layer immediately; only rebuild thousands of glyph spans after it rests.
    const timer = previous && previous.owner === pdf && previous.page === page && previous.angle === angle
      ? setTimeout(rebuild, 64) : undefined
    if (timer === undefined) rebuild()
    return () => { active = false; if (timer !== undefined) clearTimeout(timer) }
  }, [textActive, pageOwner, pdf, page, scale, angle, geometry.userUnit])

  useEffect(() => {
    const host = textHost.current, overlay = selectionHost.current, pageElement = surface.current
    if (!host || !overlay || !pageElement) return
    if (!textActive || props.mode !== 'text') { overlay.replaceChildren(); return }
    let frame = 0
    const paint = () => {
      frame = 0
      const fragment = document.createDocumentFragment()
      for (const [left, top, right, bottom] of selectedTextRects(host, pageElement)) {
        const box = document.createElement('div')
        box.className = 'dsh-pdf-selection-box'
        box.style.left = `${left}px`
        box.style.top = `${top}px`
        box.style.width = `${right - left}px`
        box.style.height = `${bottom - top}px`
        fragment.append(box)
      }
      overlay.replaceChildren(fragment)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint) }
    const observer = new MutationObserver(schedule)
    observer.observe(host, { childList: true })
    document.addEventListener('selectionchange', schedule)
    schedule()
    return () => {
      observer.disconnect()
      document.removeEventListener('selectionchange', schedule)
      if (frame) cancelAnimationFrame(frame)
      overlay.replaceChildren()
    }
  }, [textActive, props.mode, pdf, scale, angle])

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
  return <div ref={outer} className="dsh-pdf-page-wrap" data-page-number={geometry.page}>
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
      <PageMarkupOverlay near={near} viewport={viewport} width={width} height={height} clipId={patchClipId}
        annotations={props.annotations} paintedAnnotations={paintedAnnotations} patchBoxes={patchBoxes} />
      {!rendered && <div className="dsh-pdf-page-loading" role="status">{t('reader.loadingPage')}</div>}
      <div ref={selectionHost} className="dsh-pdf-selection-overlay" aria-hidden="true" />
      <div ref={textHost} className="textLayer dsh-pdf-text-layer" data-pdf-text="active" />
      {near && viewport && props.formFields?.length && props.onFormChange
        ? <FormWidgets page={geometry.page} viewport={viewport} fields={props.formFields} onChange={props.onFormChange} /> : null}
      <PageContextOverlays near={near} textActive={textActive} viewport={viewport} width={width} height={height}
        pageNumber={geometry.page} mode={props.mode} annotations={props.annotations} selectedAnnotation={props.selectedAnnotation}
        selection={props.selection} explanationExcerpts={props.explanationExcerpts} explanationDraft={props.explanationDraft}
        ocrWords={visibleOcrWords} ocrHost={ocrHost} keyboardLinks={keyboardLinks} drag={drag}
        followLink={followLink} onAnnotation={props.onAnnotation} onMoveNoteMarker={props.onMoveNoteMarker}
        onExplanationMark={props.onExplanationMark} t={t} />
    </div>
  </div>
}
