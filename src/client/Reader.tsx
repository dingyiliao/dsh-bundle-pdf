import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { beginPdfSpan } from '../shared/performance.js'
import type { NewPdfAnnotation, PdfAnnotation, PdfAnnotationOperation, PdfPageInfo, PdfRect } from '../core/pdf-types.js'
import type { NavigationPosition } from '../navigation/index.js'
import type { WorkspaceSnapshot } from '../shared/contracts.js'
import type { ReaderProps } from './contracts.js'
import type { HostOcrAvailability } from './host-ocr-api.js'
import { ReaderPage } from './ReaderPage.js'
import { NativeDocument, openNativeDocument } from './native/document.ts'
import { WindowedPages } from './native/WindowedPages.tsx'
import { pageIndexAtOffset, windowLayout } from './native/window-layout.ts'
import { pagePixelToPdfPoint, READING_TOP_INSET, readingPageProbe, readingSafeTop } from './native/page-layout.js'
import windowedPagesStyles from './windowed-pages.css'
import { captureTextSelection, colorFromHex, colorToHex, pdfRectToViewport, type PageView, type ReaderSelection } from './reader-selection.js'
import { readerLifetime, type OcrPage, type OcrTranscript } from './reader-lifetime.js'
import { joinSearchText, searchItemAtOffset, searchOffsetMap, searchResultExcerpt, SearchTextIndex } from './reader-search.js'
import { formatAnnotationDate } from './reader-dates.js'
import { AnnotationList } from './AnnotationList.js'
import { FloatingToolbar, visibleReadingBounds } from './FloatingToolbar.js'
import { ExplanationTray } from './ExplanationTray.js'
import { addExplanationExcerpt, buildExplanationPrompt, type ExplanationExcerpt } from './explain-mode.js'
import { HighlightColorBar } from './HighlightColorBar.js'
import { OverlayScrollbars } from './OverlayScrollbar.js'
import { ScrollablePanel } from './ScrollablePanel.js'
import { capturePdfRegion, type PdfRegionScreenshot } from './reader-screenshot.js'
import { ScreenshotPreview } from './ScreenshotPreview.js'
import { OcrTranscriptPanel } from './OcrTranscriptPanel.js'
import { TranslationPanel, type TranslationPanelProps } from './TranslationPanel.js'
import { TranslationService, TranslationError, type TranslationRequest } from '../translation/index.js'
import { ReadingSidebar, type ReadingSidebarSection } from './ReadingSidebar.js'
import { usePdfWheelZoom } from './use-pdf-wheel-zoom.js'
import { usePdfViewportSize } from './use-pdf-viewport-size.js'
import { waitForReaderState } from './wait-for-reader-state.js'
import { ToolbarIcon } from './ToolbarIcon.js'

