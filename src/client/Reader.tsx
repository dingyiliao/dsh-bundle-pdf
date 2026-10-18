import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
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
import { joinSearchText, searchItemAtOffset, searchOffsetMap, searchResultExcerpt, SearchProgressPacer, SearchTextIndex } from './reader-search.js'
import { formatAnnotationDate } from './reader-dates.js'
import { AnnotationList } from './AnnotationList.js'
import { FloatingToolbar, visibleReadingBounds } from './FloatingToolbar.js'
import { ExplanationQuestionEditor } from './ExplanationQuestionEditor.js'
import { ExplanationStatusBar } from './ExplanationStatusBar.js'
import { addExplanationExcerpt, addExplanationRegion, MAX_EXPLANATION_EXCERPTS, updateExplanationExcerptQuestion,
  type ExplanationExcerpt } from './explain-mode.js'
import type { ImageUnderstandingAvailability } from './image-understanding-api.js'
import { encodeExplanationImage } from './explanation-image.js'
import { buildMixedExplanationPrompt } from './explanation-prompt.js'
import { AnnotationColorBar } from './AnnotationColorBar.js'
import { OverlayScrollbars } from './OverlayScrollbar.js'
import { ScrollablePanel } from './ScrollablePanel.js'
import { capturePdfRegion, type PdfRegionScreenshot } from './reader-screenshot.js'
import { ScreenshotPreview } from './ScreenshotPreview.js'
import { OcrTranscriptPanel } from './OcrTranscriptPanel.js'
import { FloatingStatusRail, type FloatingStatus } from './FloatingStatusRail.js'
import { TranslationPanel, type TranslationPanelProps } from './TranslationPanel.js'
import { TranslationService, type TranslationRequest } from '../translation/index.js'
import { currentTranslationSelection } from './translation-selection.js'
import { ReadingSidebar, type ReadingSidebarSection } from './ReadingSidebar.js'
import { usePdfWheelZoom } from './use-pdf-wheel-zoom.js'
import { usePdfViewportSize } from './use-pdf-viewport-size.js'
import { waitForReaderState } from './wait-for-reader-state.js'
import { applyIfNoNewerNavigation } from './reading-resume.js'
import { ToolbarIcon, type ToolbarIconName } from './ToolbarIcon.js'
import { ToolbarTooltip } from './ToolbarTooltip.js'
import { ZoomMenu } from './ZoomMenu.js'
import { SelectionHighlightControl } from './SelectionHighlightControl.js'
import { BackHistoryControl } from './BackHistoryControl.js'
import { AnnotationCommentCard } from './AnnotationCommentCard.js'

interface SearchHit { page: number; text: string; x?: number; y?: number; source: 'native' | 'ocr' }
type ExplanationEditorDraft = { key: string; question: string } & (
  | { kind: 'new'; draftId: string; selection: ReaderSelection }
  | { kind: 'edit'; excerptId: string }
)
type SaveFeedback = 'saving' | 'saved' | 'unsaved'
interface SaveFeedbackState { kind: SaveFeedback; durationMs: number; occurrence: number; path?: string }
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const yieldSearchTurn = () => {
  const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }).scheduler
  // A timer fallback also makes progress in background tabs, where rAF can be suspended.
  return scheduler?.yield?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0))
}
const navigationTimeoutMs = 45_000
/**
 * How long a durable reading-position write may lag the reader. A hard kill
 * loses at most this much scrolling; one paused second is one small write.
 */
const positionWriteDelayMs = 1_000
const isAbortError = (value: unknown) => value instanceof Error && value.name === 'AbortError'
const isStalePdf = (value: unknown) => value instanceof Error && 'code' in value && value.code === 'PDF_STALE_VERSION'
const noAnnotations: PdfAnnotation[] = []
const initialAnnotationColor = '#ffff00'
function sameExplanationSelection(left: ReaderSelection, right: ReaderSelection): boolean {
  return left.kind === right.kind && left.revision === right.revision && left.text === right.text
    && left.fragments.length === right.fragments.length
    && left.fragments.every((fragment, index) => {
      const other = right.fragments[index]
      return other?.page === fragment.page && fragment.rect.every((value, part) => value === other.rect[part])
        && fragment.quadPoints.length === other.quadPoints.length
        && fragment.quadPoints.every((value, part) => value === other.quadPoints[part])
    })
}

