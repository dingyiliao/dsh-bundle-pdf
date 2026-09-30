import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { beginPdfSpan } from '../shared/performance.js'
import { AnnotationMode, type PDFDocumentProxy } from 'pdfjs-dist'
import type { NewPdfAnnotation, PdfAnnotation, PdfAnnotationOperation, PdfPageInfo, PdfRect } from '../core/pdf-types.js'
import type { NavigationPosition } from '../navigation/index.js'
import { mapImageBoxToPdf, mapResultToPdf } from '../ocr/mapping.js'
import type { WorkspaceSnapshot } from '../shared/contracts.js'
import type { ReaderProps } from './contracts.js'
import { ReaderPage } from './ReaderPage.js'
import { VirtualPages } from './experiment/VirtualPages.js'
import { nativeDocument, openNativeDocument } from './native/document.ts'
import { WindowedPages } from './native/WindowedPages.tsx'
import { pageIndexAtOffset, windowLayout } from './native/window-layout.ts'
import { pagePixelToPdfPoint } from './experiment/virtual-page-layout.js'
import { startExperimentalPageWarmup, type PageWarmupHandle } from './experiment/page-warmup.js'
import virtualPagesStyles from './experiment/virtual-pages.css'
import { captureTextSelection, colorFromHex, colorToHex, pdfRectToViewport, overlapFraction, type PageView, type ReaderSelection } from './reader-selection.js'
import { readerLifetime, type OcrPage } from './reader-lifetime.js'
import { joinSearchText } from './reader-search.js'
import { formatAnnotationDate } from './reader-dates.js'
import { FloatingToolbar, visibleReadingBounds } from './FloatingToolbar.js'
import { OverlayScrollbars } from './OverlayScrollbar.js'
import { ScrollablePanel } from './ScrollablePanel.js'
import { capturePdfRegion, type PdfRegionScreenshot } from './reader-screenshot.js'
import { ScreenshotPreview } from './ScreenshotPreview.js'
import { TranslationPanel, type TranslationPanelProps } from './TranslationPanel.js'
import { TranslationService, TranslationError, type TranslationRequest } from '../translation/index.js'
import { ReadingSidebar, type ReadingSidebarSection } from './ReadingSidebar.js'
import { usePdfWheelZoom } from './use-pdf-wheel-zoom.js'
import { usePdfViewportSize } from './use-pdf-viewport-size.js'

interface SearchHit { page: number; text: string; x: number; y: number; source: 'native' | 'ocr' }
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const noAnnotations: PdfAnnotation[] = []
function waitForForegroundCanvas(root: HTMLElement | null, signal: AbortSignal): Promise<void> {
  if (!root || signal.aborted || root.querySelector('.dsh-pdf-canvas canvas')) return Promise.resolve()
  return new Promise((resolve) => {
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      observer.disconnect()
      clearTimeout(timeout)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const observer = new MutationObserver(() => {
      if (root.querySelector('.dsh-pdf-canvas canvas')) finish()
    })
    // Rendering can fail or a hidden reader may never intersect the viewport.
    const timeout = setTimeout(finish, 6000)
    signal.addEventListener('abort', finish, { once: true })
    observer.observe(root, { childList: true, subtree: true })
    if (root.querySelector('.dsh-pdf-canvas canvas')) finish()
  })
}
function groupAnnotations(annotations: readonly PdfAnnotation[]) {
  const grouped = new Map<number, PdfAnnotation[]>()
  for (const annotation of annotations) {
    const page = grouped.get(annotation.page)
    if (page) page.push(annotation)
    else grouped.set(annotation.page, [annotation])
  }
  return grouped
}