interface SearchHit { page: number; text: string; x?: number; y?: number; source: 'native' | 'ocr' }
type SaveFeedback = 'saving' | 'saved' | 'unsaved'
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const navigationTimeoutMs = 45_000
const isAbortError = (value: unknown) => value instanceof Error && value.name === 'AbortError'
const isStalePdf = (value: unknown) => value instanceof Error && 'code' in value && value.code === 'PDF_STALE_VERSION'
const noAnnotations: PdfAnnotation[] = []
const initialAnnotationColor = '#ffff00'
const readerIdentity = (snapshot: WorkspaceSnapshot) => `${snapshot.id}:${snapshot.reader.bytesHash}:${snapshot.reader.generation}`
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
  const lifetime = readerLifetime(sessionId, tab.id, tab.signal, settings.historyCapacity)
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null)
  const [displayOwner, setDisplayOwner] = useState<{ token: number; content: ReaderProps['content'] } | null>(null)
  const [pdf, setPdf] = useState<NativeDocument | null>(null)
  const [pdfAnnotations, setPdfAnnotations] = useState<PdfAnnotation[]>(noAnnotations)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [saveFeedback, setSaveFeedback] = useState<SaveFeedback | null>(null)
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 600, height: 700 })
  const [currentPage, setCurrentPage] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const [zoom, setZoom] = useState(1)
  const [fit, setFit] = useState<'custom' | 'width' | 'page'>('width')
  const [historyRevision, setHistoryRevision] = useState(0)
  const [mode, setMode] = useState<'text' | 'region' | 'note'>('text')
  const [selection, setSelection] = useState<ReaderSelection | null>(null)
  const [explanation, setExplanation] = useState<{ key: string; excerpts: ExplanationExcerpt[] } | null>(null)
  const [explanationQuestion, setExplanationQuestion] = useState('')
  const [explanationError, setExplanationError] = useState('')
  const [explanationSending, setExplanationSending] = useState(false)
  const [draggingPage, setDraggingPage] = useState<number | null>(null)
  const [screenshot, setScreenshot] = useState<(PdfRegionScreenshot & { page: number; region: PdfRect; revision: number }) | null>(null)
  const [screenshotBusy, setScreenshotBusy] = useState(false)
  const [textCopied, setTextCopied] = useState(false)
  const [translationSelection, setTranslationSelection] = useState<(TranslationPanelProps['selection'] & {
    owner: number; documentId: string; contentVersion: string
  }) | null>(null)
  const [color, setColor] = useState(initialAnnotationColor)
  const [sidebarSection, setSidebarSection] = useState<ReadingSidebarSection>('annotations')
  const [sidebarExpanded, setSidebarExpanded] = useState(true)
  const sidebarExpandedRef = useRef(sidebarExpanded)
  sidebarExpandedRef.current = sidebarExpanded
  const sidebarAutoCollapsed = useRef(false)
  const sidebarNarrow = useRef<boolean | null>(null)
  const [selectedAnnotation, setSelectedAnnotation] = useState<string>()
  const selectedAnnotationRef = useRef(selectedAnnotation)
  selectedAnnotationRef.current = selectedAnnotation
  const [pendingAnnotations, setPendingAnnotations] = useState<PdfAnnotation[]>(noAnnotations)
  const [pendingNote, setPendingNote] = useState<NewPdfAnnotation | null>(null)
  const [comment, setComment] = useState('')
  const [commentColor, setCommentColor] = useState(initialAnnotationColor)
  const [colorPending, setColorPending] = useState(false)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searched, setSearched] = useState(false)
  const [ocrPages, setOcrPages] = useState<Map<number, OcrPage>>(() => lifetime.ocrPages)
  const [ocrAvailability, setOcrAvailability] = useState<HostOcrAvailability | null>(null)
  const [ocrTranscript, setOcrTranscript] = useState<OcrTranscript | null>(() => lifetime.ocrTranscript ?? null)
  const [ocrProgress, setOcrProgress] = useState<string | null>(null)
  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const [saveAsPicking, setSaveAsPicking] = useState(false)
  const [savePath, setSavePath] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const [target, setTarget] = useState<{ path: string; version: string | null } | null>(null)
  const [targetChecking, setTargetChecking] = useState(false)
  const [reloadConfirm, setReloadConfirm] = useState(false)
  const views = useRef(new Map<number, PageView>())
  const currentSelection = useRef(selection)
  currentSelection.current = selection
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
  const readerBody = useRef<HTMLDivElement>(null)
  const scrollFrame = useRef<number | undefined>(undefined)
  const screenshotController = useRef<AbortController | null>(null)
  const history = useRef(lifetime.history)
  const captureLatest = useRef<(() => NavigationPosition) | undefined>(undefined)
  const restored = useRef(false)
  const navigationLock = useRef(false)
  const activeNavigation = useRef<AbortController | null>(null)
  const pendingJump = useRef<{ page: number; options: Partial<NavigationPosition>; remember: boolean } | null>(null)
  const documentNavigation = useRef(new AbortController())
  const operationLock = useRef(false)
  const saveAsPickerLock = useRef(false)
  const saveFeedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveFeedbackOwner = useRef<{ sessionId: string; resourceAddress: string } | null>(null)
  const previousDirtySnapshot = useRef<{ id: string; dirty: boolean } | null>(null)
  const colorChanges = useRef(new Map<string, { owner: number; documentId: string; annotationId: string; color: string }>())
  const colorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const colorFlush = useRef<() => Promise<void>>(async () => {})
  const lastColorWrite = useRef(0)
  const [navigating, setNavigating] = useState(false)
  const [navigationTarget, setNavigationTarget] = useState<{ page: number } | null>(null)
  const activePdf = useRef<{ document: NativeDocument; identity: string; dispose(): Promise<void> } | null>(null)
  const publishedReadingContext = useRef<{ tabId: string; documentId: string; contentVersion: string;
    page: number; leaseId: string } | null>(null)
  const ocrController = useRef<AbortController | null>(null)
  const refreshOcrAvailability = useRef<(() => void) | null>(null)
  const searchSequence = useRef(0)
  const searchIndex = useRef<{ document: NativeDocument; index: SearchTextIndex } | null>(null)
  const ownerSequence = useRef(0)
  const state = useRef({ snapshot, scrollRoot, zoom, fit, size, currentPage })
  state.current = { snapshot, scrollRoot, zoom, fit, size, currentPage }
  const explanationKey = snapshot ? `${sessionId}:${snapshot.id}:${snapshot.contentVersion}` : undefined
  const activeExplanation = explanation?.key === explanationKey ? explanation : null
  const callbacks = useRef(props)
  callbacks.current = props
  void historyRevision

  useEffect(() => {
    if (!tab.visible) {
      ocrController.current?.abort()
      setOcrAvailability(null)
      return
    }
    let active = true
    let request: AbortController | null = null
    const refresh = async () => {
      request?.abort()
      const controller = new AbortController()
      request = controller
      try {
        const value = await props.hostOcr.availability(sessionId, AbortSignal.any([controller.signal, tab.signal]))
        if (active && !controller.signal.aborted) setOcrAvailability(value)
      } catch (cause) {
        if (active && !controller.signal.aborted && !tab.signal.aborted) {
          setOcrAvailability({ status: 'unavailable', reason: cause instanceof Error ? cause.message : t('reader.ocrConnectionUnavailable') })
        }
      }
    }
    refreshOcrAvailability.current = () => { void refresh() }
    void refresh()
    // A model can change without remounting the PDF. The Host remains the only
    // authority; refresh when the app refocuses and occasionally while visible.
    const timer = setInterval(() => { void refresh() }, 15_000)
    window.addEventListener('focus', refresh)
    return () => {
      active = false
      refreshOcrAvailability.current = null
      request?.abort()
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [props.hostOcr, sessionId, tab.visible, tab.signal, t])
  useEffect(() => { if (screenshot) refreshOcrAvailability.current?.() }, [screenshot])

  const showSaveFeedback = useCallback((kind: SaveFeedback | null, durationMs = 2600) => {
    if (saveFeedbackTimer.current !== null) clearTimeout(saveFeedbackTimer.current)
    saveFeedbackTimer.current = null
    setSaveFeedback(kind)
    if (kind && durationMs > 0) saveFeedbackTimer.current = setTimeout(() => {
      saveFeedbackTimer.current = null
      setSaveFeedback(null)
    }, durationMs)
  }, [])
  useEffect(() => () => {
    if (saveFeedbackTimer.current !== null) clearTimeout(saveFeedbackTimer.current)
  }, [])

  const changeSidebarExpanded = useCallback((expanded: boolean) => {
    sidebarAutoCollapsed.current = false
    sidebarExpandedRef.current = expanded
    setSidebarExpanded(expanded)
  }, [])
  const showSidebar = useCallback((section: ReadingSidebarSection) => {
    setSidebarSection(section)
    changeSidebarExpanded(true)
  }, [changeSidebarExpanded])

  useEffect(() => {
    const body = readerBody.current
    if (!body) return
    let focusFrame = 0
    const update = () => {
      // Observe the whole pane: watching the PDF column would expand it when
      // the sidebar closes and make the two states oscillate.
      const narrow = body.clientWidth < 760
      if (sidebarNarrow.current === narrow) return
      // A layout swap while the page field is active would unmount that input
      // and turn an in-progress Enter into a blur/reset of the old page.
      if (narrow && (body.querySelector('.dsh-pdf-sidebar-page-nav input:focus') || navigationLock.current)) return
      sidebarNarrow.current = narrow
      if (narrow && sidebarExpandedRef.current) {
        sidebarAutoCollapsed.current = true
        sidebarExpandedRef.current = false
        setSidebarExpanded(false)
      } else if (!narrow && sidebarAutoCollapsed.current) {
        sidebarAutoCollapsed.current = false
        sidebarExpandedRef.current = true
        setSidebarExpanded(true)
      }
    }
    const afterFocusOut = () => {
      cancelAnimationFrame(focusFrame)
      focusFrame = requestAnimationFrame(update)
    }
    const observer = new ResizeObserver(update)
    observer.observe(body)
    body.addEventListener('focusout', afterFocusOut)
    update()
    return () => {
      observer.disconnect()
      body.removeEventListener('focusout', afterFocusOut)
      cancelAnimationFrame(focusFrame)
    }
  }, [navigating])

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
    setScreenshot(null)
    setSelection(null)
    setDraggingPage(null)
    setMode('text')
    setDisplayOwner(null)
    setSelectedAnnotation(undefined)
    setPendingNote(null)
    setPendingAnnotations(noAnnotations)
    setComment('')
    colorChanges.current.clear()
    if (colorTimer.current !== null) clearTimeout(colorTimer.current)
    colorTimer.current = null
    lastColorWrite.current = 0
    setColorPending(false)
    previousDirtySnapshot.current = null
    if (saveFeedbackOwner.current?.sessionId !== sessionId || saveFeedbackOwner.current.resourceAddress !== props.resourceAddress) {
      saveFeedbackOwner.current = { sessionId, resourceAddress: props.resourceAddress }
      showSaveFeedback(null)
    }
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
  }, [api, sessionId, props.resourceAddress, props.content.revision, tab.signal, notifyError, showSaveFeedback])

  useEffect(() => snapshot ? api.subscribe(snapshot.id, setSnapshot) : undefined, [api, snapshot?.id])

  useEffect(() => {
    if (!snapshot) { previousDirtySnapshot.current = null; return }
    const previous = previousDirtySnapshot.current
    previousDirtySnapshot.current = { id: snapshot.id, dirty: snapshot.dirty }
    if (previous?.id === snapshot.id && !previous.dirty && snapshot.dirty) showSaveFeedback('unsaved')
    else if (previous?.id === snapshot.id && previous.dirty && !snapshot.dirty && saveFeedback === 'unsaved') showSaveFeedback(null)
  }, [snapshot?.id, snapshot?.dirty, saveFeedback, showSaveFeedback])

  useEffect(() => {
    if (!snapshot || !displayOwner || displayOwner.token !== ownerSequence.current) return
    const identity = readerIdentity(snapshot)
    if (activePdf.current?.identity === identity) {
      const latest = state.current.snapshot
      displayOwner.content.loaded(latest && readerIdentity(latest) === identity ? latest.sourceVersion : snapshot.sourceVersion)
      return
    }
    const controller = new AbortController()
    let accepted = false
    let cancelled = false
    const opening = openNativeDocument(snapshot, sessionId, api.native)
    void opening.then(async (opened) => {
      if (controller.signal.aborted || cancelled || displayOwner.token !== ownerSequence.current) { await opened.dispose(); return }
      accepted = true
      const previous = activePdf.current
      activePdf.current = { ...opened, identity }
      searchSequence.current++
      setSearching(false)
      searchIndex.current = null
      views.current.clear()
      setPdf(opened.document)
      setPdfAnnotations(snapshot.baselineAnnotations ?? snapshot.document.annotations)
      const latest = state.current.snapshot
      displayOwner.content.loaded(latest && readerIdentity(latest) === identity ? latest.sourceVersion : snapshot.sourceVersion)
      // Give React a frame to cancel the previous tile and text-layer work.
      await frame()
      await previous?.dispose()
    }).catch((failure) => {
      if (!controller.signal.aborted && displayOwner.token === ownerSequence.current) { notifyError(failure); displayOwner.content.failed() }
    })
    return () => { cancelled = true; if (!accepted) controller.abort() }
  }, [snapshot?.id, snapshot?.reader.bytesHash, snapshot?.reader.generation, displayOwner?.token, notifyError, api, sessionId])

  useEffect(() => {
    if (snapshot && displayOwner?.token === ownerSequence.current && activePdf.current?.identity === readerIdentity(snapshot)) {
      displayOwner.content.loaded(snapshot.sourceVersion)
    }
  }, [snapshot?.sourceVersion])

  const reportReadingContext = useCallback((update: Parameters<NonNullable<ReaderProps['reportReadingContext']>>[0]) => {
    const report = callbacks.current.reportReadingContext
    if (!report) return
    void report(update).catch((failure) => {
      if (!isAbortError(failure)) console.warn('[pdf] Could not synchronize the active reading page', failure)
    })
  }, [])
  const clearPublishedReadingContext = useCallback(() => {
    const previous = publishedReadingContext.current
    if (!previous) return
    publishedReadingContext.current = null
    reportReadingContext({ action: 'clear', sessionId, tabId: previous.tabId, leaseId: previous.leaseId })
  }, [reportReadingContext, sessionId])

  useEffect(() => {
    const ready = props.allowReadingContext && props.reportReadingContext && tab.visible && !tab.signal.aborted
      && snapshot && pdf && activePdf.current?.identity === readerIdentity(snapshot)
      && currentPage >= 1 && currentPage <= snapshot.document.pageCount
    if (!ready) { clearPublishedReadingContext(); return }
    const previous = publishedReadingContext.current
    if (previous && previous.tabId === tab.id && previous.documentId === snapshot.id
      && previous.contentVersion === snapshot.contentVersion) {
      if (previous.page !== currentPage) {
        previous.page = currentPage
        reportReadingContext({ action: 'set', sessionId, tabId: tab.id, leaseId: previous.leaseId,
          documentId: snapshot.id, contentVersion: snapshot.contentVersion, page: currentPage })
      }
      return
    }
    clearPublishedReadingContext()
    const next = { tabId: tab.id, documentId: snapshot.id, contentVersion: snapshot.contentVersion,
      page: currentPage, leaseId: crypto.randomUUID() }
    publishedReadingContext.current = next
    reportReadingContext({ action: 'set', sessionId, ...next })
  }, [props.allowReadingContext, props.reportReadingContext, tab.id, tab.visible, tab.signal,
    snapshot?.id, snapshot?.contentVersion, snapshot?.reader.bytesHash, snapshot?.reader.generation,
    snapshot?.document.pageCount, pdf, currentPage, sessionId, clearPublishedReadingContext, reportReadingContext])

  useEffect(() => {
    if (!tab.visible) return
    // Reassert an unchanged page so a transient disconnect does not leave the
    // Host's deliberately short-lived context expired during a long read.
    const timer = setInterval(() => {
      const current = publishedReadingContext.current
      if (current) reportReadingContext({ action: 'set', sessionId, ...current })
    }, 30_000)
    return () => clearInterval(timer)
  }, [tab.visible, reportReadingContext, sessionId])

  useEffect(() => {
    tab.signal.addEventListener('abort', clearPublishedReadingContext, { once: true })
    return () => {
      tab.signal.removeEventListener('abort', clearPublishedReadingContext)
      clearPublishedReadingContext()
    }
  }, [tab.signal, clearPublishedReadingContext])

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
  useEffect(() => { lifetime.ocrTranscript = ocrTranscript }, [ocrTranscript, lifetime])
  useEffect(() => {
    if (!snapshot) return
    if (history.current.resetForDocument(snapshot.contentVersion)) {
      setSelectedAnnotation(undefined)
      setPendingNote(null)
      translationService.current?.setSource(undefined)
      setTranslationSelection(null)
      setOcrPages(new Map())
      setOcrTranscript(null)
      setHits([])
      setSearched(false)
      searchSequence.current++
      setSearching(false)
      ocrController.current?.abort()
      lifetime.position = undefined
    }
    lifetime.contentVersion = snapshot.contentVersion
    invalidateSelectionCapture()
    setSelection(null)
    setHistoryRevision((n) => n + 1)
  }, [snapshot?.contentVersion])
  useEffect(() => {
    pendingJump.current = null
    activeNavigation.current?.abort()
    documentNavigation.current.abort()
    const controller = new AbortController()
    documentNavigation.current = controller
    return () => controller.abort()
  }, [snapshot?.id, snapshot?.contentVersion, props.content.revision, pdf])
  useEffect(() => {
    invalidateSelectionCapture()
    setSelection(null)
    setMode('text')
    screenshotController.current?.abort()
    setScreenshot(null)
  }, [snapshot?.revision, snapshot?.id])
  useEffect(() => {
    translationService.current?.cancel()
    setTranslationSelection(null)
  }, [settings.translationEngine, settings.translationTimeoutMs])
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
    if (!snapshot?.dirty && !colorPending) return
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', leave)
    return () => window.removeEventListener('beforeunload', leave)
  }, [snapshot?.dirty, colorPending])

  const pageScale = useCallback((page: PdfPageInfo, chosenFit = state.current.fit, chosenZoom = state.current.zoom) => {
    if (chosenFit === 'custom') return chosenZoom
    const rotated = page.rotation % 180 !== 0
    const width = (page.cropBox[2] - page.cropBox[0]) * page.userUnit
    const height = (page.cropBox[3] - page.cropBox[1]) * page.userUnit
    const available = state.current.size
    const widthScale = Math.max(0.1, (available.width - 32) / (rotated ? height : width))
    return chosenFit === 'page' ? Math.min(widthScale, Math.max(0.1, (available.height - READING_TOP_INSET - 16) / (rotated ? width : height))) : widthScale
  }, [])

  const capture = useCallback((): NavigationPosition => {
    const current = state.current
    if (!current.snapshot || !current.scrollRoot) throw new Error(callbacks.current.t('reader.notReady'))
    const root = current.scrollRoot, outer = root.getBoundingClientRect()
    const visibleTop = outer.top + readingSafeTop(outer.height)
    const available = [...views.current.entries()].sort(([a], [b]) => a - b)
    const pair = available.find(([, view]) => {
      const box = view.element.getBoundingClientRect()
      return box.bottom > visibleTop && box.top < outer.bottom
    })
    if (!pair) {
      // A fast scrollbar jump can precede mounting and loading the target page.
      // Capture the numeric layout rather than a stale PageView from elsewhere.
      const numeric = windowLayout(root)
      if (numeric?.length) {
        const item = numeric[pageIndexAtOffset(numeric, root.scrollTop + readingPageProbe(root.clientHeight))]
        const geometry = current.snapshot.document.pages[item.page - 1]
        const pageLeft = outer.left + (root.scrollWidth - item.width) / 2 - root.scrollLeft
        const pageTop = outer.top + item.top + 27 - root.scrollTop
        const screenX = Math.max(outer.left, pageLeft), screenY = Math.max(visibleTop, pageTop)
        const [x, y] = pagePixelToPdfPoint(geometry, item.scale, 0, screenX - pageLeft, screenY - pageTop)
        return { documentVersion: current.snapshot.contentVersion, page: geometry.page, x, y,
          fit: current.fit, scale: item.scale,
          viewportAnchor: { x: Math.max(0, Math.min(1, (screenX - outer.left) / outer.width)), y: Math.max(0, Math.min(1, (screenY - outer.top) / outer.height)) } }
      }
      const geometry = current.snapshot.document.pages[current.currentPage - 1] ?? current.snapshot.document.pages[0]!
      return { documentVersion: current.snapshot.contentVersion, page: geometry.page,
        x: geometry.cropBox[0], y: geometry.cropBox[3], fit: current.fit,
        scale: pageScale(geometry), viewportAnchor: { x: 0, y: 0 } }
    }
    const [page, view] = pair, box = view.element.getBoundingClientRect()
    const screenX = Math.max(box.left, outer.left), screenY = Math.max(box.top, visibleTop)
    const [x, y] = view.viewport.convertToPdfPoint(screenX - box.left, screenY - box.top)
    return { documentVersion: current.snapshot.contentVersion, page, x, y,
      scale: view.viewport.scale, fit: current.fit,
      viewportAnchor: { x: Math.max(0, Math.min(1, (screenX - outer.left) / outer.width)), y: Math.max(0, Math.min(1, (screenY - outer.top) / outer.height)) } }
  }, [pageScale])

  const applyPosition = useCallback(async (position: NavigationPosition, signal: AbortSignal) => {
    const current = state.current
    if (!pdf || !current.snapshot || position.documentVersion !== current.snapshot.contentVersion || !current.snapshot.document.pages[position.page - 1]) throw new Error(callbacks.current.t('reader.invalidDestination'))
    const originDocument = current.snapshot
    const documentSignal = documentNavigation.current.signal
    const operationSignal = AbortSignal.any([signal, documentSignal])
    const origin = { zoom: current.zoom, fit: current.fit, page: current.currentPage,
      left: current.scrollRoot?.scrollLeft ?? 0, top: current.scrollRoot?.scrollTop ?? 0 }
    const target = { page: position.page }
    setNavigationTarget(target)
    try {
      // Fit modes derive their scale from the viewport. Writing the captured
      // effective scale into zoom needlessly rebuilds the layout mid-jump.
      if (position.fit === 'custom') setZoom(position.scale)
      setFit(position.fit)
      await frame()
      await frame()
      operationSignal.throwIfAborted()
      const root = state.current.scrollRoot
      if (!root) throw new Error(callbacks.current.t('reader.invalidDestination'))
      const geometry = originDocument.document.pages[position.page - 1]!
      const deadline = performance.now() + navigationTimeoutMs
      const remaining = () => Math.max(0, deadline - performance.now())
      const numericPage = await waitForReaderState(root, 'pdflayoutchange', () => {
        const page = windowLayout(root)?.[position.page - 1]
        return page?.page === position.page && Math.abs(page.scale - pageScale(geometry, position.fit, position.scale)) < 0.001
          ? page : undefined
      }, operationSignal, remaining())
      // A narrow page can be centered outside the horizontal viewport when
      // another page makes the document wide. Reveal it before waiting for its
      // PageView: the page proxy is only mounted after IntersectionObserver sees it.
      const targetLeft = (root.scrollWidth - numericPage.width) / 2
      if (targetLeft + numericPage.width <= root.scrollLeft || targetLeft >= root.scrollLeft + root.clientWidth) {
        root.scrollLeft = Math.max(0, (root.scrollWidth - root.clientWidth) / 2)
      }
      root.scrollTop = numericPage.top
      let pageLoadFailure: unknown
      let pageLoadFailed = false
      // Page also requests this proxy when its virtualized slot mounts. Asking
      // here lets a real getPage failure end navigation immediately.
      void pdf.getPage(position.page).catch((failure) => {
        pageLoadFailure = failure instanceof Error ? failure : new Error(String(failure))
        pageLoadFailed = true
        root.dispatchEvent(new Event('pdfviewchange'))
      })
      // WindowedPages mounts distant pages after the scroll, and Page registers a
      // viewport only after its PDF page proxy resolves. Wait for that signal,
      // not for an arbitrary number of animation frames.
      const view = await waitForReaderState(root, 'pdfviewchange', () => {
        if (pageLoadFailed) throw pageLoadFailure
        const candidate = views.current.get(position.page)
        const expected = pageScale(geometry, position.fit, position.scale)
        return candidate && Math.abs(candidate.viewport.scale - expected) < 0.001
          && candidate.viewport.rotation === ((geometry.rotation % 360) + 360) % 360 ? candidate : undefined
      }, operationSignal, remaining())
      operationSignal.throwIfAborted()
      const [x, y] = view.viewport.convertToViewportPoint(position.x, position.y)
      const bounds = root.getBoundingClientRect(), pageBounds = view.element.getBoundingClientRect()
      root.scrollLeft += pageBounds.left + x - bounds.left - (position.viewportAnchor?.x ?? 0) * bounds.width
      root.scrollTop += pageBounds.top + y - bounds.top - (position.viewportAnchor?.y ?? 0) * bounds.height
      setCurrentPage(position.page)
      setPageInput(String(position.page))
      await frame()
      // Position is semantic; scroll clamping at page/document edges is expected.
      return { ...position, scale: view.viewport.scale }
    } catch (failure) {
      // An obsolete navigation must never restore the scroll position of a new document.
      const canRestore = () => !tab.signal.aborted && !documentSignal.aborted
        && originDocument.id === state.current.snapshot?.id
        && originDocument.contentVersion === state.current.snapshot?.contentVersion
      if (canRestore()) {
        setZoom(origin.zoom); setFit(origin.fit)
        await frame(); await frame()
        if (canRestore() && state.current.scrollRoot) {
          state.current.scrollRoot.scrollLeft = origin.left
          state.current.scrollRoot.scrollTop = origin.top
        }
      }
      operationSignal.throwIfAborted()
      if (failure instanceof Error && failure.name === 'TimeoutError') throw new Error(callbacks.current.t('reader.pageLoadTimeout'), { cause: failure })
      throw failure
    } finally {
      setNavigationTarget((active) => active === target ? null : active)
    }
  }, [pageScale, pdf, tab.signal])
  captureLatest.current = capture

  const jump = useCallback(async (page: number, options: Partial<NavigationPosition> = {}, remember = true): Promise<void> => {
    if (navigationLock.current) {
      // A later bookmark/search/page request supersedes a slow page load.
      pendingJump.current = { page, options, remember }
      activeNavigation.current?.abort()
      return
    }
    const controller = new AbortController()
    activeNavigation.current = controller
    navigationLock.current = true
    setNavigating(true)
    try {
      const current = state.current
      const geometry = current.snapshot?.document.pages[page - 1]
      if (!geometry) throw new Error(callbacks.current.t('reader.invalidDestination'))
      const safeTop = current.scrollRoot ? readingSafeTop(current.scrollRoot.clientHeight) : 0
      const target: NavigationPosition = { ...capture(), page, x: geometry.cropBox[0], y: geometry.cropBox[3],
        viewportAnchor: { x: 0, y: current.scrollRoot ? safeTop / current.scrollRoot.clientHeight : 0 }, ...options }
      const signal = AbortSignal.any([tab.signal, controller.signal])
      if (remember) await history.current.jump(target, { capture, apply: applyPosition }, signal)
      else await applyPosition(target, signal)
      setHistoryRevision((n) => n + 1)
    } catch (failure) { if (!tab.signal.aborted && !isAbortError(failure)) notifyError(failure) }
    finally {
      if (activeNavigation.current === controller) activeNavigation.current = null
      navigationLock.current = false
      const next = pendingJump.current
      pendingJump.current = null
      if (next && !tab.signal.aborted) void jump(next.page, next.options, next.remember)
      else setNavigating(false)
    }
  }, [capture, applyPosition, notifyError, tab.signal])

  useEffect(() => {
    if (!pdf || !snapshot || !scrollRoot || restored.current) return
    restored.current = true
    const saved = lifetime.position
    if (saved && saved.documentVersion === snapshot.contentVersion) {
      // Restoring a tab is navigation too: it must share the jump lock and be
      // superseded by a later user request rather than racing that request.
      void jump(saved.page, saved, false)
    }
  }, [pdf, snapshot?.id, scrollRoot, jump, lifetime])

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
        const base = page.getViewport({ scale: 1, rotation: geometry.rotation })
        options.fit = 'custom'; options.scale = Math.max(0.1, (state.current.size.height - 56) / base.height)
        if (typeof resolved[2] === 'number') options.x = resolved[2]
      } else if (kind === 'FitR') {
        if (![resolved[2], resolved[3], resolved[4], resolved[5]].every(Number.isFinite)) throw new Error(t('reader.invalidDestination'))
        const geometry = state.current.snapshot!.document.pages[pageIndex]
        const page = await pdf.getPage(pageIndex + 1)
        const base = page.getViewport({ scale: 1, rotation: geometry.rotation })
        const box = pdfRectToViewport(base, [resolved[2], resolved[3], resolved[4], resolved[5]])
        if (box[2] <= box[0] || box[3] <= box[1]) throw new Error(t('reader.invalidDestination'))
        options.fit = 'custom'; options.scale = Math.max(0.1, Math.min((state.current.size.width - 32) / (box[2] - box[0]), (state.current.size.height - 56) / (box[3] - box[1])))
        const [x, y] = base.convertToPdfPoint(box[0], box[1]); options.x = x; options.y = y
      } else throw new Error(t('reader.invalidDestination'))
      await jump(pageIndex + 1, options)
    } catch (failure) { notifyError(failure) }
  }, [pdf, jump, notifyError, t])

  const act = async (operation: (current: WorkspaceSnapshot) => Promise<WorkspaceSnapshot>, conflictOnStaleSave = false) => {
    const current = state.current.snapshot
    if (!current || operationLock.current) return
    const owner = ownerSequence.current
    operationLock.current = true
    setBusy(true)
    setError('')
    try {
      const next = await operation(current)
      if (owner !== ownerSequence.current || tab.signal.aborted) return
      state.current.snapshot = next
      setSnapshot(next)
      return next
    }
    catch (failure) {
      if (owner !== ownerSequence.current || tab.signal.aborted) return
      if (conflictOnStaleSave && isStalePdf(failure)) {
        // A stale source is one conflict, not both an error banner and a conflict banner.
        const latest = state.current.snapshot
        if (latest?.id === current.id) {
          const conflicted = { ...latest, conflict: true }
          state.current.snapshot = conflicted
          setSnapshot(conflicted)
        }
      } else notifyError(failure)
    }
    finally { operationLock.current = false; setBusy(false) }
  }
  const change = (operations: PdfAnnotationOperation[]) => act((current) => api.change(sessionId, current.id, current.revision, operations, tab.signal))
  const scheduleColorFlush = (delay: number) => {
    if (colorTimer.current !== null) clearTimeout(colorTimer.current)
    colorTimer.current = setTimeout(() => { colorTimer.current = null; void colorFlush.current() }, delay)
  }
  colorFlush.current = async () => {
    if (operationLock.current) { scheduleColorFlush(50); return }
    const entry = colorChanges.current.entries().next().value
    if (!entry) return
    const [key, queued] = entry
    const current = state.current.snapshot
    const annotation = current?.document.annotations.find((item) => item.id === queued.annotationId)
    if (queued.owner !== ownerSequence.current || current?.id !== queued.documentId || !annotation?.editable) {
      colorChanges.current.delete(key)
    } else if (colorToHex(annotation.color) === queued.color) {
      colorChanges.current.delete(key)
    } else {
      const appliedColor = queued.color
      lastColorWrite.current = Date.now()
      const next = await change([{ type: 'update', id: queued.annotationId, patch: { color: colorFromHex(appliedColor) } }])
      if (!next) {
        if (colorChanges.current.get(key) === queued) {
          colorChanges.current.delete(key)
          if (selectedAnnotationRef.current === queued.annotationId && queued.owner === ownerSequence.current
            && state.current.snapshot?.id === queued.documentId) setCommentColor(colorToHex(annotation.color))
        }
      } else if (colorChanges.current.get(key)?.color === appliedColor) {
        colorChanges.current.delete(key)
      }
    }
    setColorPending(colorChanges.current.size > 0)
    if (colorChanges.current.size) scheduleColorFlush(200)
  }
  const updateAnnotationColor = (nextColor: string) => {
    if (!selected || !snapshot || snapshot.document.readOnly || !selected.editable) return
    setCommentColor(nextColor)
    setColor(nextColor)
    const firstChange = colorChanges.current.size === 0
    const key = `${ownerSequence.current}:${snapshot.id}:${selected.id}`
    colorChanges.current.set(key, { owner: ownerSequence.current, documentId: snapshot.id, annotationId: selected.id, color: nextColor })
    setColorPending(true)
    scheduleColorFlush(firstChange && Date.now() - lastColorWrite.current > 300 ? 0 : 200)
  }
  useEffect(() => () => {
    if (colorTimer.current !== null) clearTimeout(colorTimer.current)
  }, [])
  const save = async (path?: string, confirmedTarget?: { version: string | null; overwrite: boolean }) => {
    const checkedTarget = confirmedTarget ?? (target && target.path === path ? { version: target.version, overwrite } : undefined)
    if (path && !checkedTarget) { setError(t('reader.targetUnchecked')); return }
    const originalPath = state.current.snapshot?.path
    showSaveFeedback('saving', 0)
    let committed: WorkspaceSnapshot | undefined
    const result = await act(async (current) => {
      committed = await api.save(sessionId, current.id, current.revision,
        path ? { path, overwrite: checkedTarget!.overwrite, expectedTargetVersion: checkedTarget!.version } : {}, tab.signal)
      return committed
    },
    !path || path === originalPath)
    // Saving the file can advance the document content revision before its RPC
    // resolves. `act` then discards its snapshot as stale, but the save itself
    // succeeded and still deserves confirmation for this same reader resource.
    const sameResource = saveFeedbackOwner.current?.sessionId === sessionId
      && saveFeedbackOwner.current.resourceAddress === props.resourceAddress && !tab.signal.aborted
    const saved = result ?? (sameResource ? committed : undefined)
    if (saved) {
      showSaveFeedback('saved')
      setSaveAsOpen(false); setOverwrite(false)
      if (path && saved.path !== originalPath) {
        const encode = (part: string) => encodeURIComponent(part).replace(/%3A/gi, ':')
        const normalized = saved.path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
        tab.actions.openResource(`dsh-resource://file/session/${encode(sessionId)}/${normalized.split('/').map(encode).join('/')}`, { replaceTab: true })
      }
    } else if (sameResource) showSaveFeedback(null)
  }

  const beginSaveAs = async () => {
    const current = state.current.snapshot
    if (!current || operationLock.current || saveAsPickerLock.current) return
    const defaultPath = /\.pdf$/i.test(current.path) ? current.path.replace(/\.pdf$/i, '-annotated.pdf') : `${current.path}-annotated.pdf`
    if (!props.pickSavePath) { setSavePath(defaultPath); setSaveAsOpen(true); return }
    const owner = ownerSequence.current
    saveAsPickerLock.current = true
    setSaveAsPicking(true)
    try {
      const path = await props.pickSavePath(defaultPath)
      if (!path || owner !== ownerSequence.current || tab.signal.aborted) return
      setError('')
      const inspected = await api.inspectTarget(sessionId, path, tab.signal)
      if (owner !== ownerSequence.current || tab.signal.aborted) return
      // The OS confirms replacement; the Host still checks this observed version at write time.
      await save(path, { version: inspected.version, overwrite: inspected.version !== null })
    } catch (failure) {
      if (owner === ownerSequence.current && !tab.signal.aborted && !isAbortError(failure)) notifyError(failure)
    } finally {
      saveAsPickerLock.current = false
      if (!tab.signal.aborted) setSaveAsPicking(false)
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
  const selected = selectedAnnotation ? annotationsById.get(selectedAnnotation) : undefined
  const commentItems = useMemo(() => (snapshot?.document.annotations ?? noAnnotations)
    .filter(annotation => annotation.supported || (annotation.contents && annotation.subtype !== 'Popup')), [snapshot?.document.annotations])
  useEffect(() => {
    if (!selected) return
    setComment(selected.contents ?? '')
  }, [selected?.id, selected?.contents])
  useEffect(() => {
    if (!selected) return
    const key = `${ownerSequence.current}:${snapshot?.id}:${selected.id}`
    if (colorChanges.current.has(key)) return
    setCommentColor(colorToHex(selected.color))
  }, [selected?.id, selected?.color?.join(',')])
  useEffect(() => {
    if (selectedAnnotation && snapshot && !selected) setSelectedAnnotation(undefined)
  }, [snapshot, selected, selectedAnnotation])

  const annotationsByPage = useMemo(() => groupAnnotations(displayAnnotations), [displayAnnotations])
  const renderedAnnotationsByPage = useMemo(() => groupAnnotations(pdfAnnotations), [pdfAnnotations])

  const mark = async (subtype: 'Highlight' | 'Underline' | 'StrikeOut', selectedColor = color) => {
    if (!snapshot || operationLock.current || snapshot.document.readOnly || !selection || selection.revision !== snapshot.revision || selection.kind !== 'text') return
    const annotations: NewPdfAnnotation[] = selection.fragments.map((fragment) => ({
      id: crypto.randomUUID(), page: fragment.page, subtype, rect: fragment.rect,
      quadPoints: fragment.quadPoints, color: colorFromHex(selectedColor),
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
    showSidebar('annotations')
    setMode('text')
  }

  const runSearch = async (event?: React.FormEvent) => {
    event?.preventDefault()
    if (!pdf || !snapshot || !query.trim()) return
    const sequence = ++searchSequence.current
    const needle = query.trim().toLocaleLowerCase()
    if (searchIndex.current?.document !== pdf) searchIndex.current = { document: pdf, index: new SearchTextIndex() }
    const textIndex = searchIndex.current.index
    setSearching(true)
    setSearched(false)
    const found: SearchHit[] = []
    const span = beginPdfSpan('client.search', { pageCount: pdf.numPages })
    try {
      for (let number = 1; number <= pdf.numPages; number++) {
        if (sequence !== searchSequence.current || tab.signal.aborted) { span.end('cancelled'); return }
        const ocr = ocrPages.get(number)
        if (ocr) {
          for (const word of ocr.words) if (found.length < 500 && word.text.toLocaleLowerCase().includes(needle) && word.pdf) {
            found.push({ page: number, text: word.text, x: word.pdf.rect[0], y: word.pdf.rect[3], source: 'ocr' })
          }
          // Phrase queries span OCR word boundaries; return a page-level match as well.
          const match = ocr.text.toLocaleLowerCase().indexOf(needle)
          if (match >= 0 && found.length < 500 && !found.some((hit) => hit.page === number)) {
            // A transcript without boxes locates only the page, not the word.
            found.push({ page: number, text: searchResultExcerpt(ocr.text, match, needle.length), source: 'ocr' })
          }
        }
        if (found.length >= 500) break
        if (!textIndex.mayContain(number, needle)) {
          if (number % 8 === 0 && sequence === searchSequence.current) { setHits([...found]); await frame() }
          continue
        }
        const page = await pdf.getPage(number)
        const content = await page.getTextContent()
        const items = content.items.filter((item): item is Extract<typeof item, { str: string }> => 'str' in item)
        const { text: combined, starts } = joinSearchText(items)
        const folded = textIndex.remember(number, combined)
        let offset = 0, index = -1
        let offsetMap: Uint32Array | undefined
        while ((index = folded.indexOf(needle, offset)) >= 0 && found.length < 500) {
          offsetMap ??= searchOffsetMap(combined, folded.length)
          const sourceStart = offsetMap[index]
          const mappedEnd = offsetMap[Math.min(folded.length, index + needle.length)]
          const sourceEnd = mappedEnd > sourceStart ? mappedEnd : sourceStart + (combined.codePointAt(sourceStart)! > 0xffff ? 2 : 1)
          const itemIndex = searchItemAtOffset(starts, sourceStart)
          const transform = items[itemIndex]?.transform
          const box = snapshot.document.pages[number - 1].cropBox
          found.push({ page: number, text: searchResultExcerpt(combined, sourceStart, sourceEnd - sourceStart), x: transform?.[4] ?? box[0], y: transform?.[5] ?? box[3], source: 'native' })
          offset = index + Math.max(1, needle.length)
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
    try {
      const availability = await props.hostOcr.availability(sessionId, controller.signal)
      controller.signal.throwIfAborted()
      setOcrAvailability(availability)
      if (availability.status !== 'available') {
        setError(availability.reason ?? t('reader.ocrUnavailable'))
        return
      }
      setOcrProgress(t('reader.recognizing'))
      const result = await props.hostOcr.recognize({ sessionId, documentId: snapshot.id, page: number,
        ...(region ? { region: region.rect } : {}) }, controller.signal)
      controller.signal.throwIfAborted()
      const current = state.current.snapshot
      if (!current || current.id !== result.documentId || current.contentVersion !== version
          || result.contentVersion !== version || current.revision !== result.revision) {
        setError(t('reader.ocrStale'))
        return
      }
      // The current model backend supplies a transcript but no trustworthy
      // word boxes. Keep it visible and copyable without fabricating a PDF layer.
      setOcrTranscript({ result, ...(region ? { region: region.rect } : {}) })
      if (!region) setOcrPages(previous => {
        const next = new Map(previous)
        next.delete(number)
        next.set(number, { words: [], text: result.text, engine: result.source.backendId, warnings: result.warnings })
        while (next.size > 64) next.delete(next.keys().next().value!)
        return next
      })
      showSidebar('ocr')
      setSelection(null)
    } catch (failure) { if (!controller.signal.aborted) notifyError(failure) }
    finally { tab.signal.removeEventListener('abort', stop); ocrController.current = null; setOcrProgress(null) }
  }

  const editable = !!snapshot && !snapshot.document.readOnly && !busy && !saveAsPicking && !colorPending
  const hasUnappliedComment = !!pendingNote || (!!selected && comment !== (selected.contents ?? ''))
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
    showSidebar('annotations')
  }, [showSidebar])
  const clearAnnotation = useCallback(() => { setSelectedAnnotation(undefined); setPendingNote(null) }, [])
  const deleteAnnotation = async () => {
    if (selected?.editable && await change([{ type: 'delete', id: selected.id }])) clearAnnotation()
  }
  const clearSelection = useCallback(() => {
    invalidateSelectionCapture()
    setSelection(null)
    const browser = window.getSelection(), root = state.current.scrollRoot
    if (browser?.rangeCount && root?.contains(browser.getRangeAt(0).commonAncestorContainer)) browser.removeAllRanges()
  }, [invalidateSelectionCapture])
  useEffect(() => {
    if (explanation && explanation.key !== explanationKey) {
      setExplanation(null)
      setExplanationQuestion('')
      setExplanationError('')
      setExplanationSending(false)
    }
  }, [explanation, explanationKey])
  const cancelExplanation = () => {
    setExplanation(null)
    setExplanationQuestion('')
    setExplanationError('')
    clearSelection()
    if (toolsMenu.current) toolsMenu.current.open = false
  }
  const startExplanation = () => {
    if (!explanationKey || !props.promptExplanation || props.allowReadingContext === false) return
    setMode('text')
    setExplanation({ key: explanationKey, excerpts: [] })
    setExplanationQuestion('')
    setExplanationError('')
    clearSelection()
    if (toolsMenu.current) toolsMenu.current.open = false
  }
  const addSelectionToExplanation = () => {
    if (!hasTextSelection || !selection || !explanationKey || explanationSending || !props.promptExplanation
      || props.allowReadingContext === false) return
    const current = activeExplanation ?? { key: explanationKey, excerpts: [] }
    const next = addExplanationExcerpt(current.excerpts, selection, crypto.randomUUID())
    if (!next.ok) {
      setExplanationError(t(next.reason === 'empty' ? 'reader.explain.emptySelection' : `reader.explain.${next.reason}`))
      return
    }
    setExplanation({ key: explanationKey, excerpts: next.excerpts })
    setExplanationError('')
    clearSelection()
  }
  const submitExplanation = async () => {
    if (!activeExplanation?.excerpts.length || !snapshot || !props.promptExplanation || explanationSending) return
    const key = activeExplanation.key
    const prompt = buildExplanationPrompt(snapshot.path, activeExplanation.excerpts, explanationQuestion, t)
    setExplanationSending(true)
    setExplanationError('')
    try {
      await props.promptExplanation(prompt, tab.signal)
      const current = state.current.snapshot
      if (current && `${sessionId}:${current.id}:${current.contentVersion}` === key && !tab.signal.aborted) {
        setExplanation(draft => draft?.key === key ? null : draft)
        setExplanationQuestion('')
        clearSelection()
      }
    } catch (failure) {
      if (!tab.signal.aborted) setExplanationError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (!tab.signal.aborted) setExplanationSending(false)
    }
  }
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
    if (scrollFrame.current !== undefined) return
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = undefined
      const root = state.current.scrollRoot
      if (!root || !state.current.snapshot) return
      const numeric = windowLayout(root)
      if (!numeric?.length) return
      const number = numeric[pageIndexAtOffset(numeric, root.scrollTop + readingPageProbe(root.clientHeight))].page
      if (number !== state.current.currentPage) { setCurrentPage(number); setPageInput(String(number)) }
    })
  }, [])
  const discardChanges = async () => {
    if (operationLock.current) return
    const next = await act(current => api.discard(sessionId, current.id, current.revision, tab.signal))
    if (next) { showSaveFeedback(null); dismissContext(); setPendingAnnotations(noAnnotations); setSaveAsOpen(false); setReloadConfirm(false); setScreenshot(null) }
  }
  const captureSelection = () => {
    if (mode !== 'text' || !scrollRoot || !snapshot) return
    const next = captureTextSelection(scrollRoot, views.current, snapshot.revision)
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
      targetLanguage: settings.translationTargetLanguage,
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
    if (!displayOwner || displayOwner.token !== ownerSequence.current || activePdf.current?.identity !== readerIdentity(snapshot)) { notifyError(new Error(t('reader.notReady'))); return }
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
        signal: controller.signal,
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
  const pageElements = useMemo(() => {
    if (!pdf || !snapshot) return null
    const selectedPages = new Set(selection?.fragments.map(fragment => fragment.page))
    const pinnedPages = new Set(selectedPages)
    const selectedTextPages = new Set(selection?.kind === 'text' ? selectedPages : [])
    if (selected) pinnedPages.add(selected.page)
    // A distant destination must register its PageView even before the
    // IntersectionObserver sees it; the jump uses that view to finish scrolling.
    if (navigationTarget) {
      pinnedPages.add(navigationTarget.page)
      selectedTextPages.add(navigationTarget.page)
    }
    return <WindowedPages key={snapshot.id} pages={snapshot.document.pages}
      rotation={0} zoom={zoom} fit={fit} size={size} scrollRoot={scrollRoot} t={t}
      scaleForPage={pageScale} hasOcrText={(page) => !!ocrPages.get(page)?.words.length}
      pinnedPages={pinnedPages} selectedTextPages={selectedTextPages} dragAnchorPage={draggingPage}
      preserveAnchor={!navigationTarget}
      renderPage={(geometry, retainTextLayer) => <ReaderPage key={`${snapshot.id}:${geometry.page}`} pdf={pdf} geometry={geometry}
      scale={pageScale(geometry)} rotation={0} mode={mode} t={t} scrollRoot={scrollRoot}
      retainTextLayer={retainTextLayer}
      annotations={annotationsByPage.get(geometry.page) ?? noAnnotations}
      renderedAnnotations={renderedAnnotationsByPage.get(geometry.page) ?? noAnnotations}
      selectedAnnotation={selected?.page === geometry.page ? selected.id : undefined}
      selection={selectedPages.has(geometry.page) ? selection : null} ocrWords={ocrPages.get(geometry.page)?.words}
      explanationExcerpts={activeExplanation?.excerpts}
      onView={registerView} onDestination={pageDestination} onAction={pageAction}
      onAnnotation={selectAnnotation} onNote={pageNote} onRegion={pageRegion} onBackground={dismissContext} onError={notifyError} />} />
  }, [pdf, snapshot?.id, snapshot?.contentVersion, snapshot?.document.pages, mode, t, scrollRoot, annotationsByPage, renderedAnnotationsByPage,
    selected?.id, selected?.page, selection, activeExplanation, draggingPage, navigationTarget, ocrPages, zoom, fit, size, pageScale, registerView, pageDestination, pageAction,
    selectAnnotation, pageNote, pageRegion, dismissContext, notifyError])

  const wheelScale = useCallback((page: number) => {
    const geometry = state.current.snapshot?.document.pages[page - 1]
    return geometry ? pageScale(geometry) : state.current.zoom
  }, [pageScale])
  const applyWheelScale = useCallback((scale: number) => { setFit('custom'); setZoom(scale) }, [])
  usePdfWheelZoom({ root: scrollRoot, enabled: !!pdf && !busy && !navigating, views: views.current,
    getScale: wheelScale, onScale: applyWheelScale, ownerKey: `${snapshot?.id}:${snapshot?.contentVersion}` })
  usePdfViewportSize({ root: scrollRoot, size, onSize: setSize,
    preserveAnchor: !!pdf && fit !== 'custom' && !navigating,
    ownerKey: `${snapshot?.id}:${snapshot?.contentVersion}:${fit}` })
  const renderCommentEditor = () => <div className="dsh-pdf-comment-editor">
    <label>{t('reader.commentText')}<textarea value={comment} disabled={!!selected && !selected.editable} onChange={(event) => setComment(event.target.value)} rows={5} /></label>
    <label>{t('reader.color')}<input type="color" value={commentColor} disabled={!!selected && (!!snapshot?.document.readOnly || !selected.editable)} onChange={(event) => selected ? updateAnnotationColor(event.target.value) : setCommentColor(event.target.value)} /></label>
    {selected?.readOnlyReason && <p className="dsh-pdf-muted">{t(`reader.reason.${selected.readOnlyReason}`)}</p>}
    <button disabled={!editable || (!!selected && !selected.editable)} onClick={async () => {
      const patch = { contents: comment, color: colorFromHex(commentColor) }
      const next = pendingNote ? await change([{ type: 'add', annotation: { ...pendingNote, ...patch } }]) : selected ? await change([{ type: 'update', id: selected.id, patch }]) : undefined
      if (next && pendingNote) { setSelectedAnnotation(pendingNote.id); setPendingNote(null) }
    }}>{t('reader.applyComment')}</button>
    {pendingNote && <button onClick={() => setPendingNote(null)}>{t('reader.cancel')}</button>}
    {selected && <button disabled={!editable || !selected.editable} onClick={() => void deleteAnnotation()}>{t('reader.delete')}</button>}
    {selected && (selected.author || selected.createdAt || selected.modifiedAt) && <div className="dsh-pdf-comment-details">
      {selected.author && <span>{selected.author}</span>}
      {selected.createdAt && <span>{t('reader.created')} {formatAnnotationDate(selected.createdAt)}</span>}
      {selected.modifiedAt && <span>{t('reader.modified')} {formatAnnotationDate(selected.modifiedAt)}</span>}
    </div>}
  </div>
  const annotationPanel = <ScrollablePanel className="dsh-pdf-comments" verticalLabel={t('reader.verticalScroll')} horizontalLabel={t('reader.horizontalScroll')}>
    <AnnotationList key={`${snapshot?.id ?? 'none'}:${snapshot?.reader.bytesHash ?? 'none'}`} annotations={commentItems} selectedId={selectedAnnotation} pdf={pdf} t={t}
      details={(pendingNote || selected) && renderCommentEditor()}
      onDeselect={clearAnnotation}
      onSelect={annotation => { selectAnnotation(annotation.id); void jump(annotation.page, annotation.rect ? { x: annotation.rect[0], y: annotation.rect[3] } : {}) }} />
  </ScrollablePanel>
  const activeOcrTranscript = snapshot && ocrTranscript
    && ocrTranscript.result.documentId === snapshot.id
    && ocrTranscript.result.contentVersion === snapshot.contentVersion ? ocrTranscript : null

  const goBack = () => {
    if (navigationLock.current) return
    const controller = new AbortController()
    activeNavigation.current = controller
    navigationLock.current = true; setNavigating(true)
    void history.current.back({ apply: applyPosition }, AbortSignal.any([tab.signal, controller.signal]))
      .then(() => setHistoryRevision((n) => n + 1))
      .catch((failure) => { if (!tab.signal.aborted && !isAbortError(failure)) notifyError(failure) })
      .finally(() => {
        if (activeNavigation.current === controller) activeNavigation.current = null
        navigationLock.current = false
        const next = pendingJump.current
        pendingJump.current = null
        if (next && !tab.signal.aborted) void jump(next.page, next.options, next.remember)
        else setNavigating(false)
      })
  }

  const mainToolbar = <div className="dsh-pdf-toolbar dsh-pdf-main-toolbar" role="toolbar" aria-label={t('reader.sidebar.toolbar')}>
      <details className="dsh-pdf-tools" ref={toolsMenu} onToggle={event => {
        if (event.currentTarget.open) refreshOcrAvailability.current?.()
      }} onBlur={(event) => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false
      }}>
        <summary title={t('reader.tools')}><ToolbarIcon name="tools" /><span className="dsh-pdf-toolbar-label">{t('reader.tools')}</span> <span className="dsh-pdf-tools-chevron" aria-hidden="true">▾</span></summary>
        <div className="dsh-pdf-tools-menu" role="group" aria-label={t('reader.tools')}>
          <button disabled={!snapshot || !props.promptExplanation || props.allowReadingContext === false || explanationSending}
            onClick={activeExplanation ? cancelExplanation : startExplanation}>
            {t(activeExplanation ? 'reader.explain.exit' : 'reader.explain.start')}
          </button>
          <button disabled={!pdf || busy || screenshotBusy || !!activeExplanation} onClick={beginScreenshot}>{t('reader.regionScreenshot')}</button>
          <button disabled={!editable || !!activeExplanation} onClick={() => {
            clearSelection(); clearAnnotation(); setMode('note')
            if (toolsMenu.current) toolsMenu.current.open = false
          }}>{t('reader.note')}</button>
          <button disabled={!pdf || !!ocrProgress || ocrAvailability?.status !== 'available'}
            title={ocrAvailability?.status === 'available' ? t('reader.ocrPage') : ocrAvailability?.reason ?? t('reader.ocrChecking')}
            onClick={() => {
            setMode('text'); void recognize()
            if (toolsMenu.current) toolsMenu.current.open = false
          }}>{t('reader.ocrPage')}</button>
          {ocrAvailability?.status !== 'available' && <p className="dsh-pdf-tools-hint">
            {ocrAvailability?.reason ?? t('reader.ocrChecking')}
          </p>}
          <button disabled={!snapshot || busy || colorPending} onClick={() => {
            if (snapshot?.dirty || snapshot?.canRedo) setReloadConfirm(true)
            else void act(current => api.reload(sessionId, current.id, current.revision, tab.signal))
            if (toolsMenu.current) toolsMenu.current.open = false
          }}>{t('reader.reload')}</button>
          <button className="dsh-pdf-compact-menu-action" disabled={!editable} onClick={() => {
            if (toolsMenu.current) toolsMenu.current.open = false
            void beginSaveAs()
          }}>{t('reader.saveAs')}</button>
          <button className="dsh-pdf-compact-menu-action" disabled={!snapshot || busy || saveAsPicking || colorPending || (!snapshot.dirty && !snapshot.conflict && !snapshot.canRedo && !hasUnappliedComment)} onClick={() => {
            if (toolsMenu.current) toolsMenu.current.open = false
            void discardChanges()
          }}>{t('reader.discard')}</button>
          <button className="dsh-pdf-minimal-menu-action" disabled={!snapshot?.canUndo || busy || colorPending} onClick={() => {
            if (toolsMenu.current) toolsMenu.current.open = false
            void act((current) => api.undo(sessionId, current.id, current.revision, tab.signal))
          }}>{t('reader.undo')}</button>
          <button className="dsh-pdf-minimal-menu-action" disabled={!snapshot?.canRedo || busy || colorPending} onClick={() => {
            if (toolsMenu.current) toolsMenu.current.open = false
            void act((current) => api.redo(sessionId, current.id, current.revision, tab.signal))
          }}>{t('reader.redo')}</button>
          <button className="dsh-pdf-tiny-menu-action" disabled={!editable || !snapshot?.dirty} onClick={() => {
            if (toolsMenu.current) toolsMenu.current.open = false
            void save()
          }}>{t('reader.save')}</button>
          <button className="dsh-pdf-micro-menu-action" disabled={!history.current.canGoBack || busy || navigating} onClick={() => {
            if (toolsMenu.current) toolsMenu.current.open = false
            goBack()
          }}>{t('reader.back')}</button>
        </div>
      </details>
      <div className="dsh-pdf-toolbar-controls">
      <button className="dsh-pdf-toolbar-back" disabled={!history.current.canGoBack || busy || navigating} aria-label={`← ${t('reader.back')}`} title={`${t('reader.back')} ${history.current.peek()?.page ?? ''}`} onClick={goBack}><span aria-hidden="true">←</span> <span className="dsh-pdf-toolbar-label">{t('reader.back')}</span></button>
      <div className="dsh-pdf-toolbar-zoom">
        <ToolbarIcon name="zoom" />
        <span className="dsh-pdf-toolbar-label" aria-hidden="true">{t('reader.zoom')}</span>
        <span className="dsh-pdf-toolbar-zoom-chevron" aria-hidden="true">▾</span>
        <select disabled={navigating} aria-label={t('reader.zoom')}
          title={`${t('reader.zoom')}: ${fit === 'width' ? t('reader.fitWidth') : fit === 'page' ? t('reader.fitPage') : `${Math.round(zoom * 100)}%`}`}
          value={fit === 'custom' ? String(zoom) : fit} onChange={(event) => {
            if (event.target.value === 'width' || event.target.value === 'page') setFit(event.target.value)
            else { setFit('custom'); setZoom(Number(event.target.value)) }
          }}>
          <option value="width">{t('reader.fitWidth')}</option><option value="page">{t('reader.fitPage')}</option>
          {[0.5, 0.75, 1, 1.25, 1.5, 2, 3].map((value) => <option value={value} key={value}>{Math.round(value * 100)}%</option>)}
          {fit === 'custom' && ![0.5, 0.75, 1, 1.25, 1.5, 2, 3].includes(zoom) && <option value={zoom}>{Math.round(zoom * 100)}%</option>}
        </select>
      </div>
      <span className="dsh-pdf-toolbar-divider" aria-hidden="true" />
      <button className="dsh-pdf-toolbar-undo" disabled={!snapshot?.canUndo || busy || colorPending} onClick={() => void act((current) => api.undo(sessionId, current.id, current.revision, tab.signal))} aria-label={t('reader.undo')} title={t('reader.undo')}>↶</button>
      <button className="dsh-pdf-toolbar-redo" disabled={!snapshot?.canRedo || busy || colorPending} onClick={() => void act((current) => api.redo(sessionId, current.id, current.revision, tab.signal))} aria-label={t('reader.redo')} title={t('reader.redo')}>↷</button>
      <button className="dsh-pdf-primary dsh-pdf-toolbar-save" disabled={!editable || !snapshot?.dirty} title={t('reader.save')} onClick={() => void save()}><ToolbarIcon name="save" /><span className="dsh-pdf-toolbar-label">{t('reader.save')}</span></button>
      <button className="dsh-pdf-toolbar-save-as" disabled={!editable} title={t('reader.saveAs')} onClick={() => void beginSaveAs()}><ToolbarIcon name="saveAs" /><span className="dsh-pdf-toolbar-label">{t('reader.saveAs')}</span></button>
      <button className="dsh-pdf-toolbar-discard" disabled={!snapshot || busy || saveAsPicking || colorPending || (!snapshot.dirty && !snapshot.conflict && !snapshot.canRedo && !hasUnappliedComment)} title={t('reader.discardHelp')} onClick={() => void discardChanges()}><ToolbarIcon name="discard" /><span className="dsh-pdf-toolbar-label">{t('reader.discard')}</span></button>
      </div>
    </div>
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
    <style>{windowedPagesStyles}</style>
    <FloatingToolbar viewport={scrollRoot} getAnchor={contextualAnchor} label={t('reader.textActions')}
      active={hasTextSelection && mode === 'text'}>
      <button onClick={() => void copyText()}>{t(textCopied ? 'reader.textCopied' : 'reader.copyText')}</button>
      {props.promptExplanation && props.allowReadingContext !== false && <button type="button" disabled={explanationSending}
        onClick={addSelectionToExplanation}>{t(activeExplanation ? 'reader.explain.add' : 'reader.explain.selection')}</button>}
      <button onClick={beginTranslation}>{t('reader.translateSelection')}</button>
      {!activeExplanation && <>
        <button type="button" disabled={!editable} onClick={() => void mark('Highlight')}>{t('reader.highlight')}</button>
        <button disabled={!editable} onClick={() => void mark('Underline')}>{t('reader.underline')}</button>
        <button disabled={!editable} onClick={() => void mark('StrikeOut')}>{t('reader.strike')}</button>
        <button disabled={!editable} onClick={() => {
          const fragment = selection?.fragments[0]
          if (fragment) { beginNote(fragment.page, [fragment.rect[0], fragment.rect[3]]); clearSelection() }
        }}>{t('reader.note')}</button>
      </>}
      <button aria-label={t('reader.clearSelection')} onClick={clearSelection}>×</button>
    </FloatingToolbar>
    {selected && <FloatingToolbar viewport={scrollRoot} getAnchor={contextualAnchor} label={t('reader.selectedAnnotation')}>
      <span>{t('reader.selectedAnnotation')} · {selected.supported ? t(`reader.type.${selected.subtype}`) : selected.subtype}</span>
      {selected.subtype === 'Highlight'
        ? <HighlightColorBar value={commentColor} disabled={!!snapshot?.document.readOnly || !selected.editable}
          label={t('reader.annotationColor')} t={t} onQuickColor={updateAnnotationColor} onPaletteColor={updateAnnotationColor} />
        : <input type="color" aria-label={t('reader.annotationColor')} value={commentColor}
          disabled={!!snapshot?.document.readOnly || !selected.editable} onChange={(event) => updateAnnotationColor(event.target.value)} />}
      <button disabled={!editable || !selected.editable} onClick={() => void deleteAnnotation()}>{t('reader.delete')}</button>
      <button onClick={() => showSidebar('annotations')}>{t('reader.commentText')}</button>
      <button onClick={clearAnnotation}>{t('reader.deselectAnnotation')}</button>
    </FloatingToolbar>}
    {snapshot?.document.readOnly && <div className="dsh-pdf-notice">{t(snapshot.document.readOnlyReason === 'encrypted-document' ? 'reader.encryptedReadOnly' : 'reader.signedReadOnly')}</div>}
    {mode === 'note' && <div className="dsh-pdf-notice">{t('reader.placeNote')}<button onClick={() => setMode('text')}>{t('reader.cancel')}</button></div>}
    {mode === 'region' && <div className="dsh-pdf-notice">{t('reader.screenshotHint')}<button onClick={cancelScreenshot}>{t('reader.cancel')}</button></div>}
    {screenshotBusy && <div className="dsh-pdf-notice" role="status">{t('reader.screenshotPreparing')}<button onClick={cancelScreenshot}>{t('reader.cancel')}</button></div>}
    {error && <div className="dsh-pdf-error" role="alert"><span>{error}</span><button aria-label={t('reader.dismiss')} onClick={() => setError('')}>×</button></div>}
    {snapshot?.warning && <div className="dsh-pdf-notice" role="status">{snapshot.warning}</div>}
    {snapshot?.conflict && <div className="dsh-pdf-notice" role="status">{t('reader.conflict')}<button disabled={!editable} onClick={() => void beginSaveAs()}>{t('reader.saveAs')}</button></div>}
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
    <div className="dsh-pdf-body" ref={readerBody}>
      <div className="dsh-pdf-content" aria-label={t('reader.sidebar.pdfContent')}>
      <div className="dsh-pdf-floating-controls">
        {mainToolbar}
        {activeExplanation && <ExplanationTray excerpts={activeExplanation.excerpts} question={explanationQuestion}
          error={explanationError} sending={explanationSending} t={t}
          onQuestionChange={setExplanationQuestion}
          onRemove={id => { setExplanation(current => current && current.key === explanationKey
            ? { ...current, excerpts: current.excerpts.filter(excerpt => excerpt.id !== id) } : current); setExplanationError('') }}
          onSend={() => void submitExplanation()} onCancel={cancelExplanation} />}
        <div className="dsh-pdf-save-feedback"
          data-visible={saveFeedback !== null} data-kind={saveFeedback ?? undefined} title={snapshot?.path}>
          <span role="status" aria-live="polite" aria-atomic="true">
            {saveFeedback === 'saving' ? t('reader.saving') : saveFeedback === 'saved' ? t('reader.saved')
              : saveFeedback === 'unsaved' ? t('reader.unsaved') : ''}
          </span>
        </div>
      </div>
      <div className="dsh-pdf-scroll" ref={scrollRef} tabIndex={0} onScroll={updateScrolledPage}
        onPointerDown={(event) => {
          if (event.button !== 0 || mode !== 'text' || (event.target instanceof Element && event.target.closest('button,a,input,textarea'))) return
          const wrapper = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-page-number]') : null
          setDraggingPage(wrapper ? Number(wrapper.dataset.pageNumber) : null)
          // Remove the old native Range before browser default selection starts;
          // otherwise pointerup can recapture it after clicking page whitespace.
          if (event.shiftKey) setSelection(null)
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
        pdf={pdf} currentPage={currentPage} pageInput={pageInput} navigating={navigating}
        onPageInputChange={setPageInput}
        onPageInputSubmit={() => {
          const raw = pageInput.trim()
          const page = /^\d+$/.test(raw) ? Number(raw) : NaN
          if (!pdf || !Number.isSafeInteger(page) || page < 1 || page > pdf.numPages) {
            setPageInput(String(currentPage))
            return
          }
          setPageInput(String(page))
          if (page !== currentPage) void jump(page)
        }}
        onPageInputReset={() => setPageInput(String(currentPage))}
        onNavigatePage={page => { void jump(page) }}
        onStepPage={page => { void jump(page, {}, false) }} onNavigateDestination={value => { void destination(value) }}
        bookmarks={pdf && snapshot ? { api, sessionId, documentId: snapshot.id,
          capturePosition: capture, onNavigatePosition: position => { void jump(position.page, position) } } : undefined}
        onExpandedChange={changeSidebarExpanded} t={t} panels={{
          annotations: annotationPanel,
          ocr: <ScrollablePanel className="dsh-pdf-ocr-scroll" verticalLabel={t('reader.verticalScroll')} horizontalLabel={t('reader.horizontalScroll')}>
            <OcrTranscriptPanel result={activeOcrTranscript?.result ?? null} region={!!activeOcrTranscript?.region} t={t} />
          </ScrollablePanel>,
          search: <ScrollablePanel className="dsh-pdf-search-panel" verticalLabel={t('reader.verticalScroll')} horizontalLabel={t('reader.horizontalScroll')}>
            <div className="dsh-pdf-panel-heading"><h3>{t('reader.search')}</h3></div>
            <form onSubmit={event => void runSearch(event)}><input aria-label={t('reader.search')} placeholder={t('reader.searchPlaceholder')} value={query} onChange={event => setQuery(event.target.value)} />
              <button disabled={searching || !query.trim() || !pdf}>{searching ? t('reader.searching') : t('reader.search')}</button></form>
            <p className="dsh-pdf-muted">{t('reader.searchCoverage')}</p>
            {searched && <p>{hits.length ? `${hits.length}${hits.length >= 500 ? '+' : ''} ${t('reader.results')}` : t('reader.noResults')}</p>}
            {hits.map((hit, index) => <button className="dsh-pdf-search-hit" key={index}
              onClick={() => void jump(hit.page, hit.x === undefined || hit.y === undefined ? {} : { x: hit.x, y: hit.y })}>
              <strong>{t('reader.page')} {hit.page} · {hit.source === 'ocr'
                ? t(hit.x === undefined ? 'reader.ocrPageMatch' : 'reader.ocrText') : t('reader.nativeText')}</strong><span>{hit.text}</span>
            </button>)}
          </ScrollablePanel>,
          translation: translationSelection ? <TranslationPanel selection={translationSelection} translate={translateSelection}
            rememberTargetLanguage={props.rememberTranslationTargetLanguage} onClose={closeTranslation} t={t}
            engineName={settings.translationEngine === 'dsh-model' ? t('reader.translationDshModel')
              : props.translation.list().find(engine => engine.id === settings.translationEngine)?.name ?? settings.translationEngine} />
            : <ScrollablePanel className="dsh-pdf-translation-panel" verticalLabel={t('reader.verticalScroll')} horizontalLabel={t('reader.horizontalScroll')}>
              <div className="dsh-pdf-panel-heading"><h3>{t('reader.sidebar.translation')}</h3></div>
              <p className="dsh-pdf-muted">{t('reader.sidebar.translationHint')}</p>
            </ScrollablePanel>,
        }} />
    </div>
    {screenshot && <ScreenshotPreview image={screenshot} t={t} onError={notifyError} onClose={() => { setScreenshot(null); clearSelection() }}
      onOcr={ocrAvailability?.status === 'available' && !ocrProgress
        ? () => void recognize({ page: screenshot.page, rect: screenshot.region }) : undefined} />}
  </div>
}

export default Reader