/** Text marks share one color bar; each keeps its own action icon as its identity. */
const textMarkIcons: Partial<Record<PdfAnnotation['subtype'], ToolbarIconName>> = {
  Highlight: 'highlight', Underline: 'underline', StrikeOut: 'strike',
}
function textMarkIcon(subtype: PdfAnnotation['subtype']): ToolbarIconName | undefined {
  return textMarkIcons[subtype]
}
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
  const [positionNotice, setPositionNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [saveFeedback, setSaveFeedback] = useState<SaveFeedbackState | null>(null)
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
  const [explanationEditor, setExplanationEditor] = useState<ExplanationEditorDraft | null>(null)
  const [explanationError, setExplanationError] = useState('')
  const [explanationSending, setExplanationSending] = useState(false)
  const [explanationSaving, setExplanationSaving] = useState(false)
  const [imageAvailability, setImageAvailability] = useState<ImageUnderstandingAvailability | null>(null)
  const [draggingPage, setDraggingPage] = useState<number | null>(null)
  const [screenshot, setScreenshot] = useState<(PdfRegionScreenshot & { page: number; region: PdfRect; revision: number }) | null>(null)
  const [screenshotPhase, setScreenshotPhase] = useState<'preparing' | 'cancelling' | null>(null)
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
  const [commentCardOpen, setCommentCardOpen] = useState(false)
  const [comment, setComment] = useState('')
  const [commentColor, setCommentColor] = useState(initialAnnotationColor)
  const [commentFocusRequest, setCommentFocusRequest] = useState(0)
  const handledCommentFocus = useRef(0)
  const commentTextarea = useRef<HTMLTextAreaElement>(null)
  const [colorPending, setColorPending] = useState(false)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searched, setSearched] = useState(false)
  const [ocrPages, setOcrPages] = useState<Map<number, OcrPage>>(() => lifetime.ocrPages)
  const [ocrAvailability, setOcrAvailability] = useState<HostOcrAvailability | null>(null)
  const [ocrTranscript, setOcrTranscript] = useState<OcrTranscript | null>(() => lifetime.ocrTranscript ?? null)
  const [ocrProgress, setOcrProgress] = useState<'preparing' | 'recognizing' | 'cancelling' | null>(null)
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
  const explanationMarkerAnchor = useRef<HTMLElement | null>(null)
  const explanationCaptureController = useRef<AbortController | null>(null)
  const explanationCaptureTask = useRef<Promise<unknown> | null>(null)
  // Both actions use the page's rectangle drag, but only the explanation
  // action may turn its result into a question draft.
  const regionPurpose = useRef<'explanation' | 'screenshot' | null>(null)
  const scrollFrame = useRef<number | undefined>(undefined)
  const screenshotController = useRef<AbortController | null>(null)
  const history = useRef(lifetime.history)
  const captureLatest = useRef<(() => NavigationPosition) | undefined>(undefined)
  /**
   * Writes an already-captured position without a tab signal: the final write on
   * close must survive the tab abort that ends this reader.
   */
  const persistPosition = useRef<((position: NavigationPosition) => void) | undefined>(undefined)
  const restored = useRef(false)
  /** Set once the resume decision is made, so an early write cannot replace it. */
  const positionReady = useRef(false)
  /** A late Host resume must not supersede a navigation requested since the lookup began. */
  const navigationIntent = useRef(0)
  /** A failed restore keeps the previous Host record until a later successful navigation. */
  const resumeFailed = useRef(false)
  const navigationCompleted = useRef(0)
  const navigationLock = useRef(false)
  const activeNavigation = useRef<AbortController | null>(null)
  const pendingJump = useRef<{ page: number; options: Partial<NavigationPosition>; remember: boolean } | null>(null)
  const documentNavigation = useRef(new AbortController())
  const operationLock = useRef(false)
  const saveAsPickerLock = useRef(false)
  const saveFeedbackOccurrence = useRef(0)
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
  const activeExplanationEditor = activeExplanation && explanationEditor?.key === explanationKey ? explanationEditor : null
  const draftExplanationSelection = activeExplanationEditor?.kind === 'new' ? activeExplanationEditor.selection : null
  const callbacks = useRef(props)
  callbacks.current = props
  const historySnapshot = useMemo(() => history.current.snapshot(), [historyRevision])

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
  useEffect(() => {
    if (!tab.visible || !activeExplanation) { setImageAvailability(null); return }
    let active = true
    let request: AbortController | null = null
    const refresh = () => {
      request?.abort()
      request = new AbortController()
      const signal = AbortSignal.any([request.signal, tab.signal])
      void props.imageUnderstanding.availability(sessionId, signal).then(value => {
        if (active && !signal.aborted) setImageAvailability(value)
      }, error => {
        if (active && !signal.aborted) setImageAvailability({ status: 'unavailable',
          reason: error instanceof Error ? error.message : t('reader.explain.imageUnavailable') })
      })
    }
    refresh()
    const timer = setInterval(refresh, 15_000)
    window.addEventListener('focus', refresh)
    return () => { active = false; request?.abort(); clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [!!activeExplanation, props.imageUnderstanding, sessionId, tab.visible, tab.signal, t])

  const showSaveFeedback = useCallback((kind: SaveFeedback | null, durationMs = 2600, path?: string) => {
    setSaveFeedback(kind ? { kind, durationMs, occurrence: ++saveFeedbackOccurrence.current, path } : null)
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
  const openCommentEditor = useCallback(() => {
    setCommentCardOpen(true)
    setCommentFocusRequest(current => current + 1)
  }, [])
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
    setScreenshotPhase(null)
    explanationCaptureController.current?.abort()
    translationService.current?.setSource(undefined)
    setTranslationSelection(null)
    setScreenshot(null)
    setSelection(null)
    setDraggingPage(null)
    setMode('text')
    setDisplayOwner(null)
    setSelectedAnnotation(undefined)
    setPendingNote(null)
    setCommentCardOpen(false)
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
    else if (previous?.id === snapshot.id && previous.dirty && !snapshot.dirty && saveFeedback?.kind === 'unsaved') showSaveFeedback(null)
  }, [snapshot?.id, snapshot?.dirty, saveFeedback, showSaveFeedback])

  useEffect(() => {
    if (!snapshot || !displayOwner || displayOwner.token !== ownerSequence.current) return
    const identity = readerIdentity(snapshot)
    if (activePdf.current?.identity === identity) {
      const latest = state.current.snapshot
      displayOwner.content.loaded(latest && readerIdentity(latest) === identity ? latest.sourceVersion : snapshot.sourceVersion)
      return
    }
    const priorCapture = explanationCaptureTask.current
    explanationCaptureController.current?.abort()
    const controller = new AbortController()
    let accepted = false
    let cancelled = false
    const opening = openNativeDocument(snapshot, sessionId, api.native)
    void opening.then(async (opened) => {
      if (controller.signal.aborted || cancelled || displayOwner.token !== ownerSequence.current) {
        try { await opened.dispose() }
        catch (failure) { console.warn('[pdf] Could not release a stale document', failure) }
        return
      }
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
      await priorCapture?.catch(() => undefined)
      // Releasing the old document is cleanup, not a failure to open the new one.
      // The new owner has already been published and reported as loaded.
      try { await previous?.dispose() }
      catch (failure) { console.warn('[pdf] Could not release the previous document', failure) }
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
    try {
      const position = captureLatest.current?.()
      lifetime.position = position
      if (position) persistPosition.current?.(position)
    } catch { /* No page loaded yet. */ }
    explanationCaptureController.current?.abort()
    const pendingCapture = explanationCaptureTask.current
    const closingPdf = activePdf.current
    activePdf.current = null
    // The native handle must outlive any in-flight region render, even if the
    // reader tab is closed while its question is being saved.
    void Promise.resolve(pendingCapture).catch(() => undefined).then(() => closingPdf?.dispose())
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
    explanationCaptureController.current?.abort()
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
    // Document edits are already durable in the Host draft. Only a queued
    // color change that has not reached the Host still needs an unload guard.
    if (!colorPending) return
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', leave)
    return () => window.removeEventListener('beforeunload', leave)
  }, [colorPending])

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
        const pageTop = outer.top + item.top - root.scrollTop
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
      // WindowedPages mounts distant pages after the scroll, and Page registers a
      // viewport only after its PDF page proxy resolves. Wait for that signal,
      // not for an arbitrary number of animation frames.
      const view = await waitForReaderState(root, 'pdfviewchange', () => {
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

  /**
   * Remember where reading stopped, so the next open can resume there.
   *
   * Writing before the resume decision would replace the stored position with
   * whatever page rendered first, so this stays silent until the reader has
   * decided whether to resume.
   */
  const rememberPosition = useCallback(() => {
    // A jump's intermediate scroll offset is not a reading position. The
    // settled navigation records its destination instead.
    if (!positionReady.current || navigationLock.current) return
    const current = state.current
    const documentId = current.snapshot?.id
    if (!documentId || !current.scrollRoot) return
    let position: NavigationPosition
    try { position = capture() } catch { return }
    // The stored shape rejects a document identity: contentVersion is per open.
    const { documentVersion: _documentVersion, ...stored } = position
    void api.positions.set(sessionId, documentId, stored, tab.signal).catch((failure: unknown) => {
      if (!isAbortError(failure)) console.warn('[pdf] Could not remember the reading position', failure)
    })
  }, [api, capture, sessionId, tab.signal])
  persistPosition.current = (position) => {
    const documentId = state.current.snapshot?.id
    if (!documentId || !positionReady.current || navigationLock.current) return
    const { documentVersion: _documentVersion, ...stored } = position
    void api.positions.set(sessionId, documentId, stored).catch((failure: unknown) => {
      if (!isAbortError(failure)) console.warn('[pdf] Could not remember the reading position', failure)
    })
  }

  const jump = useCallback(async (page: number, options: Partial<NavigationPosition> = {}, remember = true): Promise<boolean> => {
    navigationIntent.current++
    if (navigationLock.current) {
      // A later bookmark/search/page request supersedes a slow page load.
      pendingJump.current = { page, options, remember }
      activeNavigation.current?.abort()
      return false
    }
    const controller = new AbortController()
    activeNavigation.current = controller
    navigationLock.current = true
    setNavigating(true)
    let completed = false
    try {
      const current = state.current
      const geometry = current.snapshot?.document.pages[page - 1]
      if (!geometry) throw new Error(callbacks.current.t('reader.invalidDestination'))
      const safeTop = current.scrollRoot ? readingSafeTop(current.scrollRoot.clientHeight) : 0
      const target: NavigationPosition = { ...capture(), page, x: geometry.cropBox[0], y: geometry.cropBox[3],
        viewportAnchor: { x: 0, y: current.scrollRoot ? safeTop / current.scrollRoot.clientHeight : 0 }, ...options }
      const signal = AbortSignal.any([tab.signal, controller.signal])
      if (remember) {
        const result = await history.current.jump(target, { capture, apply: applyPosition }, signal)
        completed = (result.status === 'changed' || result.status === 'noop') && !signal.aborted
      } else {
        await applyPosition(target, signal)
        completed = !signal.aborted
      }
      if (completed) {
        navigationCompleted.current++
        setHistoryRevision((n) => n + 1)
      }
    } catch (failure) { if (!tab.signal.aborted && !isAbortError(failure)) notifyError(failure) }
    finally {
      if (activeNavigation.current === controller) activeNavigation.current = null
      navigationLock.current = false
      const next = pendingJump.current
      pendingJump.current = null
      if (next && !tab.signal.aborted) void jump(next.page, next.options, next.remember)
      else {
        setNavigating(false)
        if (completed && resumeFailed.current) {
          resumeFailed.current = false
          positionReady.current = true
        }
        rememberPosition()
      }
    }
    return completed
  }, [capture, applyPosition, notifyError, rememberPosition, tab.signal])

  useEffect(() => {
    if (!pdf || !snapshot || !scrollRoot || restored.current) return
    restored.current = true
    const saved = lifetime.position
    if (saved && saved.documentVersion === snapshot.contentVersion) {
      // Restoring a tab is navigation too: it must share the jump lock and be
      // superseded by a later user request rather than racing that request.
      const completedBeforeRestore = navigationCompleted.current
      void jump(saved.page, saved, false).then((completed) => {
        if (!completed && navigationCompleted.current === completedBeforeRestore) {
          resumeFailed.current = true
          return
        }
        positionReady.current = true
        rememberPosition()
      })
      return
    }
    // This client session has no position yet, so resume from the one the Host
    // remembered for this path. It is a fallback, never an override.
    const controller = new AbortController()
    const documentId = snapshot.id
    const completedBeforeRestore = navigationCompleted.current
    let restoreFailed = false
    void applyIfNoNewerNavigation(
      () => api.positions.get(sessionId, documentId, controller.signal),
      () => navigationIntent.current,
      controller.signal,
      async (stored) => {
        // A position from other bytes must not be replayed onto this document.
        if (stored === null || stored.stale !== 'none') {
          if (stored) setPositionNotice(t(stored.stale === 'page-missing' ? 'reader.resumePageMissing' : 'reader.resumeContentChanged'))
          return
        }
        if (stored.position.page > snapshot.document.pageCount) { restoreFailed = true; return }
        restoreFailed = !await jump(stored.position.page, { ...stored.position, documentVersion: snapshot.contentVersion }, false)
      },
    ).then(applied => { if (!applied) restoreFailed = true }).catch((failure: unknown) => {
      restoreFailed = true
      if (!isAbortError(failure)) console.warn('[pdf] Could not read the remembered reading position', failure)
    }).finally(() => {
      if (controller.signal.aborted) return
      if (restoreFailed && navigationCompleted.current === completedBeforeRestore) {
        resumeFailed.current = true
        return
      }
      positionReady.current = true
      rememberPosition()
    })
    return () => controller.abort()
  }, [pdf, snapshot?.id, scrollRoot, jump, lifetime, api, sessionId, t, rememberPosition])

  // A reading position is durable within one paused second of scrolling, not
  // only when the tab later unmounts: a hard kill must not lose the session.
  useEffect(() => {
    if (!pdf || !snapshot || !scrollRoot) return
    let timer: number | null = null
    const schedule = () => {
      if (timer !== null) return
      timer = window.setTimeout(() => { timer = null; rememberPosition() }, positionWriteDelayMs)
    }
    scrollRoot.addEventListener('scroll', schedule, { passive: true })
    return () => {
      scrollRoot.removeEventListener('scroll', schedule)
      if (timer !== null) { clearTimeout(timer); timer = null }
    }
  }, [pdf, snapshot?.id, scrollRoot, rememberPosition])

  // Discrete page steps may not scroll (a jump to the top of the current page),
  // so remember those explicitly as well.
  useEffect(() => {
    if (!pdf || !snapshot) return
    rememberPosition()
  }, [currentPage, pdf, snapshot?.id, rememberPosition])

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
      } else if (!isAbortError(failure)) notifyError(failure)
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
      showSaveFeedback('saved', 2600, saved.path)
      setSaveAsOpen(false); setOverwrite(false)
      if (path && saved.path !== originalPath) {
        const nextAddress = sessionFileAddress(sessionId, saved.path)
        // Save As replaces this reader's resource; keep the successful status
        // through that handoff, while unrelated document switches still clear it.
        saveFeedbackOwner.current = { sessionId, resourceAddress: nextAddress }
        tab.actions.openResource(nextAddress, { replaceTab: true })
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
  const selectedMarkIcon = selected ? textMarkIcon(selected.subtype) : undefined
  useLayoutEffect(() => {
    if (commentFocusRequest === handledCommentFocus.current || !commentCardOpen) return
    const textarea = commentTextarea.current
    if (!textarea || textarea.closest<HTMLElement>('.dsh-pdf-page-comment-card')?.dataset.visible !== 'true') return
    handledCommentFocus.current = commentFocusRequest
    if (!textarea.disabled) textarea.focus()
  }, [commentFocusRequest, commentCardOpen, selected?.id, pendingNote?.id])
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
    setCommentCardOpen(false)
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
    openCommentEditor()
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
    setHits([])
    const found: SearchHit[] = []
    const progress = new SearchProgressPacer(() => performance.now(), yieldSearchTurn, () => setHits([...found]),
      () => sequence === searchSequence.current && !tab.signal.aborted)
    const span = beginPdfSpan('client.search', { pageCount: pdf.numPages })
    try {
      for (let number = 1; number <= pdf.numPages; number++) {
        if (sequence !== searchSequence.current || tab.signal.aborted) { span.end('cancelled'); return }
        const ocr = ocrPages.get(number)
        if (ocr) {
          // The current OCR backend returns a transcript but no word boxes, so
          // search can locate the page but must not invent word coordinates.
          const match = ocr.text.toLocaleLowerCase().indexOf(needle)
          if (match >= 0 && found.length < 500 && !found.some((hit) => hit.page === number)) {
            // A transcript without boxes locates only the page, not the word.
            found.push({ page: number, text: searchResultExcerpt(ocr.text, match, needle.length), source: 'ocr' })
          }
        }
        if (found.length >= 500) break
        if (!textIndex.mayContain(number, needle)) {
          if (sequence !== searchSequence.current || tab.signal.aborted) return
          const pause = progress.checkpoint(found.length)
          if (pause && !await pause) return
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
        if (sequence !== searchSequence.current || tab.signal.aborted) return
        const pause = progress.checkpoint(found.length)
        if (pause && !await pause) return
        if (found.length >= 500) break
      }
      if (sequence === searchSequence.current && !tab.signal.aborted) { setHits(found); setSearched(true) }
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
    setOcrProgress('preparing')
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
      setOcrProgress('recognizing')
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
    finally {
      tab.signal.removeEventListener('abort', stop)
      if (ocrController.current === controller) {
        ocrController.current = null
        setOcrProgress(null)
      }
    }
  }

  const cancelOcr = () => {
    if (!ocrController.current || ocrController.current.signal.aborted) return
    ocrController.current.abort()
    setOcrProgress('cancelling')
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
    if (selectedAnnotationRef.current !== id && hasUnappliedComment
      && !window.confirm(t('reader.discardCommentDraft'))) return
    if (selectedAnnotationRef.current !== id) setComment(annotationsById.get(id)?.contents ?? '')
    setPendingNote(null)
    setSelection(null)
    window.getSelection()?.removeAllRanges()
    setSelectedAnnotation(id)
    setCommentCardOpen(true)
    setCommentFocusRequest(current => current + 1)
  }, [annotationsById, hasUnappliedComment, t])
  const clearAnnotation = useCallback(() => {
    if (hasUnappliedComment) return
    setSelectedAnnotation(undefined); setPendingNote(null); setCommentCardOpen(false)
  }, [hasUnappliedComment])
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
      explanationCaptureController.current?.abort()
      if (regionPurpose.current === 'explanation') regionPurpose.current = null
      setExplanation(null)
      setExplanationEditor(null)
      setExplanationError('')
      setExplanationSending(false)
      if (!explanationCaptureTask.current) setExplanationSaving(false)
      setMode('text')
    }
  }, [explanation, explanationKey])
  const cancelExplanation = () => {
    explanationCaptureController.current?.abort()
    if (regionPurpose.current === 'explanation') regionPurpose.current = null
    setExplanation(null)
    setExplanationEditor(null)
    if (!explanationCaptureTask.current) setExplanationSaving(false)
    explanationMarkerAnchor.current = null
    setExplanationError('')
    setMode('text')
    clearSelection()
    if (toolsMenu.current) toolsMenu.current.open = false
  }
  const startExplanation = (initialSelection?: ReaderSelection) => {
    if (!explanationKey || !props.promptExplanation || props.allowReadingContext === false
      || screenshotController.current || screenshotPhase || screenshot) return
    regionPurpose.current = null
    setMode('text')
    setExplanation({ key: explanationKey, excerpts: [] })
    setExplanationEditor(initialSelection?.kind === 'text' && initialSelection.text.trim()
      ? { key: explanationKey, kind: 'new', draftId: crypto.randomUUID(), selection: initialSelection, question: '' }
      : null)
    explanationMarkerAnchor.current = null
    setExplanationError('')
    if (!initialSelection) clearSelection()
    if (toolsMenu.current) toolsMenu.current.open = false
  }
  const saveExplanationQuestion = async () => {
    const editor = activeExplanationEditor
    if (!editor || !activeExplanation || explanationSending || explanationSaving) return
    if (!editor.question.trim()) { setExplanationError(t('reader.explain.questionRequired')); return }
    if (editor.kind === 'new') {
      if (editor.selection.revision !== snapshot?.revision) { setExplanationEditor(null); clearSelection(); return }
      if (editor.selection.kind === 'region') {
        const fragment = editor.selection.fragments[0]
        if (!fragment || !pdf || !snapshot || activePdf.current?.identity !== readerIdentity(snapshot)) {
          setExplanationError(t('reader.notReady')); return
        }
        const owner = ownerSequence.current
        const controller = new AbortController()
        explanationCaptureController.current = controller
        const signal = AbortSignal.any([controller.signal, tab.signal])
        setExplanationSaving(true)
        let captureTask: ReturnType<typeof capturePdfRegion> | null = null
        try {
          captureTask = capturePdfRegion(pdf, fragment.page, fragment.rect, { signal,
            annotations: snapshot.document.annotations.filter(annotation => annotation.page === fragment.page),
            sourceAnnotations: pdfAnnotations.filter(annotation => annotation.page === fragment.page) })
          explanationCaptureTask.current = captureTask
          const image = await captureTask
          signal.throwIfAborted()
          if (ownerSequence.current !== owner || state.current.snapshot?.id !== snapshot.id || state.current.snapshot.revision !== snapshot.revision
            || state.current.snapshot.contentVersion !== snapshot.contentVersion) return
          const next = addExplanationRegion(activeExplanation.excerpts, editor.selection,
            { ...image, mediaType: 'image/png' }, crypto.randomUUID(), editor.question)
          if (!next.ok) { setExplanationError(t(`reader.explain.${next.reason}`)); return }
          setExplanation({ key: activeExplanation.key, excerpts: next.excerpts })
          setExplanationEditor(null)
          explanationMarkerAnchor.current = null
          setExplanationError('')
          clearSelection()
        } catch (failure) {
          if (!signal.aborted) setExplanationError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          if (explanationCaptureTask.current === captureTask) explanationCaptureTask.current = null
          if (explanationCaptureController.current === controller) {
            explanationCaptureController.current = null
            if (!tab.signal.aborted) setExplanationSaving(false)
          }
        }
        return
      }
      const next = addExplanationExcerpt(activeExplanation.excerpts, editor.selection, crypto.randomUUID(), editor.question)
      if (!next.ok) { setExplanationError(t(`reader.explain.${next.reason}`)); return }
      setExplanation({ key: activeExplanation.key, excerpts: next.excerpts })
    } else {
      setExplanation({ key: activeExplanation.key,
        excerpts: updateExplanationExcerptQuestion(activeExplanation.excerpts, editor.excerptId, editor.question) })
    }
    setExplanationEditor(null)
    explanationMarkerAnchor.current = null
    setExplanationError('')
    clearSelection()
  }
  const cancelExplanationEditor = () => {
    explanationCaptureController.current?.abort()
    setExplanationEditor(null)
    if (!explanationCaptureTask.current) setExplanationSaving(false)
    explanationMarkerAnchor.current = null
    setExplanationError('')
    clearSelection()
  }
  const deleteExplanationQuestion = () => {
    const editor = activeExplanationEditor
    if (!editor || editor.kind !== 'edit' || !activeExplanation || explanationSending) return
    setExplanation({ key: activeExplanation.key,
      excerpts: activeExplanation.excerpts.filter(excerpt => excerpt.id !== editor.excerptId) })
    cancelExplanationEditor()
  }
  const submitExplanation = async () => {
    if (!activeExplanation?.excerpts.length || activeExplanationEditor || !snapshot || !props.promptExplanation || explanationSending || explanationSaving) return
    const key = activeExplanation.key
    setExplanationSending(true)
    setExplanationError('')
    try {
      const prompt = await buildMixedExplanationPrompt(snapshot.path, activeExplanation.excerpts, t, {
        sessionId, prepare: (request, signal) => props.imageUnderstanding.prepare(request, signal),
        encode: encodeExplanationImage, signal: tab.signal,
      })
      tab.signal.throwIfAborted()
      const currentBeforeSend = state.current.snapshot
      if (!currentBeforeSend || `${sessionId}:${currentBeforeSend.id}:${currentBeforeSend.contentVersion}` !== key) return
      await props.promptExplanation(prompt, tab.signal)
      const current = state.current.snapshot
      if (current && `${sessionId}:${current.id}:${current.contentVersion}` === key && !tab.signal.aborted) {
        setExplanation(draft => draft?.key === key ? null : draft)
        setExplanationEditor(null)
        clearSelection()
      }
    } catch (failure) {
      if (!tab.signal.aborted) setExplanationError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (!tab.signal.aborted) setExplanationSending(false)
    }
  }
  const dismissContext = useCallback(() => {
    if (hasUnappliedComment) return
    regionPurpose.current = null
    clearAnnotation(); clearSelection(); setExplanationEditor(null); setComment(''); setMode('text')
  }, [hasUnappliedComment, clearAnnotation, clearSelection])
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
      if (number !== state.current.currentPage) {
        const previousPage = state.current.currentPage
        setCurrentPage(number)
        // A late layout/scroll frame must not replace a page number the user is
        // still typing. Focus may briefly move during a layout transition, so
        // also update only when the field still represents the previous page.
        if (!readerElement.current?.querySelector('.dsh-pdf-page-input:focus')) {
          setPageInput(draft => draft === String(previousPage) ? String(number) : draft)
        }
      }
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
    if (next && activeExplanationEditor?.kind === 'new'
      && sameExplanationSelection(next, activeExplanationEditor.selection)) return
    setSelection(next)
    if (next) setSelectedAnnotation(undefined)
    if (activeExplanation && !explanationSending && next?.kind === 'text' && next.text.trim()) {
      if (activeExplanation.excerpts.length >= MAX_EXPLANATION_EXCERPTS) {
        setExplanationError(t('reader.explain.limit'))
        return
      }
      explanationMarkerAnchor.current = null
      setExplanationEditor({ key: activeExplanation.key, kind: 'new', draftId: crypto.randomUUID(), selection: next, question: '' })
      setExplanationError('')
    }
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
      selectionBefore: selection.selectionBefore, selectionAfter: selection.selectionAfter,
      targetLanguage: settings.translationTargetLanguage,
      owner: ownerSequence.current, documentId: snapshot.id, contentVersion: snapshot.contentVersion })
  }
  const translateSelection = useCallback(async (request: TranslationRequest) => {
    const source = currentTranslationSelection(translationOwner.current, ownerSequence.current, state.current.snapshot)
    translationService.current ??= new TranslationService(props.translation)
    translationService.current.setSource({ documentId: source.documentId, contentVersion: source.contentVersion })
    return translationService.current.translate({ ...request, timeoutMs: callbacks.current.settings.translationTimeoutMs,
      signal: request.signal ? AbortSignal.any([request.signal, tab.signal]) : tab.signal,
      context: { sessionId, documentId: source.documentId, contentVersion: source.contentVersion, pages: source.pages,
        ...(request.text === source.text
          ? { selectionBefore: source.selectionBefore, selectionAfter: source.selectionAfter } : {}) } })
  }, [props.translation, sessionId, tab.signal])
  const closeTranslation = () => { translationService.current?.cancel(); setTranslationSelection(null) }
  const cancelScreenshot = () => {
    if (screenshotController.current && !screenshotController.current.signal.aborted) {
      screenshotController.current.abort()
      setScreenshotPhase('cancelling')
    }
    regionPurpose.current = null
    setScreenshot(null)
    setMode('text')
    clearSelection()
  }
  const beginScreenshot = () => {
    if (activeExplanation || screenshotController.current || screenshotPhase || screenshot) return
    if (!displayOwner || displayOwner.token !== ownerSequence.current) { notifyError(new Error(t('reader.notReady'))); return }
    clearSelection()
    clearAnnotation()
    setScreenshot(null)
    regionPurpose.current = 'screenshot'
    setMode('region')
    if (toolsMenu.current) toolsMenu.current.open = false
  }
  const beginExplanationRegion = () => {
    if (!activeExplanation || explanationSending || explanationSaving || activeExplanationEditor) return
    if (mode === 'region' && regionPurpose.current === 'explanation') {
      regionPurpose.current = null
      setMode('text')
      return
    }
    // ExplanationStatusBar disables its area action until image capability is available.
    if (!displayOwner || displayOwner.token !== ownerSequence.current || !pdf || !snapshot) {
      setExplanationError(t('reader.notReady')); return
    }
    if (activeExplanation.excerpts.length >= MAX_EXPLANATION_EXCERPTS) {
      setExplanationError(t('reader.explain.limit')); return
    }
    clearSelection()
    clearAnnotation()
    setExplanationError('')
    regionPurpose.current = 'explanation'
    setMode('region')
  }
  const selectExplanationRegion = (page: number, region: { rect: PdfRect; quadPoints: number[] }): boolean => {
    if (!activeExplanation || regionPurpose.current !== 'explanation') return false
    regionPurpose.current = null
    if (explanationSending || explanationSaving || !snapshot) return true
    setMode('text')
    // Entry checks the limit; addExplanationRegion checks it again after capture.
    const next: ReaderSelection = { kind: 'region', revision: snapshot.revision, text: '',
      fragments: [{ page, rect: [...region.rect], quadPoints: [...region.quadPoints] }] }
    setSelection(next)
    explanationMarkerAnchor.current = null
    setExplanationEditor({ key: activeExplanation.key, kind: 'new', draftId: crypto.randomUUID(), selection: next, question: '' })
    setExplanationError('')
    return true
  }
  const takeScreenshot = async (page: number, region: { rect: PdfRect; quadPoints: number[] }) => {
    // Screenshot mode is a single action. Text selection resumes immediately.
    regionPurpose.current = null
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
    setScreenshotPhase('preparing')
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
      if (screenshotController.current === controller) { screenshotController.current = null; setScreenshotPhase(null) }
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
  const fragmentAnchor = (fragments: readonly { page: number; rect: PdfRect; quadPoints: readonly number[] }[]) => {
    if (!scrollRoot) return null
    const bounds = visibleReadingBounds(scrollRoot)
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
  const contextualAnchor = () => fragmentAnchor(activeExplanationEditor?.kind === 'new' ? activeExplanationEditor.selection.fragments
    : hasTextSelection ? selection!.fragments
      : selected?.rect ? [{ page: selected.page, rect: selected.rect, quadPoints: selected.quadPoints ?? [] }] : [])
  const commentAnchor = () => {
    const annotation = pendingNote ?? selected
    return annotation?.rect ? fragmentAnchor([{ page: annotation.page, rect: annotation.rect, quadPoints: annotation.quadPoints ?? [] }]) : null
  }
  const explanationEditorAnchor = () => {
    if (activeExplanationEditor?.kind === 'edit') {
      const marker = explanationMarkerAnchor.current
      return marker?.isConnected ? marker.getBoundingClientRect() : null
    }
    return activeExplanationEditor?.kind === 'new' ? contextualAnchor() : null
  }

  const pageCallbacks = useRef({ destination, jump, beginNote, takeScreenshot, selectExplanationRegion })
  pageCallbacks.current = { destination, jump, beginNote, takeScreenshot, selectExplanationRegion }
  const pageDestination = useCallback((value: unknown) => { void pageCallbacks.current.destination(value) }, [])
  const pageAction = useCallback((page: number, action: string) => {
    const last = state.current.snapshot?.document.pageCount ?? page
    void pageCallbacks.current.jump(action === 'FirstPage' ? 1 : action === 'LastPage' ? last : action === 'NextPage' ? page + 1 : page - 1)
  }, [])
  const pageNote = useCallback((page: number, point: number[]) => pageCallbacks.current.beginNote(page, point), [])
  const pageRegion = useCallback((page: number, region: Parameters<typeof takeScreenshot>[1]) => {
    if (!pageCallbacks.current.selectExplanationRegion(page, region)) void pageCallbacks.current.takeScreenshot(page, region)
  }, [])
  const editExplanationQuestion = useCallback((id: string, marker: HTMLElement) => {
    if (!activeExplanation || explanationSending) return
    const excerpt = activeExplanation.excerpts.find(item => item.id === id)
    if (!excerpt) return
    clearSelection()
    explanationMarkerAnchor.current = marker
    setExplanationEditor({ key: activeExplanation.key, kind: 'edit', excerptId: id, question: excerpt.question })
    setExplanationError('')
  }, [activeExplanation, explanationSending, clearSelection])
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
      rotation={0} zoom={zoom} fit={fit} size={size} scrollRoot={scrollRoot}
      scaleForPage={pageScale}
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
      explanationDraft={draftExplanationSelection?.fragments.at(-1)?.page === geometry.page
        ? { index: (activeExplanation?.excerpts.length ?? 0) + 1, fragment: draftExplanationSelection.fragments.at(-1)! }
        : undefined}
      onExplanationMark={editExplanationQuestion}
      onView={registerView} onDestination={pageDestination} onAction={pageAction}
      onAnnotation={selectAnnotation} onNote={pageNote} onRegion={pageRegion} onBackground={dismissContext} onError={notifyError} />} />
  }, [pdf, snapshot?.id, snapshot?.contentVersion, snapshot?.document.pages, mode, t, scrollRoot, annotationsByPage, renderedAnnotationsByPage,
    selected?.id, selected?.page, selection, activeExplanation, draftExplanationSelection, draggingPage, navigationTarget, ocrPages, zoom, fit, size, pageScale, registerView, pageDestination, pageAction,
    selectAnnotation, pageNote, pageRegion, editExplanationQuestion, dismissContext, notifyError])

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
  const closeCommentEditor = () => {
    setComment(selected?.contents ?? '')
    setPendingNote(null)
    setCommentCardOpen(false)
  }
  const renderCommentEditor = () => <div className="dsh-pdf-comment-editor" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); closeCommentEditor() }
  }}>
    <header className="dsh-pdf-comment-editor-header">
      <span className="dsh-pdf-comment-editor-title"><ToolbarIcon name="comment" />{t('reader.commentText')}</span>
      <button type="button" className="dsh-pdf-comment-editor-close" title={t('reader.cancel')} aria-label={t('reader.cancel')}
        onClick={closeCommentEditor}><ToolbarIcon name="close" /></button>
    </header>
    {selected && (selected.author || selected.createdAt || selected.modifiedAt) && <div className="dsh-pdf-comment-details">
      {selected.author && <strong>{selected.author}</strong>}
      {(selected.modifiedAt || selected.createdAt) && <span>
        {selected.modifiedAt && selected.modifiedAt !== selected.createdAt ? t('reader.modified') : t('reader.created')}{' '}
        {formatAnnotationDate(selected.modifiedAt || selected.createdAt!)}
      </span>}
    </div>}
    <label className="dsh-pdf-comment-editor-field"><span>{t('reader.commentText')}</span>
      <textarea ref={commentTextarea} value={comment} disabled={!!selected && !selected.editable}
        onChange={(event) => setComment(event.target.value)} rows={3} /></label>
    {selected?.readOnlyReason && <p className="dsh-pdf-muted">{t(`reader.reason.${selected.readOnlyReason}`)}</p>}
    <footer className="dsh-pdf-comment-editor-actions">
      <label className="dsh-pdf-comment-editor-color" title={t('reader.color')}>
        <span>{t('reader.color')}</span><input type="color" value={commentColor}
          disabled={!!selected && (!!snapshot?.document.readOnly || !selected.editable)}
          onChange={(event) => selected ? updateAnnotationColor(event.target.value) : setCommentColor(event.target.value)} />
      </label>
      {selected?.editable && <button type="button" className="dsh-pdf-comment-editor-delete" title={t('reader.delete')}
        aria-label={t('reader.delete')} disabled={!editable} onClick={() => void deleteAnnotation()}><ToolbarIcon name="discard" /></button>}
      <button type="button" className="dsh-pdf-comment-editor-apply"
        disabled={!editable || (!!selected && !selected.editable)} onClick={async () => {
          const patch = { contents: comment, color: colorFromHex(commentColor) }
          const next = pendingNote ? await change([{ type: 'add', annotation: { ...pendingNote, ...patch } }]) : selected ? await change([{ type: 'update', id: selected.id, patch }]) : undefined
          if (next && pendingNote) { setSelectedAnnotation(pendingNote.id); setPendingNote(null) }
        }}>{t('reader.applyComment')}</button>
    </footer>
  </div>
  const annotationPanel = <ScrollablePanel className="dsh-pdf-comments" verticalLabel={t('reader.verticalScroll')} horizontalLabel={t('reader.horizontalScroll')}>
    <AnnotationList key={`${snapshot?.id ?? 'none'}:${snapshot?.reader.bytesHash ?? 'none'}`} annotations={commentItems} selectedId={selectedAnnotation} pdf={pdf} t={t}
      onDeselect={clearAnnotation}
      onSelect={annotation => { selectAnnotation(annotation.id); void jump(annotation.page, annotation.rect ? { x: annotation.rect[0], y: annotation.rect[3] } : {}) }} />
  </ScrollablePanel>
  const activeOcrTranscript = snapshot && ocrTranscript
    && ocrTranscript.result.documentId === snapshot.id
    && ocrTranscript.result.contentVersion === snapshot.contentVersion ? ocrTranscript : null

  const navigateHistory = (depth?: number, revision?: number) => {
    navigationIntent.current++
    if (navigationLock.current) return
    const controller = new AbortController()
    activeNavigation.current = controller
    navigationLock.current = true; setNavigating(true)
    const signal = AbortSignal.any([tab.signal, controller.signal])
    const operation = depth === undefined ? history.current.back({ apply: applyPosition }, signal)
      : history.current.backTo(depth, revision!, { apply: applyPosition }, signal)
    let completed = false
    void operation
      .then(result => {
        if (result.status !== 'changed') return
        completed = true
        navigationCompleted.current++
        setHistoryRevision((n) => n + 1)
      })
      .catch((failure) => { if (!tab.signal.aborted && !isAbortError(failure)) notifyError(failure) })
      .finally(() => {
        if (activeNavigation.current === controller) activeNavigation.current = null
        navigationLock.current = false
        const next = pendingJump.current
        pendingJump.current = null
        if (next && !tab.signal.aborted) void jump(next.page, next.options, next.remember)
        else {
          setNavigating(false)
          if (completed && resumeFailed.current) {
            resumeFailed.current = false
            positionReady.current = true
          }
          rememberPosition()
        }
      })
  }
  const goBack = () => navigateHistory()

  const mainToolbar = <ToolbarTooltip><div className="dsh-pdf-toolbar dsh-pdf-main-toolbar" role="toolbar" aria-label={t('reader.sidebar.toolbar')}>
      <details className="dsh-pdf-tools" ref={toolsMenu} onToggle={event => {
        if (event.currentTarget.open) refreshOcrAvailability.current?.()
      }} onBlur={(event) => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false
      }}>
        <summary title={t('reader.tools')}><ToolbarIcon name="tools" /><span className="dsh-pdf-toolbar-label">{t('reader.tools')}</span> <span className="dsh-pdf-tools-chevron" aria-hidden="true">▾</span></summary>
        <div className="dsh-pdf-tools-menu" role="group" aria-label={t('reader.tools')}>
          <button disabled={!snapshot || !props.promptExplanation || props.allowReadingContext === false || explanationSending || !!screenshotPhase || !!screenshot}
            onClick={() => activeExplanation ? cancelExplanation() : startExplanation()}>
            {t(activeExplanation ? 'reader.explain.exit' : 'reader.explain.start')}
          </button>
          <button disabled={!pdf || busy || !!screenshotPhase || !!screenshot || !!activeExplanation} onClick={beginScreenshot}>{t('reader.regionScreenshot')}</button>
          <button disabled={!editable || !!screenshotPhase || !!screenshot || !!activeExplanation} onClick={() => {
            if (screenshotController.current) return
            regionPurpose.current = null
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
      <BackHistoryControl history={historySnapshot} disabled={busy || navigating} t={t}
        onBack={goBack} onBackTo={(depth, revision) => navigateHistory(depth, revision)} />
      {/* The zoom control stays enabled during a page jump. Navigation is locked
          internally, and fading this control for the length of a load is what
          reads as a flicker. */}
      <ZoomMenu fit={fit} zoom={zoom} t={t} onSelect={value => {
        if (navigationLock.current) return
        if (typeof value === 'number') { setFit('custom'); setZoom(value) }
        else setFit(value)
      }} />
      <span className="dsh-pdf-toolbar-divider" aria-hidden="true" />
      <button className="dsh-pdf-toolbar-undo" disabled={!snapshot?.canUndo || busy || colorPending}
        aria-label={t('reader.undo')} data-tooltip={t('reader.undo')}
        onClick={() => void act((current) => api.undo(sessionId, current.id, current.revision, tab.signal))}><ToolbarIcon name="undo" /></button>
      <button className="dsh-pdf-toolbar-redo" disabled={!snapshot?.canRedo || busy || colorPending}
        aria-label={t('reader.redo')} data-tooltip={t('reader.redo')}
        onClick={() => void act((current) => api.redo(sessionId, current.id, current.revision, tab.signal))}><ToolbarIcon name="redo" /></button>
      <button className="dsh-pdf-primary dsh-pdf-toolbar-save" disabled={!editable || !snapshot?.dirty}
        aria-label={t('reader.save')} data-tooltip={t('reader.save')}
        onClick={() => void save()}><ToolbarIcon name="save" /></button>
      <button className="dsh-pdf-toolbar-save-as" disabled={!editable}
        aria-label={t('reader.saveAs')} data-tooltip={t('reader.saveAs')}
        onClick={() => void beginSaveAs()}><ToolbarIcon name="saveAs" /></button>
      <button className="dsh-pdf-toolbar-discard" disabled={!snapshot || busy || saveAsPicking || colorPending || (!snapshot.dirty && !snapshot.conflict && !snapshot.canRedo && !hasUnappliedComment)}
        aria-label={t('reader.discard')} data-tooltip={t('reader.discardHelp')}
        onClick={() => void discardChanges()}><ToolbarIcon name="discard" /></button>
      </div>
    </div></ToolbarTooltip>
  const floatingStatuses: FloatingStatus[] = []
  if (saveFeedback) {
    const { kind, durationMs, occurrence } = saveFeedback
    floatingStatuses.push({ id: 'save', kind, className: 'dsh-pdf-save-feedback', activity: 'dot',
      content: t(kind === 'saving' ? 'reader.saving' : kind === 'saved' ? 'reader.saved' : 'reader.unsaved'),
      title: saveFeedback.path ?? snapshot?.path, durationMs, occurrence,
      onExpire: () => setSaveFeedback(current => current?.occurrence === occurrence ? null : current) })
  }
  if (mode === 'note' && !activeExplanation) floatingStatuses.push({ id: 'note-mode',
    content: t('reader.placeNote'),
    actions: [{ label: t('reader.cancel'), onClick: () => setMode('text') }] })
  if (mode === 'region' && regionPurpose.current === 'screenshot' && !activeExplanation) floatingStatuses.push({ id: 'region-selection',
    content: t('reader.screenshotHint'),
    actions: [{ label: t('reader.cancel'), onClick: cancelScreenshot }] })
  if (screenshotPhase) floatingStatuses.push({ id: 'screenshot', activity: 'progress',
    content: t(screenshotPhase === 'cancelling' ? 'reader.screenshotCancelling' : 'reader.screenshotPreparing'),
    actions: [{ label: t('reader.cancel'), onClick: cancelScreenshot, disabled: screenshotPhase === 'cancelling' }] })
  if (ocrProgress) floatingStatuses.push({ id: 'ocr', activity: 'progress',
    content: t(ocrProgress === 'preparing' ? 'reader.ocrPreparing'
      : ocrProgress === 'recognizing' ? 'reader.recognizing' : 'reader.ocrCancelling'),
    actions: [{ label: t('reader.cancel'), onClick: cancelOcr, disabled: ocrProgress === 'cancelling' }] })
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
      active={!activeExplanation && hasTextSelection && mode === 'text'}>
      <ToolbarTooltip><div className="dsh-pdf-selection-actions">
        <button type="button" className="dsh-pdf-selection-icon-action"
          aria-label={t(textCopied ? 'reader.textCopied' : 'reader.copyText')}
          data-tooltip={t(textCopied ? 'reader.textCopied' : 'reader.copyText')}
          onClick={() => void copyText()}><ToolbarIcon name="copy" /></button>
        {props.promptExplanation && props.allowReadingContext !== false && <button type="button"
          className="dsh-pdf-selection-icon-action" disabled={explanationSending}
          aria-label={t('reader.explain.askQuestion')}
          data-tooltip={t('reader.explain.askQuestion')}
          onClick={() => startExplanation(selection ?? undefined)}><ToolbarIcon name="explain" /></button>}
        <button type="button" className="dsh-pdf-selection-icon-action" aria-label={t('reader.translateSelection')}
          data-tooltip={t('reader.translateSelection')} onClick={beginTranslation}><ToolbarIcon name="translate" /></button>
        {!activeExplanation && <>
          <span className="dsh-pdf-selection-actions-divider" aria-hidden="true" />
          <SelectionHighlightControl value={color} active={hasTextSelection && mode === 'text'} disabled={!editable} t={t}
            onHighlight={hex => { setColor(hex); void mark('Highlight', hex) }} />
          <button type="button" className="dsh-pdf-selection-icon-action" disabled={!editable}
            aria-label={t('reader.underline')} data-tooltip={t('reader.underline')}
            onClick={() => void mark('Underline')}><ToolbarIcon name="underline" /></button>
          <button type="button" className="dsh-pdf-selection-icon-action" disabled={!editable}
            aria-label={t('reader.strike')} data-tooltip={t('reader.strike')}
            onClick={() => void mark('StrikeOut')}><ToolbarIcon name="strike" /></button>
          <button type="button" className="dsh-pdf-selection-icon-action" disabled={!editable}
            aria-label={t('reader.note')} data-tooltip={t('reader.note')} onClick={() => {
              const fragment = selection?.fragments[0]
              if (fragment) { beginNote(fragment.page, [fragment.rect[0], fragment.rect[3]]); clearSelection() }
            }}><ToolbarIcon name="note" /></button>
        </>}
        <span className="dsh-pdf-selection-actions-divider" aria-hidden="true" />
        <button type="button" className="dsh-pdf-selection-icon-action" aria-label={t('reader.clearSelection')}
          data-tooltip={t('reader.clearSelection')} onClick={clearSelection}><ToolbarIcon name="close" /></button>
      </div></ToolbarTooltip>
    </FloatingToolbar>
    {selected && !commentCardOpen && <FloatingToolbar viewport={scrollRoot} getAnchor={contextualAnchor} label={t('reader.selectedAnnotation')}
      className="dsh-pdf-annotation-toolbar">
      <span className="dsh-pdf-annotation-kind" title={t('reader.selectedAnnotation')}>
        {/* A text mark is identified by its own action icon; a note keeps its color dot. */}
        {selectedMarkIcon ? <ToolbarIcon name={selectedMarkIcon} />
          : <span className="dsh-pdf-annotation-kind-color" style={{ backgroundColor: commentColor }} aria-hidden="true" />}
        {selected.supported ? t(`reader.type.${selected.subtype}`) : selected.subtype}
      </span>
      <span className="dsh-pdf-annotation-actions-divider" aria-hidden="true" />
      <AnnotationColorBar value={commentColor}
        disabled={!!snapshot?.document.readOnly || !selected.editable}
        label={t('reader.annotationColor')} t={t} onQuickColor={updateAnnotationColor} onPaletteColor={updateAnnotationColor} />
      <span className="dsh-pdf-annotation-actions-divider" aria-hidden="true" />
      <button className="dsh-pdf-annotation-action" title={t('reader.commentText')} aria-label={t('reader.commentText')}
        onClick={openCommentEditor}><ToolbarIcon name="comment" /></button>
      <button className="dsh-pdf-annotation-action dsh-pdf-annotation-action-danger" title={t('reader.delete')}
        aria-label={t('reader.delete')} disabled={!editable || !selected.editable} onClick={() => void deleteAnnotation()}>
        <ToolbarIcon name="discard" />
      </button>
      <span className="dsh-pdf-annotation-actions-divider" aria-hidden="true" />
      <button className="dsh-pdf-annotation-action" title={t('reader.deselectAnnotation')}
        aria-label={t('reader.deselectAnnotation')} onClick={clearAnnotation}><ToolbarIcon name="close" /></button>
    </FloatingToolbar>}
    {snapshot?.document.readOnly && <div className="dsh-pdf-notice">{t(snapshot.document.readOnlyReason === 'encrypted-document' ? 'reader.encryptedReadOnly' : 'reader.signedReadOnly')}</div>}
    {error && <div className="dsh-pdf-error" role="alert"><span>{error}</span><button aria-label={t('reader.dismiss')} onClick={() => setError('')}>×</button></div>}
    {snapshot?.warning && <div className="dsh-pdf-notice" role="status">{snapshot.warning}</div>}
    {positionNotice && <div className="dsh-pdf-notice" role="status">{positionNotice}
      <button aria-label={t('reader.dismiss')} onClick={() => setPositionNotice('')}>×</button></div>}
    {snapshot?.conflict && <div className="dsh-pdf-notice" role="status">{t('reader.conflict')}<button disabled={!editable} onClick={() => void beginSaveAs()}>{t('reader.saveAs')}</button></div>}
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
        <FloatingStatusRail statuses={floatingStatuses}>
          {activeExplanation && <ExplanationStatusBar count={activeExplanation.excerpts.length}
          max={MAX_EXPLANATION_EXCERPTS} sending={explanationSending || explanationSaving}
          disabled={!!activeExplanationEditor}
          imageAvailable={imageAvailability?.status === 'available'}
          imageReason={imageAvailability?.status === 'unavailable' ? imageAvailability.reason
            : imageAvailability?.status === 'available' ? imageAvailability.limitation
              : t('reader.explain.imageChecking')}
          selectingArea={mode === 'region' && regionPurpose.current === 'explanation'} onSelectArea={beginExplanationRegion}
          error={explanationError} t={t} onSend={() => void submitExplanation()} onExit={cancelExplanation} />}
        </FloatingStatusRail>
      </div>
      {activeExplanationEditor && <ExplanationQuestionEditor
        key={activeExplanationEditor.kind === 'new' ? activeExplanationEditor.draftId : activeExplanationEditor.excerptId}
        viewport={scrollRoot} getAnchor={explanationEditorAnchor} mode={activeExplanationEditor.kind}
        index={activeExplanationEditor.kind === 'new' ? (activeExplanation?.excerpts.length ?? 0) + 1
          : (activeExplanation?.excerpts.findIndex(item => item.id === activeExplanationEditor.excerptId) ?? -1) + 1}
        question={activeExplanationEditor.question} disabled={explanationSending || explanationSaving} t={t}
        onChange={value => setExplanationEditor(current => current && current.key === explanationKey
          ? { ...current, question: value } : current)}
        onSave={() => { void saveExplanationQuestion() }} onCancel={cancelExplanationEditor}
        onDelete={activeExplanationEditor.kind === 'edit' ? deleteExplanationQuestion : undefined} />}
      {commentCardOpen && (selected || pendingNote) && <AnnotationCommentCard viewport={scrollRoot} getAnchor={commentAnchor}
        label={t('reader.commentText')}
        onVisible={() => { if (handledCommentFocus.current !== commentFocusRequest) setCommentFocusRequest(current => current + 1) }}>
        {renderCommentEditor()}
      </AnnotationCommentCard>}
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
        onPageInputSubmit={value => {
          // PageNavigation synchronously validates the integer and PDF range.
          const page = Number(value)
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
          search: <ScrollablePanel className="dsh-pdf-search-panel" verticalLabel={t('reader.verticalScroll')} horizontalLabel={t('reader.horizontalScroll')}
            header={<div className="dsh-pdf-panel-heading"><h3>{t('reader.search')}</h3></div>}>
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