export function Reader(props: ReaderProps) {
  const { api, t, settings, sessionId } = props
  const { tab } = props.useTabInfo()
  const dictionary = useSyncExternalStore(props.dictionary.subscribe, props.dictionary.getSnapshot, props.dictionary.getSnapshot)
  const lifetime = readerLifetime(sessionId, tab.id, tab.signal, settings.historyCapacity)
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null)
  const [displayOwner, setDisplayOwner] = useState<{ token: number; content: ReaderProps['content'] } | null>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [pdfAnnotations, setPdfAnnotations] = useState<PdfAnnotation[]>(noAnnotations)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 600, height: 700 })
  const [currentPage, setCurrentPage] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const [zoom, setZoom] = useState(1)
  const [fit, setFit] = useState<'custom' | 'width' | 'page'>('width')
  const [rotation, setRotation] = useState(0)
  const [historyRevision, setHistoryRevision] = useState(0)
  const [mode, setMode] = useState<'text' | 'region' | 'note'>('text')
  const [selection, setSelection] = useState<ReaderSelection | null>(null)
  const [draggingPage, setDraggingPage] = useState<number | null>(null)
  const [screenshot, setScreenshot] = useState<(PdfRegionScreenshot & { page: number; region: PdfRect; revision: number }) | null>(null)
  const [screenshotBusy, setScreenshotBusy] = useState(false)
  const [textCopied, setTextCopied] = useState(false)
  const [translationSelection, setTranslationSelection] = useState<(TranslationPanelProps['selection'] & {
    owner: number; documentId: string; contentVersion: string
  }) | null>(null)
  const [color, setColor] = useState(settings.defaultColor)
  const [sidebarSection, setSidebarSection] = useState<ReadingSidebarSection>('annotations')
  const [sidebarExpanded, setSidebarExpanded] = useState(true)
  const [selectedAnnotation, setSelectedAnnotation] = useState<string>()
  const [pendingAnnotations, setPendingAnnotations] = useState<PdfAnnotation[]>(noAnnotations)
  const [pendingNote, setPendingNote] = useState<NewPdfAnnotation | null>(null)
  const [comment, setComment] = useState('')
  const [commentColor, setCommentColor] = useState(settings.defaultColor)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searched, setSearched] = useState(false)
  const [ocrPages, setOcrPages] = useState<Map<number, OcrPage>>(() => lifetime.ocrPages)
  const [ocrProgress, setOcrProgress] = useState<string | null>(null)
  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const [savePath, setSavePath] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const [target, setTarget] = useState<{ path: string; version: string | null } | null>(null)
  const [targetChecking, setTargetChecking] = useState(false)
  const [reloadConfirm, setReloadConfirm] = useState(false)
  const views = useRef(new Map<number, PageView>())
  const currentSelection = useRef(selection)
  currentSelection.current = selection
  const nativeSelectionRange = useRef<Range | null>(null)
  const selectionCaptureFrame = useRef<number | null>(null)
  const selectionCaptureGeneration = useRef(0)
  const invalidateSelectionCapture = useCallback(() => {
    selectionCaptureGeneration.current++
    if (selectionCaptureFrame.current !== null) cancelAnimationFrame(selectionCaptureFrame.current)
    selectionCaptureFrame.current = null
  }, [])
  useEffect(() => () => invalidateSelectionCapture(), [invalidateSelectionCapture])
  const translationService = useRef<TranslationService | null>(null)
  const translationOwner = useRef(translationSelection)
  translationOwner.current = translationSelection
  const toolsMenu = useRef<HTMLDetailsElement>(null)
  const readerElement = useRef<HTMLDivElement>(null)
  const scrollFrame = useRef<number | undefined>(undefined)
  const screenshotController = useRef<AbortController | null>(null)
  const history = useRef(lifetime.history)
  const captureLatest = useRef<(() => NavigationPosition) | undefined>(undefined)
  const restored = useRef(false)
  const navigationLock = useRef(false)
  const operationLock = useRef(false)
  const [navigating, setNavigating] = useState(false)
  const activePdf = useRef<{ document: PDFDocumentProxy; bytes: Uint8Array; dispose(): Promise<void> } | null>(null)
  const warmup = useRef<PageWarmupHandle | null>(null)
  const previewListeners = useRef(new Set<() => void>())
  const warmupResumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const warmupBusy = useRef(busy)
  warmupBusy.current = busy
  const ocrController = useRef<AbortController | null>(null)
  const searchSequence = useRef(0)
  const ownerSequence = useRef(0)
  const state = useRef({ snapshot, scrollRoot, rotation, zoom, fit, size, currentPage })
  state.current = { snapshot, scrollRoot, rotation, zoom, fit, size, currentPage }
  const callbacks = useRef(props)
  callbacks.current = props
  void historyRevision

  const subscribePreviews = useCallback((listener: () => void) => {
    previewListeners.current.add(listener)
    return () => { previewListeners.current.delete(listener) }
  }, [])
  const notifyPreviews = useCallback(() => {
    for (const listener of previewListeners.current) listener()
  }, [])
  const pauseWarmupForInteraction = useCallback(() => {
    warmup.current?.pause()
    if (warmupResumeTimer.current) clearTimeout(warmupResumeTimer.current)
    warmupResumeTimer.current = setTimeout(() => {
      warmupResumeTimer.current = null
      if (!warmupBusy.current) warmup.current?.resume()
    }, 600)
  }, [])
  useEffect(() => () => {
    if (warmupResumeTimer.current) clearTimeout(warmupResumeTimer.current)
  }, [])
  useEffect(() => {
    if (busy) warmup.current?.pause()
    else if (!warmupResumeTimer.current) warmup.current?.resume()
  }, [busy])
  const showSidebar = useCallback((section: ReadingSidebarSection) => {
    setSidebarSection(section); setSidebarExpanded(true)
  }, [])

  const notifyError = useCallback((value: unknown) => {
    const needsPassword = value instanceof Error && (('code' in value && value.code === 'password-required') || value.name === 'PasswordException')
    const message = needsPassword ? callbacks.current.t('reader.passwordRequired') : value instanceof Error ? value.message : String(value)
    setError(message)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const token = ++ownerSequence.current
    invalidateSelectionCapture()
    const ownerContent = props.content
    screenshotController.current?.abort()
    translationService.current?.setSource(undefined)
    setTranslationSelection(null)
    nativeSelectionRange.current = null
    setScreenshot(null)
    setSelection(null)
    setDraggingPage(null)
    setMode('text')
    setDisplayOwner(null)
    setSelectedAnnotation(undefined)
    setPendingNote(null)
    setPendingAnnotations(noAnnotations)
    setComment('')
    const stop = () => controller.abort()
    tab.signal.addEventListener('abort', stop, { once: true })
    if (tab.signal.aborted) controller.abort()
    setError('')
    void api.open(sessionId, props.resourceAddress, controller.signal).then((next) => {
      if (!controller.signal.aborted && token === ownerSequence.current) {
        setSnapshot(next)
        setDisplayOwner({ token, content: ownerContent })
      }
    }).catch((failure) => {
      if (!controller.signal.aborted && token === ownerSequence.current) { notifyError(failure); ownerContent.failed() }
    })
    return () => { controller.abort(); tab.signal.removeEventListener('abort', stop) }
  }, [api, sessionId, props.resourceAddress, props.content.revision, tab.signal, notifyError])

  useEffect(() => snapshot ? api.subscribe(snapshot.id, setSnapshot) : undefined, [api, snapshot?.id])

  useEffect(() => {
    if (!snapshot || !displayOwner || displayOwner.token !== ownerSequence.current) return
    if (activePdf.current?.bytes === snapshot.bytes && !!nativeDocument(activePdf.current.document) === (snapshot.reader?.engine === 'native')) {
      const latest = state.current.snapshot
      displayOwner.content.loaded(latest?.bytes === snapshot.bytes ? latest.sourceVersion : snapshot.sourceVersion)
      return
    }
    const controller = new AbortController()
    let accepted = false
    let cancelled = false
    const opening = snapshot.reader?.engine === 'native' && api.native
      ? openNativeDocument(snapshot, sessionId, api.native)
      : callbacks.current.openPdf(snapshot.bytes, controller.signal)
    void opening.then(async (opened) => {
      if (controller.signal.aborted || cancelled || displayOwner.token !== ownerSequence.current) { await opened.dispose(); return }
      accepted = true
      const previous = activePdf.current
      activePdf.current = { ...opened, bytes: snapshot.bytes }
      views.current.clear()
      setPdf(opened.document)
      setPdfAnnotations(snapshot.baselineAnnotations ?? snapshot.document.annotations)
      const latest = state.current.snapshot
      displayOwner.content.loaded(latest?.bytes === snapshot.bytes ? latest.sourceVersion : snapshot.sourceVersion)
      // Give React a frame to cancel the previous canvas/text-layer work.
      await frame()
      await previous?.dispose()
    }).catch((failure) => {
      if (!controller.signal.aborted && displayOwner.token === ownerSequence.current) { notifyError(failure); displayOwner.content.failed() }
    })
    return () => { cancelled = true; if (!accepted) controller.abort() }
  }, [snapshot?.bytes, snapshot?.reader?.engine, snapshot?.reader?.bytesHash, displayOwner?.token, notifyError, api, sessionId])

  useEffect(() => {
    if (!pdf || nativeDocument(pdf) || !snapshot || !scrollRoot || activePdf.current?.document !== pdf || activePdf.current.bytes !== snapshot.bytes) return
    const milestone = new AbortController()
    const handle = startExperimentalPageWarmup({
      bytes: snapshot.bytes, pageCount: snapshot.document.pageCount, signal: tab.signal,
      initialPage: state.current.currentPage, renderPreviews: true,
      startAfter: waitForForegroundCanvas(scrollRoot, milestone.signal),
      onProgress: notifyPreviews,
    })
    warmup.current = handle
    if (warmupBusy.current || warmupResumeTimer.current) handle.pause()
    return () => {
      milestone.abort()
      if (warmup.current === handle) warmup.current = null
      handle.cancel()
      notifyPreviews()
    }
  }, [pdf, snapshot?.bytes, snapshot?.document.pageCount, scrollRoot, tab.signal, notifyPreviews])

  useEffect(() => {
    if (snapshot && displayOwner?.token === ownerSequence.current && activePdf.current?.bytes === snapshot.bytes) {
      displayOwner.content.loaded(snapshot.sourceVersion)
    }
  }, [snapshot?.sourceVersion])

  useLayoutEffect(() => () => {
    // Layout cleanup captures geometry before React detaches the page elements.
    try { lifetime.position = captureLatest.current?.() } catch { /* No page loaded yet. */ }
    void activePdf.current?.dispose()
    activePdf.current = null
    ocrController.current?.abort()
    screenshotController.current?.abort()
    translationService.current?.dispose()
    translationService.current = null
    searchSequence.current++
    if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current)
  }, [])
  useEffect(() => { lifetime.ocrPages = ocrPages }, [ocrPages, lifetime])
  useEffect(() => {
    const configuration = `${settings.ocrEngine}:${settings.ocrLanguages}`
    if (lifetime.ocrConfiguration !== configuration) {
      ocrController.current?.abort()
      setOcrPages(new Map())
      lifetime.ocrConfiguration = configuration
    }
  }, [settings.ocrEngine, settings.ocrLanguages, lifetime])
  useEffect(() => { setColor(settings.defaultColor) }, [settings.defaultColor])

  useEffect(() => {
    if (!snapshot) return
    if (history.current.resetForDocument(snapshot.contentVersion)) {
      setSelectedAnnotation(undefined)
      setPendingNote(null)
      translationService.current?.setSource(undefined)
      setTranslationSelection(null)
      setOcrPages(new Map())
      setHits([])
      setSearched(false)
      searchSequence.current++
      ocrController.current?.abort()
      lifetime.position = undefined
    }
    lifetime.contentVersion = snapshot.contentVersion
    invalidateSelectionCapture()
    setSelection(null)
    nativeSelectionRange.current = null
    setHistoryRevision((n) => n + 1)
  }, [snapshot?.contentVersion])
  useEffect(() => {
    invalidateSelectionCapture()
    setSelection(null)
    nativeSelectionRange.current = null
    setMode('text')
    screenshotController.current?.abort()
    setScreenshot(null)
  }, [snapshot?.revision, snapshot?.id])
  useEffect(() => {
    translationService.current?.cancel()
    setTranslationSelection(null)
  }, [settings.translationEngine, settings.translationSourceLanguage, settings.translationTargetLanguage, settings.translationTimeoutMs])
  useEffect(() => {
    if (!textCopied) return
    const timer = setTimeout(() => setTextCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [textCopied])
  useEffect(() => { setTextCopied(false) }, [selection])
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !toolsMenu.current?.contains(event.target) && toolsMenu.current) toolsMenu.current.open = false
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [])
  useEffect(() => { history.current.setCapacity(settings.historyCapacity); setHistoryRevision((n) => n + 1) }, [settings.historyCapacity])

  useEffect(() => {
    if (!snapshot?.dirty) return
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', leave)
    return () => window.removeEventListener('beforeunload', leave)
  }, [snapshot?.dirty])

  const pageScale = useCallback((page: PdfPageInfo, chosenFit = state.current.fit, chosenZoom = state.current.zoom, chosenRotation = state.current.rotation) => {
    if (chosenFit === 'custom') return chosenZoom
    const rotated = (page.rotation + chosenRotation) % 180 !== 0
    const width = (page.cropBox[2] - page.cropBox[0]) * page.userUnit
    const height = (page.cropBox[3] - page.cropBox[1]) * page.userUnit
    const available = state.current.size
    const widthScale = Math.max(0.1, (available.width - 32) / (rotated ? height : width))
    return chosenFit === 'page' ? Math.min(widthScale, Math.max(0.1, (available.height - 56) / (rotated ? width : height))) : widthScale
  }, [])

  const capture = useCallback((): NavigationPosition => {
    const current = state.current
    if (!current.snapshot || !current.scrollRoot) throw new Error(callbacks.current.t('reader.notReady'))
    const root = current.scrollRoot, outer = root.getBoundingClientRect()
    const available = [...views.current.entries()].sort(([a], [b]) => a - b)
    const pair = available.find(([, view]) => {
      const box = view.element.getBoundingClientRect()
      return box.bottom > outer.top + 4 && box.top < outer.bottom
    })
    if (!pair) {
      // A fast scrollbar jump can precede mounting and loading the target page.
      // Capture that placeholder rather than a stale PageView from elsewhere.
      const numeric = windowLayout(root)
      if (numeric?.length) {
        const item = numeric[pageIndexAtOffset(numeric, root.scrollTop + 40)]
        const geometry = current.snapshot.document.pages[item.page - 1]
        const pageLeft = outer.left + (root.scrollWidth - item.width) / 2 - root.scrollLeft
        const pageTop = outer.top + item.top + 27 - root.scrollTop
        const screenX = Math.max(outer.left, pageLeft), screenY = Math.max(outer.top, pageTop)
        const [x, y] = pagePixelToPdfPoint(geometry, item.scale, current.rotation, screenX - pageLeft, screenY - pageTop)
        return { documentVersion: current.snapshot.contentVersion, page: geometry.page, x, y,
          rotation: current.rotation, fit: current.fit, scale: item.scale,
          viewportAnchor: { x: Math.max(0, Math.min(1, (screenX - outer.left) / outer.width)), y: Math.max(0, Math.min(1, (screenY - outer.top) / outer.height)) } }
      }
      const children = root.children, boundary = root.scrollTop + 40
      let low = 0, high = children.length
      while (low < high) {
        const middle = (low + high) >>> 1
        const element = children[middle] as HTMLElement
        if (element.offsetTop + element.offsetHeight <= boundary) low = middle + 1
        else high = middle
      }
      const placeholder = children[Math.min(low, children.length - 1)] as HTMLElement | undefined
      const number = Number(placeholder?.dataset.pageNumber)
      const geometry = current.snapshot.document.pages[(number || current.currentPage) - 1] ?? current.snapshot.document.pages[0]!
      const stage = placeholder?.querySelector<HTMLElement>(':scope > .dsh-pdf-virtual-stage')
      const stageBounds = stage?.getBoundingClientRect()
      const scale = pageScale(geometry)
      if (stageBounds && stageBounds.width > 0 && stageBounds.height > 0 &&
        stageBounds.right > outer.left && stageBounds.left < outer.right &&
        stageBounds.bottom > outer.top && stageBounds.top < outer.bottom) {
        const screenX = Math.max(stageBounds.left, outer.left)
        const screenY = Math.max(stageBounds.top, outer.top)
        const [x, y] = pagePixelToPdfPoint(geometry, scale, current.rotation,
          screenX - stageBounds.left, screenY - stageBounds.top)
        return { documentVersion: current.snapshot.contentVersion, page: geometry.page,
          x, y, rotation: current.rotation, fit: current.fit, scale,
          viewportAnchor: {
            x: Math.max(0, Math.min(1, (screenX - outer.left) / outer.width)),
            y: Math.max(0, Math.min(1, (screenY - outer.top) / outer.height)),
          } }
      }
      return { documentVersion: current.snapshot.contentVersion, page: geometry.page,
      x: geometry.cropBox[0], y: geometry.cropBox[3], rotation: current.rotation, fit: current.fit,
      scale, viewportAnchor: { x: 0, y: 0 } }
    }
    const [page, view] = pair, box = view.element.getBoundingClientRect()
    const screenX = Math.max(box.left, outer.left), screenY = Math.max(box.top, outer.top)
    const [x, y] = view.viewport.convertToPdfPoint(screenX - box.left, screenY - box.top)
    return { documentVersion: current.snapshot.contentVersion, page, x, y, rotation: current.rotation,
      scale: view.viewport.scale, fit: current.fit,
      viewportAnchor: { x: Math.max(0, Math.min(1, (screenX - outer.left) / outer.width)), y: Math.max(0, Math.min(1, (screenY - outer.top) / outer.height)) } }
  }, [pageScale])

  const applyPosition = useCallback(async (position: NavigationPosition, signal: AbortSignal) => {
    const current = state.current
    if (!current.snapshot || position.documentVersion !== current.snapshot.contentVersion || !current.snapshot.document.pages[position.page - 1]) throw new Error(callbacks.current.t('reader.invalidDestination'))
    const origin = { rotation: current.rotation, zoom: current.zoom, fit: current.fit, page: current.currentPage,
      left: current.scrollRoot?.scrollLeft ?? 0, top: current.scrollRoot?.scrollTop ?? 0 }
    try {
    setRotation(position.rotation)
    setZoom(position.scale)
    setFit(position.fit)
    await frame()
    await frame()
    signal.throwIfAborted()
    const root = state.current.scrollRoot
    const numericPage = root && windowLayout(root)?.[position.page - 1]
    const placeholder = root?.querySelector<HTMLElement>(`[data-page-number="${position.page}"]`)
    if (!root || !placeholder && !numericPage) throw new Error(callbacks.current.t('reader.invalidDestination'))
    if (numericPage) root.scrollTop = numericPage.top
    else root.scrollTop += placeholder!.getBoundingClientRect().top - root.getBoundingClientRect().top
    let view: PageView | undefined
    for (let attempt = 0; attempt < 180; attempt++) {
      signal.throwIfAborted()
      view = views.current.get(position.page)
      const geometry = state.current.snapshot!.document.pages[position.page - 1]
      const expected = pageScale(geometry, position.fit, position.scale, position.rotation)
      if (view && Math.abs(view.viewport.scale - expected) < 0.001 && view.viewport.rotation === ((geometry.rotation + position.rotation) % 360 + 360) % 360) break
      view = undefined
      await frame()
    }
    if (!view) throw new Error(callbacks.current.t('reader.notReady'))
    const [x, y] = view.viewport.convertToViewportPoint(position.x, position.y)
    const bounds = root.getBoundingClientRect(), pageBounds = view.element.getBoundingClientRect()
    root.scrollLeft += pageBounds.left + x - bounds.left - (position.viewportAnchor?.x ?? 0) * bounds.width
    root.scrollTop += pageBounds.top + y - bounds.top - (position.viewportAnchor?.y ?? 0) * bounds.height
    setCurrentPage(position.page)
    setPageInput(String(position.page))
    if (position.page !== origin.page) warmup.current?.prioritize(position.page)
    await frame()
    // Position is semantic; scroll clamping at page/document edges is expected.
    return { ...position, scale: view.viewport.scale }
    } catch (failure) {
      // A failed destination must not strand the reader at its loading placeholder.
      setRotation(origin.rotation); setZoom(origin.zoom); setFit(origin.fit)
      await frame(); await frame()
      if (state.current.scrollRoot) { state.current.scrollRoot.scrollLeft = origin.left; state.current.scrollRoot.scrollTop = origin.top }
      throw failure
    }
  }, [pageScale])
  captureLatest.current = capture

  useEffect(() => {
    if (!pdf || !snapshot || restored.current) return
    restored.current = true
    const saved = lifetime.position
    if (saved && saved.documentVersion === snapshot.contentVersion) {
      void applyPosition(saved, tab.signal).catch((failure) => { if (!tab.signal.aborted) notifyError(failure) })
    }
  }, [pdf, snapshot?.id, applyPosition, lifetime, tab.signal, notifyError])

  const jump = useCallback(async (page: number, options: Partial<NavigationPosition> = {}, remember = true) => {
    if (navigationLock.current) return
    navigationLock.current = true
    setNavigating(true)
    try {
      const current = state.current
      const geometry = current.snapshot?.document.pages[page - 1]
      if (!geometry) throw new Error(callbacks.current.t('reader.invalidDestination'))
      const target: NavigationPosition = { ...capture(), page, x: geometry.cropBox[0], y: geometry.cropBox[3], viewportAnchor: { x: 0, y: 0 }, ...options }
      if (remember) await history.current.jump(target, { capture, apply: applyPosition }, tab.signal)
      else await applyPosition(target, tab.signal)
      setHistoryRevision((n) => n + 1)
    } catch (failure) { if (!tab.signal.aborted) notifyError(failure) }
    finally { navigationLock.current = false; setNavigating(false) }
  }, [capture, applyPosition, notifyError, tab.signal])

  const destination = useCallback(async (value: unknown) => {
    try {
      if (!pdf) return
      const resolved = typeof value === 'string' ? await pdf.getDestination(value) : value
      if (!Array.isArray(resolved) || resolved.length < 2) throw new Error(t('reader.invalidDestination'))
      const pageIndex = typeof resolved[0] === 'number' ? resolved[0] : await pdf.getPageIndex(resolved[0])
      const kind = resolved[1]?.name
      const options: Partial<NavigationPosition> = {}
      if (kind === 'XYZ') {
        if (typeof resolved[2] === 'number') options.x = resolved[2]
        if (typeof resolved[3] === 'number') options.y = resolved[3]
        if (typeof resolved[4] === 'number' && resolved[4] > 0) { options.scale = resolved[4]; options.fit = 'custom' }
      } else if (kind === 'Fit' || kind === 'FitB') options.fit = 'page'
      else if (kind === 'FitH' || kind === 'FitBH') { options.fit = 'width'; if (typeof resolved[2] === 'number') options.y = resolved[2] }
      else if (kind === 'FitV' || kind === 'FitBV') {
        const geometry = state.current.snapshot!.document.pages[pageIndex]
        const page = await pdf.getPage(pageIndex + 1)
        const base = page.getViewport({ scale: 1, rotation: (geometry.rotation + state.current.rotation) % 360 })
        options.fit = 'custom'; options.scale = Math.max(0.1, (state.current.size.height - 56) / base.height)
        if (typeof resolved[2] === 'number') options.x = resolved[2]
      } else if (kind === 'FitR') {
        if (![resolved[2], resolved[3], resolved[4], resolved[5]].every(Number.isFinite)) throw new Error(t('reader.invalidDestination'))
        const geometry = state.current.snapshot!.document.pages[pageIndex]
        const page = await pdf.getPage(pageIndex + 1)
        const base = page.getViewport({ scale: 1, rotation: (geometry.rotation + state.current.rotation) % 360 })
        const box = pdfRectToViewport(base, [resolved[2], resolved[3], resolved[4], resolved[5]])
        if (box[2] <= box[0] || box[3] <= box[1]) throw new Error(t('reader.invalidDestination'))
        options.fit = 'custom'; options.scale = Math.max(0.1, Math.min((state.current.size.width - 32) / (box[2] - box[0]), (state.current.size.height - 56) / (box[3] - box[1])))
        const [x, y] = base.convertToPdfPoint(box[0], box[1]); options.x = x; options.y = y
      } else throw new Error(t('reader.invalidDestination'))
      await jump(pageIndex + 1, options)
    } catch (failure) { notifyError(failure) }
  }, [pdf, jump, notifyError, t])

  const act = async (operation: (current: WorkspaceSnapshot) => Promise<WorkspaceSnapshot>) => {
    if (!snapshot || operationLock.current) return
    const owner = ownerSequence.current
    operationLock.current = true
    setBusy(true)
    setError('')
    try {
      const next = await operation(snapshot)
      if (owner !== ownerSequence.current || tab.signal.aborted) return
      setSnapshot(next)
      return next
    }
    catch (failure) { if (owner === ownerSequence.current && !tab.signal.aborted) notifyError(failure) }
    finally { operationLock.current = false; setBusy(false) }
  }
  const change = (operations: PdfAnnotationOperation[]) => act((current) => api.change(sessionId, current.id, current.revision, operations, tab.signal))
  const save = async (path?: string) => {
    if (path && target?.path !== path) { setError(t('reader.targetUnchecked')); return }
    const originalPath = snapshot?.path
    const result = await act((current) => api.save(sessionId, current.id, current.revision, path ? { path, overwrite, expectedTargetVersion: target!.version } : {}, tab.signal))
    if (result) {
      setSaveAsOpen(false); setOverwrite(false)
      if (path && result.path !== originalPath) {
        const encode = (part: string) => encodeURIComponent(part).replace(/%3A/gi, ':')
        const normalized = result.path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
        tab.actions.openResource(`dsh-resource://file/session/${encode(sessionId)}/${normalized.split('/').map(encode).join('/')}`, { replaceTab: true })
      }
    }
  }

  useEffect(() => {
    setTarget(null)
    setOverwrite(false)
    if (!saveAsOpen || !savePath.trim()) { setTargetChecking(false); return }
    const controller = new AbortController()
    setTargetChecking(true)
    const timer = setTimeout(() => {
      void api.inspectTarget(sessionId, savePath, controller.signal).then((result) => {
        if (!controller.signal.aborted) setTarget({ path: savePath, version: result.version })
      }).catch((failure) => { if (!controller.signal.aborted) notifyError(failure) })
        .finally(() => { if (!controller.signal.aborted) setTargetChecking(false) })
    }, 300)
    return () => { clearTimeout(timer); controller.abort() }
  }, [api, sessionId, saveAsOpen, savePath, notifyError])

  const displayAnnotations = useMemo(() => {
    if (!pendingAnnotations.length) return snapshot?.document.annotations ?? noAnnotations
    const combined = new Map((snapshot?.document.annotations ?? []).map((annotation) => [annotation.id, annotation]))
    for (const annotation of pendingAnnotations) if (!combined.has(annotation.id)) combined.set(annotation.id, annotation)
    return [...combined.values()]
  }, [snapshot?.document.annotations, pendingAnnotations])
  const annotationsById = useMemo(() => new Map(displayAnnotations.map(annotation => [annotation.id, annotation])), [displayAnnotations])
  const annotationIndex = useRef(annotationsById)
  annotationIndex.current = annotationsById
  const selected = selectedAnnotation ? annotationsById.get(selectedAnnotation) : undefined
  const commentItems = useMemo(() => (snapshot?.document.annotations ?? noAnnotations)
    .filter(annotation => annotation.supported || (annotation.contents && annotation.subtype !== 'Popup'))
    .map(annotation => ({ annotation, created: annotation.createdAt ? formatAnnotationDate(annotation.createdAt) : undefined,
      modified: annotation.modifiedAt ? formatAnnotationDate(annotation.modifiedAt) : undefined })), [snapshot?.document.annotations])
  useEffect(() => {
    if (!selected) return
    setComment(selected.contents ?? '')
    setCommentColor(colorToHex(selected.color))
  }, [selected?.id, selected?.contents, selected?.color?.join(',')])
  useEffect(() => {
    if (selectedAnnotation && snapshot && !selected) setSelectedAnnotation(undefined)
  }, [snapshot, selected, selectedAnnotation])

  const annotationsByPage = useMemo(() => groupAnnotations(displayAnnotations), [displayAnnotations])
  const renderedAnnotationsByPage = useMemo(() => groupAnnotations(pdfAnnotations), [pdfAnnotations])

  const mark = async (subtype: 'Highlight' | 'Underline' | 'StrikeOut') => {
    if (!snapshot || operationLock.current || snapshot.document.readOnly || !selection || selection.revision !== snapshot.revision || selection.kind !== 'text') return
    const annotations: NewPdfAnnotation[] = selection.fragments.map((fragment) => ({
      id: crypto.randomUUID(), page: fragment.page, subtype, rect: fragment.rect,
      quadPoints: fragment.quadPoints, color: colorFromHex(color),
    }))
    const operations: PdfAnnotationOperation[] = annotations.map((annotation) => ({ type: 'add', annotation }))
    // Give visible feedback immediately while the Host persists the edit.
    // Failed commits remove the preview and leave the authoritative PDF intact.
    setPendingAnnotations(annotations.map((annotation) => ({ ...annotation, flags: 4, supported: true, editable: true })))
    setSelection(null)
    window.getSelection()?.removeAllRanges()
    setSelectedAnnotation(annotations[0]?.id)
    const changed = await change(operations)
    setPendingAnnotations(noAnnotations)
    if (changed) {
      setPendingNote(null)
      if (operations[0]?.type === 'add') setSelectedAnnotation(operations[0].annotation.id)
    }
  }

  const beginNote = (page: number, point: number[]) => {
    if (!snapshot || snapshot.document.readOnly) return
    const bounds = snapshot.document.pages[page - 1].cropBox
    const width = Math.min(20, bounds[2] - bounds[0]), height = Math.min(20, bounds[3] - bounds[1])
    const x = Math.max(bounds[0], Math.min(bounds[2] - width, point[0]))
    const y = Math.max(bounds[1] + height, Math.min(bounds[3], point[1]))
    setPendingNote({ id: crypto.randomUUID(), page, subtype: 'Text', rect: [x, y - height, x + width, y] })
    setSelectedAnnotation(undefined)
    setComment('')
    setCommentColor(color)
    showSidebar('notes')
    setMode('text')
  }

  const runSearch = async (event?: React.FormEvent) => {
    event?.preventDefault()
    if (!pdf || !snapshot || !query.trim()) return
    const sequence = ++searchSequence.current
    const needle = query.trim().toLocaleLowerCase()
    setSearching(true)
    setSearched(false)
    const found: SearchHit[] = []
    const span = beginPdfSpan('client.search', { pageCount: pdf.numPages })
    try {
      for (let number = 1; number <= pdf.numPages; number++) {
        if (sequence !== searchSequence.current || tab.signal.aborted) { span.end('cancelled'); return }
        const ocr = ocrPages.get(number)
        if (ocr) {
          for (const word of ocr.words) if (word.text.toLocaleLowerCase().includes(needle) && word.pdf) {
            found.push({ page: number, text: word.text, x: word.pdf.rect[0], y: word.pdf.rect[3], source: 'ocr' })
          }
          // Phrase queries span OCR word boundaries; return a page-level match as well.
          if (ocr.text.toLocaleLowerCase().includes(needle) && !found.some((hit) => hit.page === number)) {
            const box = snapshot.document.pages[number - 1].cropBox
            found.push({ page: number, text: ocr.text.slice(Math.max(0, ocr.text.toLocaleLowerCase().indexOf(needle) - 30), ocr.text.toLocaleLowerCase().indexOf(needle) + needle.length + 70), x: box[0], y: box[3], source: 'ocr' })
          }
        }
        // The warmup cache can rule out native misses without loading that
        // page. Hits still need TextContent for their PDF coordinates.
        const indexedText = warmup.current?.getText(number)
        if (indexedText === undefined || indexedText.toLocaleLowerCase().includes(needle)) {
          const page = await pdf.getPage(number)
          const content = await page.getTextContent()
          const items = content.items.filter((item): item is Extract<typeof item, { str: string }> => 'str' in item)
          const { text: combined, starts } = joinSearchText(items)
          let offset = 0, index = -1
          while ((index = combined.toLocaleLowerCase().indexOf(needle, offset)) >= 0 && found.length < 500) {
            let itemIndex = starts.findIndex((start) => start > index) - 1
            if (itemIndex < 0) itemIndex = items.length - 1
            const transform = items[itemIndex]?.transform
            const box = snapshot.document.pages[number - 1].cropBox
            found.push({ page: number, text: combined.slice(Math.max(0, index - 30), index + needle.length + 70), x: transform?.[4] ?? box[0], y: transform?.[5] ?? box[3], source: 'native' })
            offset = index + Math.max(1, needle.length)
          }
        }
        if (number % 8 === 0 && sequence === searchSequence.current) { setHits([...found]); await frame() }
        if (found.length >= 500) break
      }
      if (sequence === searchSequence.current) { setHits(found); setSearched(true) }
    } catch (failure) { span.end('error'); if (sequence === searchSequence.current) notifyError(failure) }
    finally { span.end(sequence !== searchSequence.current || tab.signal.aborted ? 'cancelled' : 'ok', { resultCount: found.length }); if (sequence === searchSequence.current) setSearching(false) }
  }

  const recognize = async (requestedRegion?: { page: number; rect: PdfRect }) => {
    if (!pdf || !snapshot || ocrController.current) return
    const controller = new AbortController()
    ocrController.current = controller
    const version = snapshot.contentVersion
    const region = requestedRegion
    const number = region?.page ?? currentPage
    setOcrProgress(t('reader.ocrPreparing'))
    setError('')
    const stop = () => controller.abort()
    tab.signal.addEventListener('abort', stop, { once: true })
    const canvases: HTMLCanvasElement[] = []
    try {
      const page = await pdf.getPage(number)
      controller.signal.throwIfAborted()
      const base = page.getViewport({ scale: 1 })
      const scale = Math.min(2, Math.sqrt(16_000_000 / (base.width * base.height)))
      const viewport = page.getViewport({ scale })
      const full = document.createElement('canvas')
      canvases.push(full)
      full.width = Math.ceil(viewport.width); full.height = Math.ceil(viewport.height)
      const render = page.render({ canvas: full, viewport, annotationMode: AnnotationMode.DISABLE })
      const cancelRender = () => render.cancel()
      controller.signal.addEventListener('abort', cancelRender, { once: true })
      try { await render.promise } finally { controller.signal.removeEventListener('abort', cancelRender) }
      controller.signal.throwIfAborted()
      let image = full, left = 0, top = 0
      if (region) {
        const rectangle = pdfRectToViewport(viewport, region.rect)
        left = Math.max(0, Math.floor(Math.min(rectangle[0], rectangle[2])))
        top = Math.max(0, Math.floor(Math.min(rectangle[1], rectangle[3])))
        image = document.createElement('canvas')
        canvases.push(image)
        image.width = Math.max(1, Math.min(full.width - left, Math.ceil(rectangle[2]) - left))
        image.height = Math.max(1, Math.min(full.height - top, Math.ceil(rectangle[3]) - top))
        image.getContext('2d')!.drawImage(full, left, top, image.width, image.height, 0, 0, image.width, image.height)
      }
      const blob = await new Promise<Blob>((resolve, reject) => image.toBlob((value) => value ? resolve(value) : reject(new Error(t('reader.imageFailed'))), 'image/png'))
      const result = await props.ocr.recognize({ image: blob, width: image.width, height: image.height,
        languages: settings.ocrLanguages.split('+').map((language) => language.trim()).filter(Boolean),
        signal: controller.signal, timeoutMs: settings.ocrTimeoutMs,
        onProgress: (progress) => setOcrProgress(`${t('reader.recognizing')} ${progress.progress === null ? '' : `${Math.round(progress.progress * 100)}%`}`),
      }, { cacheIdentity: { documentId: snapshot.id, contentVersion: version, page: number, region: region?.rect ?? null, renderRevision: `base-no-annotations:${scale}:${page.rotate}` } })
      const imageToPdf = (x: number, y: number) => viewport.convertToPdfPoint(x + left, y + top) as [number, number]
      const mapped = mapResultToPdf(result, imageToPdf)
      if (!controller.signal.aborted && state.current.snapshot?.contentVersion === version) {
        const words = mapped.words.length ? mapped.words : mapped.lines.length ? mapped.lines : mapped.blocks
        const coverage = result.coverage.map((box) => mapImageBoxToPdf(box, imageToPdf).rect)
        const batchId = crypto.randomUUID()
        setOcrPages((previous) => {
          const old = previous.get(number)
          const retained = (old?.words ?? []).filter((word) => !word.pdf || !coverage.some((box) => overlapFraction(word.pdf!.rect, box) > 0.5))
          const merged = [...retained, ...words.map((word) => ({ ...word, id: `${batchId}:${word.id}` }))]
          return new Map(previous).set(number, { words: merged, text: merged.map((word) => word.text).join(' '), engine: result.source.engineId, warnings: result.warnings })
        })
        if (!words.length) setError(t('reader.ocrNoText'))
        else if (result.status === 'partial') setError(t('reader.ocrPartial'))
        setSelection(null)
      }
    } catch (failure) { if (!controller.signal.aborted) notifyError(failure) }
    finally { for (const canvas of canvases) { canvas.width = 0; canvas.height = 0 }; tab.signal.removeEventListener('abort', stop); ocrController.current = null; setOcrProgress(null) }
  }

  const editable = !!snapshot && !snapshot.document.readOnly && !busy
  const hasUnappliedComment = !!pendingNote || (!!selected && (comment !== (selected.contents ?? '') || commentColor !== colorToHex(selected.color)))
  const hasTextSelection = selection?.kind === 'text' && selection.revision === snapshot?.revision
  const registerView = useCallback((number: number, view: PageView | null) => {
    if (view) views.current.set(number, view); else views.current.delete(number)
    state.current.scrollRoot?.dispatchEvent(new Event('pdfviewchange'))
  }, [])
  const scrollRef = useCallback((node: HTMLDivElement | null) => { setScrollRoot(node); props.scrollportRef(node) }, [props.scrollportRef])
  const selectAnnotation = useCallback((id: string) => {
    setPendingNote(null)
    setSelection(null)
    window.getSelection()?.removeAllRanges()
    setSelectedAnnotation(id)
    showSidebar(annotationIndex.current.get(id)?.subtype === 'Text' ? 'notes' : 'annotations')
  }, [showSidebar])
  const clearAnnotation = useCallback(() => { setSelectedAnnotation(undefined); setPendingNote(null) }, [])
  const deleteAnnotation = async () => {
    if (selected?.editable && await change([{ type: 'delete', id: selected.id }])) clearAnnotation()
  }
  const clearSelection = useCallback(() => {
    invalidateSelectionCapture()
    setSelection(null); nativeSelectionRange.current = null
    const browser = window.getSelection(), root = state.current.scrollRoot
    if (browser?.rangeCount && root?.contains(browser.getRangeAt(0).commonAncestorContainer)) browser.removeAllRanges()
  }, [invalidateSelectionCapture])
  const dismissContext = useCallback(() => {
    clearAnnotation(); clearSelection(); setComment(''); setMode('text')
  }, [clearAnnotation, clearSelection])
  useEffect(() => {
    const dismissOutside = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof Node)) return
      // Portaled/floating controls preserve the browser selection while operating
      // on it; a click outside this PDF closes only its contextual UI.
      if (!readerElement.current?.contains(event.target)) dismissContext()
    }
    document.addEventListener('pointerdown', dismissOutside)
    return () => document.removeEventListener('pointerdown', dismissOutside)
  }, [dismissContext])
  const updateScrolledPage = useCallback(() => {
    pauseWarmupForInteraction()
    if (scrollFrame.current !== undefined) return
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = undefined
      const root = state.current.scrollRoot
      if (!root || !state.current.snapshot) return
      const numeric = windowLayout(root)
      if (numeric?.length) {
        const number = numeric[pageIndexAtOffset(numeric, root.scrollTop + 40)].page
        if (number !== state.current.currentPage) { setCurrentPage(number); setPageInput(String(number)) }
        return
      }
      // Page wrappers are ordered direct children with exact DOM heights. Binary
      // search handles long documents and large scroll jumps without scanning P rects.
      const children = root.children
      const boundary = root.scrollTop + 40
      let low = 0, high = children.length
      while (low < high) {
        const middle = (low + high) >>> 1
        const element = children[middle] as HTMLElement
        if (element.offsetTop + element.offsetHeight <= boundary) low = middle + 1
        else high = middle
      }
      const element = children[Math.min(low, children.length - 1)] as HTMLElement | undefined
      const number = Number(element?.dataset.pageNumber)
      if (number > 0 && number !== state.current.currentPage) {
        setCurrentPage(number); setPageInput(String(number)); warmup.current?.prioritize(number)
      }
    })
  }, [pauseWarmupForInteraction])
  const discardChanges = async () => {
    if (operationLock.current) return
    const next = await act(current => api.discard(sessionId, current.id, current.revision, tab.signal))
    if (next) { dismissContext(); setPendingAnnotations(noAnnotations); setSaveAsOpen(false); setReloadConfirm(false); setScreenshot(null) }
  }
  const captureSelection = () => {
    if (mode !== 'text' || !scrollRoot || !snapshot) return
    const next = captureTextSelection(scrollRoot, views.current, snapshot.revision)
    const browserSelection = window.getSelection()
    nativeSelectionRange.current = next && browserSelection?.rangeCount ? browserSelection.getRangeAt(0).cloneRange() : null
    setSelection(next)
    if (next) setSelectedAnnotation(undefined)
  }
  const scheduleCaptureSelection = () => {
    if (selectionCaptureFrame.current !== null) cancelAnimationFrame(selectionCaptureFrame.current)
    const generation = selectionCaptureGeneration.current
    const owner = ownerSequence.current
    const documentId = snapshot?.id, revision = snapshot?.revision
    // Native drag and double-click selection may finish on mouseup, after
    // pointerup. Read the settled range on the next frame.
    selectionCaptureFrame.current = requestAnimationFrame(() => {
      selectionCaptureFrame.current = null
      setDraggingPage(null)
      if (generation !== selectionCaptureGeneration.current || owner !== ownerSequence.current
        || state.current.snapshot?.id !== documentId || state.current.snapshot?.revision !== revision) return
      captureSelection()
    })
  }
  const beginTranslation = () => {
    if (!hasTextSelection || !selection || !snapshot || displayOwner?.token !== ownerSequence.current) return
    translationService.current?.cancel()
    showSidebar('translation')
    setTranslationSelection({ text: selection.text, pages: selection.fragments.map(fragment => fragment.page),
      sourceLanguage: settings.translationSourceLanguage, targetLanguage: settings.translationTargetLanguage,
      owner: ownerSequence.current, documentId: snapshot.id, contentVersion: snapshot.contentVersion })
  }
  const translateSelection = useCallback(async (request: TranslationRequest) => {
    const source = translationOwner.current
    const current = state.current.snapshot
    if (!source || source.owner !== ownerSequence.current || current?.id !== source.documentId || current.contentVersion !== source.contentVersion) {
      throw new TranslationError('stale-result', 'The PDF selection is no longer current.')
    }
    translationService.current ??= new TranslationService(props.translation)
    translationService.current.setSource({ documentId: source.documentId, contentVersion: source.contentVersion })
    return translationService.current.translate({ ...request, timeoutMs: callbacks.current.settings.translationTimeoutMs,
      signal: request.signal ? AbortSignal.any([request.signal, tab.signal]) : tab.signal,
      context: { sessionId, documentId: source.documentId, contentVersion: source.contentVersion, pages: source.pages } })
  }, [props.translation, sessionId, tab.signal])
  const closeTranslation = () => { translationService.current?.cancel(); setTranslationSelection(null) }
  const lookupSelection = async () => {
    const range = nativeSelectionRange.current
    if (!range || range.collapsed || !range.startContainer.isConnected || !range.endContainer.isConnected) {
      notifyError(new Error(t('reader.dictionarySelectionUnavailable')))
      return
    }
    const browserSelection = window.getSelection()
    browserSelection?.removeAllRanges()
    browserSelection?.addRange(range.cloneRange())
    try { await props.dictionary.lookupSelection() }
    catch { notifyError(new Error(t('reader.dictionaryUnavailable'))) }
  }
  const cancelScreenshot = () => {
    screenshotController.current?.abort()
    setScreenshot(null)
    setMode('text')
    clearSelection()
  }
  const beginScreenshot = () => {
    if (!displayOwner || displayOwner.token !== ownerSequence.current) { notifyError(new Error(t('reader.notReady'))); return }
    clearSelection()
    clearAnnotation()
    setScreenshot(null)
    setMode('region')
    if (toolsMenu.current) toolsMenu.current.open = false
  }
  const takeScreenshot = async (page: number, region: { rect: PdfRect; quadPoints: number[] }) => {
    // Screenshot mode is a single action. Text selection resumes immediately.
    setMode('text')
    if (!pdf || !snapshot || screenshotController.current) return
    if (!displayOwner || displayOwner.token !== ownerSequence.current || activePdf.current?.bytes !== snapshot.bytes) { notifyError(new Error(t('reader.notReady'))); return }
    const revision = snapshot.revision
    const owner = displayOwner.token
    const controller = new AbortController()
    screenshotController.current = controller
    const stop = () => controller.abort()
    tab.signal.addEventListener('abort', stop, { once: true })
    if (tab.signal.aborted) controller.abort()
    setSelection({ kind: 'region', revision, text: '', fragments: [{ page, ...region }] })
    setScreenshotBusy(true)
    setError('')
    try {
      const image = await capturePdfRegion(pdf, page, region.rect, {
        rotation, signal: controller.signal,
        annotations: snapshot.document.annotations.filter(annotation => annotation.page === page),
        sourceAnnotations: pdfAnnotations.filter(annotation => annotation.page === page),
      })
      if (!controller.signal.aborted && ownerSequence.current === owner && state.current.snapshot?.id === snapshot.id && state.current.snapshot.revision === revision) {
        setScreenshot({ ...image, page, region: region.rect, revision })
      }
    } catch (failure) {
      if (!controller.signal.aborted) { notifyError(failure); setSelection(null) }
    } finally {
      tab.signal.removeEventListener('abort', stop)
      if (screenshotController.current === controller) { screenshotController.current = null; setScreenshotBusy(false) }
    }
  }
  const copyText = async () => {
    if (!hasTextSelection || !selection) return
    const copiedSelection = selection
    try {
      await navigator.clipboard.writeText(copiedSelection.text)
      if (!tab.signal.aborted && currentSelection.current === copiedSelection) setTextCopied(true)
    }
    catch { notifyError(new Error(t('reader.copyTextFailed'))) }
  }
  const contextualAnchor = () => {
    if (!scrollRoot) return null
    const bounds = visibleReadingBounds(scrollRoot)
    const fragments = hasTextSelection ? selection!.fragments : selected?.rect ? [{ page: selected.page, rect: selected.rect, quadPoints: selected.quadPoints ?? [] }] : []
    let anchor: DOMRect | null = null
    for (const fragment of fragments) {
      const view = views.current.get(fragment.page)
      if (!view) continue
      const pageBounds = view.element.getBoundingClientRect()
      const rectangles: PdfRect[] = []
      for (let index = 0; index + 7 < fragment.quadPoints.length; index += 8) {
        const points = Array.from({ length: 4 }, (_, offset) => view.viewport.convertToViewportPoint(fragment.quadPoints[index + offset * 2], fragment.quadPoints[index + offset * 2 + 1]))
        rectangles.push([Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1])), Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1]))])
      }
      if (!rectangles.length) rectangles.push(pdfRectToViewport(view.viewport, fragment.rect))
      for (const box of rectangles) {
        const rect = new DOMRect(pageBounds.left + box[0], pageBounds.top + box[1], box[2] - box[0], box[3] - box[1])
        if (rect.bottom > bounds.top && rect.top < bounds.bottom && rect.right > bounds.left && rect.left < bounds.right) anchor = rect
      }
    }
    return anchor
  }

  const pageCallbacks = useRef({ destination, jump, beginNote, takeScreenshot })
  pageCallbacks.current = { destination, jump, beginNote, takeScreenshot }
  const pageDestination = useCallback((value: unknown) => { void pageCallbacks.current.destination(value) }, [])
  const pageAction = useCallback((page: number, action: string) => {
    const last = state.current.snapshot?.document.pageCount ?? page
    void pageCallbacks.current.jump(action === 'FirstPage' ? 1 : action === 'LastPage' ? last : action === 'NextPage' ? page + 1 : page - 1)
  }, [])
  const pageNote = useCallback((page: number, point: number[]) => pageCallbacks.current.beginNote(page, point), [])
  const pageRegion = useCallback((page: number, region: Parameters<typeof takeScreenshot>[1]) => { void pageCallbacks.current.takeScreenshot(page, region) }, [])
  const previewForPage = useCallback((page: number) => warmup.current?.getPreviewUrl(page), [])
  const pageElements = useMemo(() => {
    if (!pdf || !snapshot) return null
    const selectedPages = new Set(selection?.fragments.map(fragment => fragment.page))
    const pinnedPages = new Set(selectedPages)
    const selectedTextPages = selection?.kind === 'text' ? selectedPages : undefined
    if (selected) pinnedPages.add(selected.page)
    const Pages = nativeDocument(pdf) ? WindowedPages : VirtualPages
    return <Pages key={`${snapshot.id}:${snapshot.contentVersion}`} pages={snapshot.document.pages}
      rotation={rotation} zoom={zoom} fit={fit} size={size} scrollRoot={scrollRoot} t={t}
      scaleForPage={pageScale} hasOcrText={(page) => !!ocrPages.get(page)?.words.length}
      pinnedPages={pinnedPages} selectedTextPages={selectedTextPages} dragAnchorPage={draggingPage}
      previewForPage={rotation === 0 ? previewForPage : undefined}
      subscribePreviews={subscribePreviews}
      renderPage={(geometry, retainTextLayer) => <ReaderPage key={`${snapshot.id}:${geometry.page}`} pdf={pdf} geometry={geometry}
      scale={pageScale(geometry)} rotation={rotation} mode={mode} t={t} scrollRoot={scrollRoot}
      retainTextLayer={retainTextLayer}
      annotations={annotationsByPage.get(geometry.page) ?? noAnnotations}
      renderedAnnotations={renderedAnnotationsByPage.get(geometry.page) ?? noAnnotations}
      selectedAnnotation={selected?.page === geometry.page ? selected.id : undefined}
      selection={selectedPages.has(geometry.page) ? selection : null} ocrWords={ocrPages.get(geometry.page)?.words}
      onView={registerView} onDestination={pageDestination} onAction={pageAction}
      onAnnotation={selectAnnotation} onNote={pageNote} onRegion={pageRegion} onBackground={dismissContext} onError={notifyError} />} />
  }, [pdf, snapshot?.id, snapshot?.contentVersion, snapshot?.document.pages, rotation, mode, t, scrollRoot, annotationsByPage, renderedAnnotationsByPage,
    selected?.id, selected?.page, selection, draggingPage, ocrPages, zoom, fit, size, pageScale, registerView, pageDestination, pageAction,
    previewForPage, subscribePreviews,
    selectAnnotation, pageNote, pageRegion, dismissContext, notifyError])

  const wheelScale = useCallback((page: number) => {
    const geometry = state.current.snapshot?.document.pages[page - 1]
    return geometry ? pageScale(geometry) : state.current.zoom
  }, [pageScale])
  const applyWheelScale = useCallback((scale: number) => { setFit('custom'); setZoom(scale) }, [])
  usePdfWheelZoom({ root: scrollRoot, enabled: !!pdf && !busy && !navigating, views: views.current,
    getScale: wheelScale, onScale: applyWheelScale, ownerKey: `${snapshot?.id}:${snapshot?.contentVersion}:${rotation}` })
  usePdfViewportSize({ root: scrollRoot, size, onSize: setSize,
    preserveAnchor: !!pdf && fit !== 'custom' && !navigating,
    ownerKey: `${snapshot?.id}:${snapshot?.contentVersion}:${rotation}:${fit}` })
  useEffect(() => {
    if (!scrollRoot) return
    const pauseOnZoom = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) pauseWarmupForInteraction()
    }
    scrollRoot.addEventListener('wheel', pauseOnZoom, { passive: true })
    return () => scrollRoot.removeEventListener('wheel', pauseOnZoom)
  }, [scrollRoot, pauseWarmupForInteraction])

  const annotationLists = useMemo(() => {
    const annotations: React.ReactNode[] = [], notes: React.ReactNode[] = []
    for (const { annotation, created, modified } of commentItems) {
      const row = <button className={`dsh-pdf-comment-item${selectedAnnotation === annotation.id ? ' is-selected' : ''}`} key={annotation.id}
        onClick={() => { selectAnnotation(annotation.id); void jump(annotation.page, annotation.rect ? { x: annotation.rect[0], y: annotation.rect[3] } : {}) }}>
        <strong>{t('reader.page')} {annotation.page} · {annotation.supported ? t(`reader.type.${annotation.subtype}`) : annotation.subtype}</strong>
        <span>{annotation.contents || t('reader.noComment')}</span>
        {annotation.author && <small>{annotation.author}</small>}
        {created && <small>{t('reader.created')} {created}</small>}
        {modified && <small>{t('reader.modified')} {modified}</small>}
      </button>
      const group = annotation.subtype === 'Text' ? notes : annotations
      group.push(row)
    }
    return { annotations, notes }
  }, [commentItems, selectedAnnotation, selectAnnotation, jump, t])

  const renderCommentEditor = () => <div className="dsh-pdf-comment-editor">
    <label>{t('reader.commentText')}<textarea value={comment} disabled={!!selected && !selected.editable} onChange={(event) => setComment(event.target.value)} rows={5} /></label>
    <label>{t('reader.color')}<input type="color" value={commentColor} disabled={!!selected && !selected.editable} onChange={(event) => setCommentColor(event.target.value)} /></label>
    {selected?.readOnlyReason && <p className="dsh-pdf-muted">{t(`reader.reason.${selected.readOnlyReason}`)}</p>}
    <button disabled={!editable || (!!selected && !selected.editable)} onClick={async () => {
      const patch = { contents: comment, color: colorFromHex(commentColor) }
      const next = pendingNote ? await change([{ type: 'add', annotation: { ...pendingNote, ...patch } }]) : selected ? await change([{ type: 'update', id: selected.id, patch }]) : undefined
      if (next && pendingNote) { setSelectedAnnotation(pendingNote.id); setPendingNote(null) }
    }}>{t('reader.applyComment')}</button>
    {pendingNote && <button onClick={() => setPendingNote(null)}>{t('reader.cancel')}</button>}
    {selected && <button disabled={!editable || !selected.editable} onClick={() => void deleteAnnotation()}>{t('reader.delete')}</button>}
  </div>
  const annotationPanels = (notes: boolean) => {
    const items = notes ? annotationLists.notes : annotationLists.annotations
    return <ScrollablePanel className={notes ? 'dsh-pdf-notes' : 'dsh-pdf-comments'} verticalLabel={t('reader.verticalScroll')} horizontalLabel={t('reader.horizontalScroll')}>
      <div className="dsh-pdf-panel-heading"><h3>{t(notes ? 'reader.sidebar.notes' : 'reader.comments')}</h3></div>
      {((notes && pendingNote) || (selected && notes === (selected.subtype === 'Text'))) && renderCommentEditor()}
      {notes && <p className="dsh-pdf-muted">{t('reader.sidebar.notesHint')}</p>}
      {items}
      {!items.length && <p className="dsh-pdf-muted">{t(notes ? 'reader.sidebar.noNotes' : 'reader.noAnnotations')}</p>}
    </ScrollablePanel>
  }

  return <div className="dsh-pdf-reader" ref={readerElement} aria-label={t('reader.title')} onPointerDown={(event) => {
    if (event.button !== 0 || !(event.target instanceof Element) || scrollRoot?.contains(event.target)) return
    if (!event.target.closest('button,a,input,textarea,select,summary,.dsh-pdf-context-toolbar,.dsh-pdf-sidebar-divider,.dsh-pdf-translation-text,.dsh-pdf-translation-original')) dismissContext()
  }} onKeyDown={(event) => {
    if (event.target instanceof Element && event.target.closest('.dsh-pdf-translation-panel')) {
      if (event.key === 'Escape') { event.preventDefault(); closeTranslation() }
      return
    }
    const input = event.target instanceof HTMLElement && event.target.closest('input,textarea,[contenteditable="true"]')
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (editable) void save() }
    if (!input && editable && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      void act((current) => event.shiftKey ? api.redo(sessionId, current.id, current.revision, tab.signal) : api.undo(sessionId, current.id, current.revision, tab.signal))
    }
    if (!input && selected && event.key === 'Delete' && editable && selected.editable) {
      event.preventDefault(); void deleteAnnotation()
    }
    if (!input && event.key === 'Escape') {
      dismissContext(); cancelScreenshot(); closeTranslation()
      if (toolsMenu.current) toolsMenu.current.open = false
    }
  }}>
    <style>{virtualPagesStyles}</style>
    <div className="dsh-pdf-toolbar dsh-pdf-main-toolbar" role="toolbar" aria-label={t('reader.sidebar.toolbar')}>
      <details className="dsh-pdf-tools" ref={toolsMenu} onBlur={(event) => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false
      }}>
        <summary>{t('reader.tools')} ▾</summary>
        <div className="dsh-pdf-tools-menu" role="group" aria-label={t('reader.tools')}>
          <button disabled={!pdf || busy || screenshotBusy} onClick={beginScreenshot}>{t('reader.regionScreenshot')}</button>
          <button disabled={!editable} onClick={() => {
            clearSelection(); clearAnnotation(); setMode('note')
            if (toolsMenu.current) toolsMenu.current.open = false
          }}>{t('reader.note')}</button>
          <button disabled={!pdf || !!ocrProgress} onClick={() => {
            setMode('text'); void recognize()
            if (toolsMenu.current) toolsMenu.current.open = false
          }}>{t('reader.ocrPage')}</button>
          <button disabled={!snapshot || busy} onClick={() => {
            if (snapshot?.dirty || snapshot?.canRedo) setReloadConfirm(true)
            else void act(current => api.reload(sessionId, current.id, current.revision, tab.signal))
            if (toolsMenu.current) toolsMenu.current.open = false
          }}>{t('reader.reload')}</button>
        </div>
      </details>
      <div className="dsh-pdf-toolbar-controls">
      <button disabled={!history.current.canGoBack || busy || navigating} title={`${t('reader.back')} ${history.current.peek()?.page ?? ''}`} onClick={() => {
        if (navigationLock.current) return
        navigationLock.current = true; setNavigating(true)
        void history.current.back({ apply: applyPosition }, tab.signal).then(() => setHistoryRevision((n) => n + 1)).catch(notifyError).finally(() => { navigationLock.current = false; setNavigating(false) })
      }}>← {t('reader.back')}</button>
      <button title={t('reader.previous')} aria-label={t('reader.previous')} disabled={!pdf || navigating || currentPage <= 1} onClick={() => void jump(currentPage - 1, {}, false)}>‹</button>
      <form className="dsh-pdf-page-form" onSubmit={(event) => { event.preventDefault(); void jump(Number(pageInput)) }}>
        <input aria-label={t('reader.page')} inputMode="numeric" value={pageInput} onChange={(event) => setPageInput(event.target.value)} />
        <span>/ {snapshot?.document.pageCount ?? '—'}</span>
      </form>
      <button title={t('reader.next')} aria-label={t('reader.next')} disabled={!pdf || navigating || currentPage >= pdf.numPages} onClick={() => void jump(currentPage + 1, {}, false)}>›</button>
      <select disabled={navigating} aria-label={t('reader.zoom')} value={fit === 'custom' ? String(zoom) : fit} onChange={(event) => {
        if (event.target.value === 'width' || event.target.value === 'page') setFit(event.target.value)
        else { setFit('custom'); setZoom(Number(event.target.value)) }
      }}>
        <option value="width">{t('reader.fitWidth')}</option><option value="page">{t('reader.fitPage')}</option>
        {[0.5, 0.75, 1, 1.25, 1.5, 2, 3].map((value) => <option value={value} key={value}>{Math.round(value * 100)}%</option>)}
        {fit === 'custom' && ![0.5, 0.75, 1, 1.25, 1.5, 2, 3].includes(zoom) && <option value={zoom}>{Math.round(zoom * 100)}%</option>}
      </select>
      <button onClick={() => setRotation((value) => (value + 90) % 360)} disabled={!pdf || navigating} title={t('reader.rotate')}>↻</button>
      <span className="dsh-pdf-toolbar-divider" aria-hidden="true" />
      <button disabled={!snapshot?.canUndo || busy} onClick={() => void act((current) => api.undo(sessionId, current.id, current.revision, tab.signal))} title={t('reader.undo')}>↶</button>
      <button disabled={!snapshot?.canRedo || busy} onClick={() => void act((current) => api.redo(sessionId, current.id, current.revision, tab.signal))} title={t('reader.redo')}>↷</button>
      <button className="dsh-pdf-primary" disabled={!editable || !snapshot?.dirty} onClick={() => void save()}>{t('reader.save')}</button>
      <button disabled={!editable} onClick={() => { setSavePath(snapshot?.path.replace(/\.pdf$/i, '-annotated.pdf') ?? ''); setSaveAsOpen(true) }}>{t('reader.saveAs')}</button>
      <button disabled={!snapshot || busy || (!snapshot.dirty && !snapshot.canRedo && !hasUnappliedComment)} title={t('reader.discardHelp')} onClick={() => void discardChanges()}>{t('reader.discard')}</button>
      </div>
      <span className={snapshot?.dirty ? 'dsh-pdf-status is-dirty' : 'dsh-pdf-status'} title={snapshot?.path} role="status">{busy ? t('reader.working') : snapshot?.document.readOnly ? t('reader.readOnly') : snapshot?.dirty ? t('reader.unsaved') : snapshot ? t('reader.saved') : ''}</span>
    </div>
    {hasTextSelection && mode === 'text' && <FloatingToolbar viewport={scrollRoot} getAnchor={contextualAnchor} label={t('reader.textActions')}>
      <button onClick={() => void copyText()}>{t(textCopied ? 'reader.textCopied' : 'reader.copyText')}</button>
      <button onClick={beginTranslation}>{t('reader.translateSelection')}</button>
      {dictionary.platform === 'darwin' && <button disabled={!dictionary.available}
        title={t(dictionary.available ? 'reader.dictionaryLookupHelp' : 'reader.dictionaryUnavailable')}
        onClick={() => void lookupSelection()}>{t('reader.dictionaryLookup')}</button>}
      <input type="color" aria-label={t('reader.color')} value={color} disabled={!editable} onChange={(event) => setColor(event.target.value)} />
      <button disabled={!editable} onClick={() => void mark('Highlight')}>{t('reader.highlight')}</button>
      <button disabled={!editable} onClick={() => void mark('Underline')}>{t('reader.underline')}</button>
      <button disabled={!editable} onClick={() => void mark('StrikeOut')}>{t('reader.strike')}</button>
      <button disabled={!editable} onClick={() => {
        const fragment = selection?.fragments[0]
        if (fragment) { beginNote(fragment.page, [fragment.rect[0], fragment.rect[3]]); clearSelection() }
      }}>{t('reader.note')}</button>
      <button aria-label={t('reader.clearSelection')} onClick={clearSelection}>×</button>
    </FloatingToolbar>}
    {selected && <FloatingToolbar viewport={scrollRoot} getAnchor={contextualAnchor} label={t('reader.selectedAnnotation')}>
      <span>{t('reader.selectedAnnotation')} · {selected.supported ? t(`reader.type.${selected.subtype}`) : selected.subtype}</span>
      <input type="color" aria-label={t('reader.annotationColor')} value={commentColor} disabled={!editable || !selected.editable} onChange={(event) => setCommentColor(event.target.value)} />
      <button disabled={!editable || !selected.editable || commentColor === colorToHex(selected.color)} onClick={() => void change([{ type: 'update', id: selected.id, patch: { color: colorFromHex(commentColor) } }])}>{t('reader.applyColor')}</button>
      <button disabled={!editable || !selected.editable} onClick={() => void deleteAnnotation()}>{t('reader.delete')}</button>
      <button onClick={() => showSidebar(selected.subtype === 'Text' ? 'notes' : 'annotations')}>{t('reader.commentText')}</button>
      <button onClick={clearAnnotation}>{t('reader.deselectAnnotation')}</button>
    </FloatingToolbar>}
    {snapshot?.document.readOnly && <div className="dsh-pdf-notice">{t(snapshot.document.readOnlyReason === 'encrypted-document' ? 'reader.encryptedReadOnly' : 'reader.signedReadOnly')}</div>}
    {mode === 'note' && <div className="dsh-pdf-notice">{t('reader.placeNote')}<button onClick={() => setMode('text')}>{t('reader.cancel')}</button></div>}
    {mode === 'region' && <div className="dsh-pdf-notice">{t('reader.screenshotHint')}<button onClick={cancelScreenshot}>{t('reader.cancel')}</button></div>}
    {screenshotBusy && <div className="dsh-pdf-notice" role="status">{t('reader.screenshotPreparing')}<button onClick={cancelScreenshot}>{t('reader.cancel')}</button></div>}
    {error && <div className="dsh-pdf-error" role="alert"><span>{error}</span><button aria-label={t('reader.dismiss')} onClick={() => setError('')}>×</button></div>}
    {snapshot?.warning && <div className="dsh-pdf-notice" role="status">{snapshot.warning}</div>}
    {snapshot?.conflict && <div className="dsh-pdf-notice">{t('reader.conflict')}<button onClick={() => setSaveAsOpen(true)}>{t('reader.saveAs')}</button></div>}
    {ocrProgress && <div className="dsh-pdf-notice" role="status">{ocrProgress}<button onClick={() => ocrController.current?.abort()}>{t('reader.cancel')}</button></div>}
    {saveAsOpen && <form className="dsh-pdf-dialog" onSubmit={(event) => { event.preventDefault(); void save(savePath) }}>
      <label>{t('reader.savePath')}<input value={savePath} required onChange={(event) => setSavePath(event.target.value)} /></label>
      <p>{targetChecking ? t('reader.targetChecking') : target?.version ? t('reader.targetExists') : target ? t('reader.targetNew') : t('reader.targetUnchecked')}</p>
      {target?.version && <label><input type="checkbox" checked={overwrite} onChange={(event) => setOverwrite(event.target.checked)} />{t('reader.overwrite')}</label>}
      <button type="submit" disabled={busy || !target || target.path !== savePath || (!!target.version && !overwrite)}>{t('reader.save')}</button><button type="button" onClick={() => setSaveAsOpen(false)}>{t('reader.cancel')}</button>
    </form>}
    {reloadConfirm && <div className="dsh-pdf-dialog"><p>{t('reader.reloadConfirm')}</p>
      <button onClick={() => { void act((current) => api.reload(sessionId, current.id, current.revision, tab.signal)); setReloadConfirm(false) }}>{t('reader.reload')}</button>
      <button onClick={() => setReloadConfirm(false)}>{t('reader.cancel')}</button></div>}
    <div className="dsh-pdf-body">
      <div className="dsh-pdf-content" aria-label={t('reader.sidebar.pdfContent')}>
      <div className="dsh-pdf-scroll" ref={scrollRef} tabIndex={0} onScroll={updateScrolledPage}
        onPointerDown={(event) => {
          if (event.button !== 0 || mode !== 'text' || (event.target instanceof Element && event.target.closest('button,a,input,textarea'))) return
          const wrapper = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-page-number]') : null
          setDraggingPage(wrapper ? Number(wrapper.dataset.pageNumber) : null)
          // Remove the old native Range before browser default selection starts;
          // otherwise pointerup can recapture it after clicking page whitespace.
          if (event.shiftKey) { setSelection(null); nativeSelectionRange.current = null }
          else clearSelection()
          clearAnnotation()
        }}
        onPointerUp={scheduleCaptureSelection} onPointerCancel={() => setDraggingPage(null)} onKeyUp={captureSelection}>
        {!pdf && <div className="dsh-pdf-empty" role="status">{error ? t('reader.cannotOpen') : t('reader.loading')}</div>}
        {pageElements}
      </div>
      <OverlayScrollbars target={scrollRoot} verticalLabel={t('reader.verticalScroll')} horizontalLabel={t('reader.horizontalScroll')} />
      </div>
      <ReadingSidebar activeSection={sidebarSection} onSectionChange={showSidebar} expanded={sidebarExpanded}
        onExpandedChange={setSidebarExpanded} t={t} panels={{
          annotations: annotationPanels(false), notes: annotationPanels(true),
          search: <ScrollablePanel className="dsh-pdf-search-panel" verticalLabel={t('reader.verticalScroll')} horizontalLabel={t('reader.horizontalScroll')}>
            <div className="dsh-pdf-panel-heading"><h3>{t('reader.search')}</h3></div>
            <form onSubmit={event => void runSearch(event)}><input aria-label={t('reader.search')} placeholder={t('reader.searchPlaceholder')} value={query} onChange={event => setQuery(event.target.value)} />
              <button disabled={searching || !query.trim() || !pdf}>{searching ? t('reader.searching') : t('reader.search')}</button></form>
            <p className="dsh-pdf-muted">{t('reader.searchCoverage')}</p>
            {searched && <p>{hits.length ? `${hits.length}${hits.length >= 500 ? '+' : ''} ${t('reader.results')}` : t('reader.noResults')}</p>}
            {hits.map((hit, index) => <button className="dsh-pdf-search-hit" key={index} onClick={() => void jump(hit.page, { x: hit.x, y: hit.y })}>
              <strong>{t('reader.page')} {hit.page} · {hit.source === 'ocr' ? t('reader.ocrText') : t('reader.nativeText')}</strong><span>{hit.text}</span>
            </button>)}
          </ScrollablePanel>,
          translation: translationSelection ? <TranslationPanel selection={translationSelection} translate={translateSelection} onClose={closeTranslation} t={t}
            engineName={settings.translationEngine === 'dsh-model' ? t('reader.translationDshModel')
              : props.translation.list().find(engine => engine.id === settings.translationEngine)?.name ?? settings.translationEngine} />
            : <ScrollablePanel className="dsh-pdf-translation-panel" verticalLabel={t('reader.verticalScroll')} horizontalLabel={t('reader.horizontalScroll')}>
              <div className="dsh-pdf-panel-heading"><h3>{t('reader.sidebar.translation')}</h3></div>
              <p className="dsh-pdf-muted">{t('reader.sidebar.translationHint')}</p>
            </ScrollablePanel>,
        }} />
    </div>
    {screenshot && <ScreenshotPreview image={screenshot} t={t} onError={notifyError} onClose={() => { setScreenshot(null); clearSelection() }}
      onOcr={ocrProgress ? undefined : () => void recognize({ page: screenshot.page, rect: screenshot.region })} />}
  </div>
}

export default Reader
