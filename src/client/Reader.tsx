import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PdfRect } from '../core/pdf-types.js'
import type { ReaderProps } from './contracts.js'
import type { AgentNavigationRequest } from '../contracts/navigation.js'
import type { WorkspaceSnapshot } from '../shared/contracts.js'
import { readerLifetime, ReaderPage, ReaderView, useReaderContextLease, useReaderExplanation, useReaderNavigation, useReaderOcr,
  useReaderAnnotations, useReaderScreenshot, useReaderSearch, useReaderSave, useReaderSidebarLayout, useReaderPages,
  useReaderTranslation, useReaderDocument, useReaderSelection, useReaderMutations, useReaderPageTracking,
  usePdfWheelZoom, usePdfViewportSize, useReaderIndexing, useReaderFormCommits, ReaderFormCommitProvider,
  clampPdfRectToBounds, movePdfNoteRectByMarker, noteMarkerViewportPosition, pdfRectToViewport, NativeViewport, readingViewportBounds,
  readerToolbarModel, readerFloatingStatuses, readerModeStatus, readerOverlayModel, readerSidebarPanels,
  navigateAgentRequest,
  type ReaderSelection,
  } from '../modules/viewer/index.js'
import { joinPageText } from '../shared/page-text.js'

const formCommitIdentity = (sessionId: string, snapshot: WorkspaceSnapshot | null) =>
  JSON.stringify([sessionId, snapshot?.id, snapshot?.contentVersion, snapshot?.document.readOnly])

export function Reader(props: ReaderProps) {
  const { api, t, settings, sessionId } = props
  const { tab } = props.useTabInfo()
  const lifetime = readerLifetime(sessionId, tab.id, tab.signal, settings.historyCapacity)
  const [error, setError] = useState('')
  const [positionNotice, setPositionNotice] = useState('')
  const [size, setSize] = useState({ width: 600, height: 700 })
  const [zoom, setZoom] = useState(1)
  const [fit, setFit] = useState<'custom' | 'width' | 'page'>('width')
  const [mode, setMode] = useState<'text' | 'region' | 'note'>('text')
  const [draggingPage, setDraggingPage] = useState<number | null>(null)
  const toolsMenu = useRef<HTMLDetailsElement>(null)
  const readerElement = useRef<HTMLDivElement>(null)
  const readerBody = useRef<HTMLDivElement>(null)
  // Both actions use the page's rectangle drag, but only the explanation
  // action may turn its result into a question draft.
  const regionPurpose = useRef<'explanation' | 'screenshot' | null>(null)
  const callbacks = useRef(props)
  callbacks.current = props
  const notifyError = useCallback((value: unknown) => {
    const needsPassword = value instanceof Error && (('code' in value && value.code === 'password-required') || value.name === 'PasswordException')
    const message = needsPassword ? callbacks.current.t('reader.passwordRequired') : value instanceof Error ? value.message : String(value)
    setError(message)
  }, [])
  const documentState = useReaderDocument({ api, sessionId, resourceAddress: props.resourceAddress,
    content: props.content, tabSignal: tab.signal, onError: notifyError,
    onResourceSwitch: () => {
      readerSelection.reset()
      screenshotCtl.reset()
      explanation.captureController.current?.abort()
      translation.reset()
      setDraggingPage(null)
      setMode('text')
      annotations.resetResource()
      setError('')
    },
    onNativeOpened: () => { search.invalidateDocument(); views.current.clear() },
    releaseRegionCapture: () => {
      explanation.captureController.current?.abort()
      return explanation.captureTask.current
    } })
  const { snapshot, setSnapshot, displayOwner, pdf, pdfAnnotations, ownerSequence, documentReady, waitForReady } = documentState
  const indexing = useReaderIndexing({ api: props.indexingApi, sessionId, documentId: snapshot?.id,
    signal: tab.signal, t, onError: notifyError })
  const { scrollRoot, currentPage, setCurrentPage, pageInput, setPageInput, editPageInput,
    views, registerView, scrollRef, updateScrolledPage } = useReaderPageTracking({ snapshot,
    readerElement, scrollportRef: props.scrollportRef })
  const readerSelection = useReaderSelection({ mode, scrollRoot, snapshot, views, ownerSequence,
    currentSnapshot: () => state.current.snapshot, tabSignal: tab.signal, setDraggingPage,
    shouldIgnore: next => explanation.sameDraftSelection(next),
    onCaptured: next => {
      if (next) setSelectedAnnotation(undefined)
      explanation.offerTextSelection(next)
    },
    onError: notifyError, t })
  const { selection, setSelection, textCopied, hasTextSelection, reset: resetSelection,
    clear: clearSelection, capture: captureSelection, scheduleCapture: scheduleCaptureSelection,
    copyText, fragmentAnchor } = readerSelection
  const state = useRef({ snapshot, scrollRoot, zoom, fit, size, currentPage })
  state.current = { snapshot, scrollRoot, zoom, fit, size, currentPage }
  const { busy, operationLock, act, change } = useReaderMutations({ api, sessionId,
    tabSignal: tab.signal, ownerSequence, currentSnapshot: () => state.current.snapshot,
    acceptSnapshot: next => { state.current.snapshot = next; setSnapshot(next) },
    clearError: () => setError(''), onError: notifyError })
  const formIdentity = formCommitIdentity(sessionId, snapshot)
  const changeFormField = useCallback(async (fieldId: string, value: string | boolean | string[]) => {
    const current = state.current.snapshot
    if (!current || current.document.readOnly || tab.signal.aborted
      || displayOwner?.token !== ownerSequence.current
      || formCommitIdentity(callbacks.current.sessionId, current) !== formIdentity) return false
    return !!await change([{ type: 'set-field', fieldId, value }])
  }, [change, tab.signal, displayOwner?.token, ownerSequence, formIdentity])
  const formCommits = useReaderFormCommits({ identity: formIdentity, onError: notifyError, commit: changeFormField })
  const commandContext = useRef({ formIdentity, displayOwner, flush: formCommits.flush })
  commandContext.current = { formIdentity, displayOwner, flush: formCommits.flush }
  const runAfterFormFlush = useCallback(async <Result,>(operation: () => Result | Promise<Result>): Promise<Result | undefined> => {
    const ownsDocument = (owner: number | false) => owner !== false && documentReady()
      && owner === ownerSequence.current && commandContext.current.displayOwner?.token === owner
      && commandContext.current.formIdentity === formIdentity && !!state.current.snapshot
      && formCommitIdentity(callbacks.current.sessionId, state.current.snapshot) === formIdentity
    // Commands suspended behind a field write still belong to the document
    // that received them. A same-resource reload may replace its display owner
    // while the command waits, so use the latest form owner after it is ready.
    if (!ownsDocument(await waitForReady()) || !await commandContext.current.flush()
      || !ownsDocument(await waitForReady())) return
    return operation()
  }, [formIdentity, ownerSequence, documentReady, waitForReady])
  const actAfterFormFlush: typeof act = (operation, conflictOnStaleSave) =>
    runAfterFormFlush(() => act(operation, conflictOnStaleSave))
  const navigation = useReaderNavigation({ api, sessionId, tabSignal: tab.signal,
    contentRevision: props.content.revision, pdf, snapshot, scrollRoot, currentPage,
    historyCapacity: settings.historyCapacity, lifetime, state, views, setCurrentPage,
    setPageInput, setZoom, setFit, setPositionNotice, onError: notifyError, t })
  const { pageScale, jump: jumpWithoutFormFlush, destination: destinationWithoutFormFlush,
    navigateHistory: navigateHistoryWithoutFormFlush, navigationLock,
    navigationTarget, navigating, historySnapshot } = navigation
  const jump = useCallback(async (...args: Parameters<typeof jumpWithoutFormFlush>) =>
    !!await runAfterFormFlush(() => jumpWithoutFormFlush(...args)), [jumpWithoutFormFlush, runAfterFormFlush])
  const destination = useCallback((value: unknown) =>
    runAfterFormFlush(() => destinationWithoutFormFlush(value)), [destinationWithoutFormFlush, runAfterFormFlush])
  const navigateHistory = (depth?: number, revision?: number) => {
    void runAfterFormFlush(() => navigateHistoryWithoutFormFlush(depth, revision))
  }
  const agentView = useRef({ pdf, visible: tab.visible, ready: documentReady })
  agentView.current = { pdf, visible: tab.visible, ready: documentReady }
  const navigateEvidence = useCallback(async (request: AgentNavigationRequest, signal: AbortSignal) =>
    await runAfterFormFlush(() => navigateAgentRequest(request, signal, {
      current: () => ({ snapshot: state.current.snapshot, document: agentView.current.pdf,
        visible: agentView.current.visible && !tab.signal.aborted, ready: agentView.current.ready(),
        viewportHeight: state.current.scrollRoot?.clientHeight ?? 0 }),
      subscribe: (id, changed) => api.subscribe(id, changed), jump,
    })) ?? 'unavailable', [api, jump, tab.signal, runAfterFormFlush])
  const evidenceReady = documentReady()
  useLayoutEffect(() => {
    if (!props.evidenceNavigation || !tab.visible || !snapshot || !pdf || !evidenceReady) return
    return props.evidenceNavigation.register({ sessionId, snapshot,
      current: () => !tab.signal.aborted && state.current.snapshot === snapshot ? snapshot : null,
      readPageText: async (page, signal) => joinPageText((await pdf.text(page, signal)).items),
      jump: page => jump(page),
      navigateTarget: (page, target, signal) => navigateEvidence({ requestId: crypto.randomUUID(),
        page, documentId: snapshot.id, contentVersion: snapshot.contentVersion, target }, signal),
    })
  }, [props.evidenceNavigation, tab.visible, tab.signal, sessionId, snapshot, pdf, jump, navigateEvidence, evidenceReady])
  const sidebar = useReaderSidebarLayout({ bodyRef: readerBody, navigationLock, navigating,
    resourceAddress: props.resourceAddress, visible: tab.visible })
  const { section: sidebarSection, expanded: sidebarExpanded,
    changeExpanded: changeSidebarExpanded, show: showSidebar } = sidebar
  const translation = useReaderTranslation({ translation: props.translation, sessionId,
    tabSignal: tab.signal, snapshot, displayOwnerToken: displayOwner?.token ?? null,
    ownerSequence, currentSnapshot: () => state.current.snapshot, selection,
    targetLanguage: settings.translationTargetLanguage, engine: settings.translationEngine,
    timeoutMs: settings.translationTimeoutMs, showSidebar: () => showSidebar('translation') })
  const { begin: beginTranslation, close: closeTranslation } = translation
  useReaderContextLease({ sessionId, tabId: tab.id, visible: tab.visible, tabSignal: tab.signal,
    snapshot, currentPage, documentReady: documentReady(),
    enabled: !!props.allowReadingContext, report: props.reportReadingContext,
    agentNavigation: props.agentNavigation,
    onAgentNavigate: navigateEvidence })
  useLayoutEffect(() => () => {
    // Layout cleanup captures geometry before React detaches the page elements.
    navigation.persistOnUnmount()
    explanation.captureController.current?.abort()
    screenshotController.current?.abort()
    search.cancel()
  }, [])
  useEffect(() => {
    if (!snapshot) return
    if (navigation.resetForDocument(snapshot.contentVersion)) {
      annotations.resetContent()
      translation.reset()
      ocr.resetContent()
      search.resetContent()
      lifetime.position = undefined
    }
    lifetime.contentVersion = snapshot.contentVersion
    resetSelection()
  }, [snapshot?.contentVersion])
  useEffect(() => {
    resetSelection()
    setMode('text')
    screenshotCtl.reset()
    explanation.captureController.current?.abort()
  }, [snapshot?.revision, snapshot?.id])
  const annotations = useReaderAnnotations({ snapshot, pdfAnnotations, selection, setSelection, setMode,
    ownerSequence, operationLock, currentSnapshot: () => state.current.snapshot, change, t })
  const { color, setColor, selectedAnnotation, setSelectedAnnotation, selected, selectedNote,
    pendingNote, thread, setComment, annotationColor, colorPending,
    annotationItems, annotationsByPage, renderedAnnotationsByPage, hasUnappliedAnnotation,
    mark, beginNote, selectAnnotation, clearAnnotation, deleteAnnotation,
    updateColor: updateAnnotationColor, openCommentEditor, closeCommentEditor, applyComment, applyNote } = annotations
  const saveFlow = useReaderSave({ api, sessionId, resourceAddress: props.resourceAddress, tabSignal: tab.signal,
    snapshot, ownerSequence, operationLock, currentSnapshot: () => state.current.snapshot, act: actAfterFormFlush,
    pickSavePath: props.pickSavePath, openResource: address => tab.actions.openResource(address, { replaceTab: true }),
    addressForPath: props.addressForPath ?? (() => { throw new Error('PDF resource address adapter is unavailable') }),
    setError, onError: notifyError, t })
  const { feedback: saveFeedback, setFeedback: setSaveFeedback, showFeedback: showSaveFeedback,
    saveAsOpen, setSaveAsOpen, saveAsPicking, savePath, setSavePath, overwrite, setOverwrite,
    target, targetChecking, reloadConfirm, setReloadConfirm, save, beginSaveAs } = saveFlow
  const beginSaveAsAfterFormFlush = () => { void runAfterFormFlush(beginSaveAs) }
  const editable = !!snapshot && !snapshot.document.readOnly && !busy && !saveAsPicking && !colorPending
  const screenshotCtl = useReaderScreenshot({ pdf, snapshot,
    tabSignal: tab.signal, displayOwnerToken: displayOwner?.token ?? null, ownerSequence,
    regionPurpose, currentSnapshot: () => state.current.snapshot,
    documentReady,
    setMode, setSelection, clearSelection, clearAnnotation,
    closeToolsMenu: () => { if (toolsMenu.current) toolsMenu.current.open = false },
    clearError: () => setError(''), onError: notifyError, t })
  const { screenshot, phase: screenshotPhase, controller: screenshotController,
    takeRegion: takeScreenshot } = screenshotCtl
  const ocr = useReaderOcr({ api: props.hostOcr, sessionId, visible: tab.visible, tabSignal: tab.signal,
    snapshot, currentPage, lifetime, screenshot, t, currentSnapshot: () => state.current.snapshot,
    onError: notifyError, onRecognized: () => { showSidebar('ocr'); setSelection(null) } })
  const { ocrPages, ocrAvailability, ocrTranscript, ocrProgress } = ocr
  const search = useReaderSearch({ document: pdf, pages: snapshot?.document.pages ?? [], ocrPages,
    tabSignal: tab.signal, onError: notifyError })
  const recognize = async (requestedRegion?: { page: number; rect: PdfRect }) => {
    if (!pdf) return
    setError('')
    await ocr.recognize(requestedRegion)
  }
  const cancelOcr = ocr.cancel
  const explanation = useReaderExplanation({ sessionId, tabSignal: tab.signal, visible: tab.visible,
    snapshot, pdf, promptExplanation: props.promptExplanation,
    promptTemplate: settings.explanationPromptTemplate,
    promptGuidance: { general: settings.explanationGeneralInstruction,
      text: settings.explanationTextInstruction, image: settings.explanationImageInstruction },
    regionEvidence: props.regionEvidence, textSelectionEvidence: props.textSelectionEvidence,
    imageUnderstanding: props.imageUnderstanding, allowReadingContext: props.allowReadingContext !== false,
    screenshotBusy: !!screenshotController.current || !!screenshotPhase || !!screenshot,
    displayReady: !!displayOwner && displayOwner.token === ownerSequence.current,
    mode, regionPurpose, ownerSequence, currentSnapshot: () => state.current.snapshot,
    inspectSource: (path, signal) => api.inspectTarget(sessionId, path, signal).then(result => result.version),
    documentReady,
    setMode, setSelection, clearSelection, clearAnnotation,
    closeToolsMenu: () => { if (toolsMenu.current) toolsMenu.current.open = false }, t })
  const { active: activeExplanation, editor: activeExplanationEditor, draftSelection: draftExplanationSelection,
    sending: explanationSending } = explanation
  const { cancel: cancelExplanation, selectRegion: selectExplanationRegion } = explanation
  const dismissContext = useCallback(() => {
    if (hasUnappliedAnnotation) return
    regionPurpose.current = null
    clearAnnotation(); clearSelection(); explanation.setEditor(null); setComment(''); setMode('text')
  }, [hasUnappliedAnnotation, clearAnnotation, clearSelection])
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
  const discardChanges = async () => {
    if (operationLock.current) return
    const next = await actAfterFormFlush(current => api.discard(sessionId, current.id, current.revision, tab.signal))
    if (next) { showSaveFeedback(null); dismissContext(); annotations.clearPending(); setSaveAsOpen(false); setReloadConfirm(false); screenshotCtl.reset() }
  }
  const cancelScreenshot = screenshotCtl.cancel
  const beginScreenshot = () => screenshotCtl.begin(!!activeExplanation)
  const contextualAnchor = () => fragmentAnchor(activeExplanationEditor?.kind === 'new' ? activeExplanationEditor.selection.fragments
    : hasTextSelection ? selection!.fragments
      : selected?.rect ? [{ page: selected.page, rect: selected.rect, quadPoints: selected.quadPoints ?? [] }] : [])
  const commentAnchor = () => {
    const annotation = selected && !selectedNote ? selected : undefined
    return annotation?.rect ? fragmentAnchor([{ page: annotation.page, rect: annotation.rect, quadPoints: annotation.quadPoints ?? [] }]) : null
  }
  const commentPosition = () => {
    const annotation = selected && !selectedNote ? selected : undefined
    const view = annotation && views.current.get(annotation.page)
    const pageBounds = view?.element.getBoundingClientRect()
    if (!annotation?.commentPosition || !view || !pageBounds) return null
    const [x, y] = view.viewport.convertToViewportPoint(...annotation.commentPosition)
    return new DOMRect(pageBounds.left + x * pageBounds.width / view.viewport.width,
      pageBounds.top + y * pageBounds.height / view.viewport.height, 0, 0)
  }
  const moveCommentCard = async (_delta: { x: number; y: number }, position: { left: number; top: number }) => {
    const annotation = selected && !selectedNote ? selected : undefined
    const view = annotation && views.current.get(annotation.page)
    const pageBounds = view?.element.getBoundingClientRect()
    if (!annotation || !view || !pageBounds) return false
    const point = view.viewport.convertToPdfPoint(
      (position.left - pageBounds.left) * view.viewport.width / pageBounds.width,
      (position.top - pageBounds.top) * view.viewport.height / pageBounds.height,
    )
    return annotations.moveCommentCard([point[0], point[1]])
  }
  const noteAnchor = () => {
    const annotation = pendingNote ?? selectedNote
    const view = annotation && views.current.get(annotation.page)
    const pageBounds = view?.element.getBoundingClientRect()
    if (!annotation?.rect || !view || !pageBounds) return null
    const position = noteMarkerViewportPosition(view.viewport, annotation.rect)
    const scaleX = pageBounds.width / view.viewport.width, scaleY = pageBounds.height / view.viewport.height
    return new DOMRect(pageBounds.left + position.left * scaleX, pageBounds.top + position.top * scaleY,
      22 * scaleX, 22 * scaleY)
  }
  const moveNoteCard = async (delta: { x: number; y: number }) => {
    const annotation = pendingNote ?? selectedNote
    if (!annotation?.rect) return false
    const view = views.current.get(annotation.page)
    const pageBounds = view?.element.getBoundingClientRect()
    if (!view || !pageBounds || pageBounds.width <= 0 || pageBounds.height <= 0) return false
    const moved = movePdfNoteRectByMarker(view.viewport, annotation.rect,
      delta.x * view.viewport.width / pageBounds.width,
      delta.y * view.viewport.height / pageBounds.height)
    const cropBox = state.current.snapshot?.document.pages[annotation.page - 1]?.cropBox
    return annotations.moveNote(cropBox ? clampPdfRectToBounds(moved, cropBox) : moved)
  }
  const moveNoteMarker = async (id: string, page: number, delta: { x: number; y: number }) => {
    const document = state.current.snapshot?.document
    const annotation = document?.annotations.find(item => item.id === id && item.page === page)
    const view = views.current.get(page)
    const pageBounds = view?.element.getBoundingClientRect()
    if (!annotation?.rect || !view || !pageBounds || pageBounds.width <= 0 || pageBounds.height <= 0) return false
    const moved = movePdfNoteRectByMarker(view.viewport, annotation.rect,
      delta.x * view.viewport.width / pageBounds.width,
      delta.y * view.viewport.height / pageBounds.height)
    const cropBox = document?.pages[page - 1]?.cropBox
    return annotations.moveNoteMarker(id, cropBox ? clampPdfRectToBounds(moved, cropBox) : moved)
  }
  const explanationEditorAnchor = () => {
    if (activeExplanationEditor?.kind === 'edit') {
      const marker = explanation.markerAnchor.current
      const id = activeExplanationEditor.excerptId
      return marker?.isConnected ? marker.getBoundingClientRect()
        : fragmentAnchor(activeExplanation?.excerpts.find(item => item.id === id)?.fragments ?? [])
    }
    return activeExplanationEditor?.kind === 'new' ? contextualAnchor() : null
  }
  const latestExplanation = useRef(explanation)
  latestExplanation.current = explanation
  const revealExplanationQuestion = async (fragments: ReadonlyArray<ReaderSelection['fragments'][number]>, key: string, owner: number) => {
    const ownsTarget = () => !tab.signal.aborted && ownerSequence.current === owner && latestExplanation.current.key === key
    const fragment = fragments[0]
    if (!fragment || !ownsTarget()) return false
    const anchor = fragmentAnchor(fragments)
    const safe = scrollRoot && readingViewportBounds(scrollRoot)
    const visible = anchor && safe && anchor.left >= safe.left && anchor.right <= safe.right
      && anchor.top >= safe.top + 16 && anchor.bottom <= safe.bottom - 16
    let ready: boolean
    if (visible) ready = !!await runAfterFormFlush(() => true)
    else {
      const geometry = state.current.snapshot?.document.pages[fragment.page - 1]
      if (!geometry) return false
      const viewport = new NativeViewport(geometry, 1, geometry.rotation)
      const rect = pdfRectToViewport(viewport, fragment.rect)
      const [x, y] = viewport.convertToPdfPoint(rect[0], rect[1])
      ready = await jump(fragment.page, { x, y, viewportAnchor: { x: 0.08, y: 0.2 } })
    }
    return ready && ownsTarget()
  }
  const startExplanation = (initialSelection?: ReaderSelection) => {
    const current = latestExplanation.current
    const key = current.key, owner = ownerSequence.current
    const pending = current.start(initialSelection)
    if (!pending || !key) return
    void revealExplanationQuestion(pending, key, owner).then(ready => {
      const next = latestExplanation.current
      if (!ready && !tab.signal.aborted && ownerSequence.current === owner && next.active?.key === key) {
        // Keep a question paused rather than trapping the mode behind an
        // offscreen editor if navigation could not restore its position.
        next.cancel()
        notifyError(t('reader.notReady'))
      }
    })
  }
  const editExplanationQuestion = async (id: string) => {
    const current = latestExplanation.current
    if (!current.active || current.editor || current.sending || current.saving || navigationLock.current) return
    const excerpt = current.active.excerpts.find(item => item.id === id)
    if (!excerpt) return
    const key = current.active.key, owner = ownerSequence.current
    if (!await revealExplanationQuestion(excerpt.fragments, key, owner)) return
    const next = latestExplanation.current
    if (next.active?.key === key && next.active.excerpts.some(item => item.id === id)) next.editQuestion(id)
  }

  const pageElements = useReaderPages({ PageComponent: ReaderPage, pdf, snapshot, selection,
    selectedAnnotation: selected, annotationsByPage, renderedAnnotationsByPage, activeExplanation,
    draftExplanationSelection, draggingPage, navigationTarget, ocrPages, zoom, fit, size,
    scrollRoot, mode, t, pageScale, registerView, destination, jump,
    currentPageCount: () => state.current.snapshot?.document.pageCount, beginNote,
    takeScreenshot, selectExplanationRegion, editExplanationQuestion: explanation.editQuestion,
    selectAnnotation, moveNoteMarker, dismissContext, notifyError, onFormChange: changeFormField })

  const wheelScale = useCallback((page: number) => {
    const geometry = state.current.snapshot?.document.pages[page - 1]
    return geometry ? pageScale(geometry) : state.current.zoom
  }, [pageScale])
  const applyWheelScale = useCallback((scale: number) => { setFit('custom'); setZoom(scale) }, [])
  usePdfWheelZoom({ root: scrollRoot, enabled: !!pdf && !busy && !navigating, views: views.current,
    getScale: wheelScale, onScale: applyWheelScale, ownerKey: `${snapshot?.id}:${snapshot?.contentVersion}` })
  usePdfViewportSize({ root: scrollRoot, size, onSize: setSize,
    ownerKey: `${snapshot?.id}:${snapshot?.contentVersion}:${fit}` })
  const sidebarPanels = readerSidebarPanels({ snapshot, pdf, annotations: annotationItems,
    selectedAnnotation, clearAnnotation, selectAnnotation,
    jump: (page, point) => { void jump(page, point) }, ocrTranscript, search, translation,
    rememberTargetLanguage: props.rememberTranslationTargetLanguage,
    translationEngine: settings.translationEngine, translationRegistry: props.translation, indexing: indexing.control,
    t })
  const goBack = () => navigateHistory()

  const closeToolsMenu = () => { if (toolsMenu.current) toolsMenu.current.open = false }
  const toolbar = readerToolbarModel({
    snapshot, sessionId, signal: tab.signal, api, act: actAfterFormFlush, busy, editable, colorPending,
    formPending: formCommits.pending, readOnly: !!snapshot?.document.readOnly,
    runCommand: operation => { void runAfterFormFlush(operation) },
    saveAsPicking, hasUnappliedAnnotation, saveFeedback,
    explanation: {
      allowed: !!props.promptExplanation && props.allowReadingContext !== false,
      active: !!activeExplanation, sending: explanationSending,
      start: () => startExplanation(), cancel: cancelExplanation,
    },
    screenshot: {
      active: !!screenshot, preparing: !!screenshotPhase, begin: beginScreenshot,
      canPlaceNote: () => !screenshotController.current,
      clearRegionPurpose: () => { regionPurpose.current = null },
    },
    ocr: {
      busy: !!ocrProgress, availability: ocrAvailability, refresh: ocr.refreshAvailability,
      recognize: () => { void recognize() },
    },
    navigation: {
      canGoBack: navigation.canGoBack, navigating, history: historySnapshot, fit, zoom,
      back: (depth, revision) => depth === undefined ? goBack() : navigateHistory(depth, revision),
      canZoom: () => !navigationLock.current, setFit, setZoom,
    },
    commands: {
      clearSelection, clearAnnotation, setMode, closeMenu: closeToolsMenu,
      confirmReload: () => setReloadConfirm(true),
      beginSaveAs: beginSaveAsAfterFormFlush,
      discardChanges: () => { void discardChanges() },
      save: () => { void save() },
    },
  })
  const floatingOptions = {
    saveFeedback, documentPath: snapshot?.path, mode, explanationActive: !!activeExplanation,
    regionPurpose: regionPurpose.current, screenshotPhase, ocrProgress, t,
    onSaveExpired: (occurrence: number) => setSaveFeedback(current => current?.occurrence === occurrence ? null : current),
    onExitNote: () => setMode('text'), onCancelScreenshot: cancelScreenshot, onCancelOcr: cancelOcr,
    explanation: { sending: explanation.sending, error: explanation.error,
      review: () => startExplanation(), dismiss: explanation.dismissError },
  }
  const floatingStatuses = [...readerFloatingStatuses(floatingOptions), ...indexing.statuses]
  const activeModeStatus = readerModeStatus(floatingOptions)
  const overlays = readerOverlayModel({
    explanation, annotations, viewport: scrollRoot, documentPath: snapshot?.path, mode, regionPurpose: regionPurpose.current,
    editable, readOnly: !!snapshot?.document.readOnly,
    getExplanationAnchor: explanationEditorAnchor, onEditExplanationQuestion: id => { void editExplanationQuestion(id) },
    getCommentAnchor: commentAnchor, getCommentPosition: commentPosition,
    getNoteAnchor: noteAnchor, moveNote: moveNoteCard, moveCommentCard,
    applyComment: () => { void applyComment() }, closeComment: closeCommentEditor,
    applyNote: () => { void applyNote() }, t,
  })
  return <ReaderFormCommitProvider value={formCommits.owner}><ReaderView t={t} readerElement={readerElement} readerBody={readerBody} scrollRoot={scrollRoot}
    menuRef={toolsMenu} editable={editable} selected={selected} onDismissContext={dismissContext}
    onCloseTranslation={closeTranslation} onCancelScreenshot={cancelScreenshot}
    onSave={() => { void save() }}
    onUndoRedo={redo => { void actAfterFormFlush(current => redo
      ? api.redo(sessionId, current.id, current.revision, tab.signal)
      : api.undo(sessionId, current.id, current.revision, tab.signal)) }}
    onDeleteAnnotation={() => { void deleteAnnotation() }}
    toolbar={toolbar}
    selectionBar={{
      viewport: scrollRoot, getAnchor: contextualAnchor,
      active: !activeExplanation && hasTextSelection && mode === 'text', selection,
      textCopied, canExplain: !!props.promptExplanation && props.allowReadingContext !== false,
      explanationSending, editable, color, setColor,
      copyText: () => { void copyText() }, explain: startExplanation, translate: beginTranslation,
      mark: (subtype, hex) => { void mark(subtype, hex) }, beginNote, clearSelection, t,
    }}
    annotationBar={{
      viewport: scrollRoot, getAnchor: contextualAnchor, selected,
      commentActionAvailable: (!!selected?.editable && editable) || !!thread?.comments.length, annotationColor,
      readOnly: !!snapshot?.document.readOnly, editable, updateColor: updateAnnotationColor,
      openCommentEditor, deleteAnnotation: () => { void deleteAnnotation() }, clearAnnotation, t,
    }}
    alerts={{
      snapshot, error, positionNotice, editable, saveAsOpen, savePath, target, targetChecking,
      overwrite, busy, reloadConfirm, setError, setPositionNotice, setSavePath, setOverwrite,
      setSaveAsOpen, setReloadConfirm, save: path => { void save(path) },
      beginSaveAs: beginSaveAsAfterFormFlush,
      reload: () => { void actAfterFormFlush(current => api.reload(sessionId, current.id, current.revision, tab.signal)) }, t,
    }}
    floating={{ statuses: floatingStatuses, mode: activeModeStatus, explanation: overlays.explanationStatus }}
    question={overlays.question} comment={overlays.comment} note={overlays.note}
    pages={{
      scrollRef, onScroll: updateScrolledPage, mode, setDraggingPage,
      setSelection, clearSelection, clearAnnotation, scheduleCaptureSelection,
      captureSelection, hasDocument: !!pdf, error, elements: pageElements,
    }}
    sidebar={{
      activeSection: sidebarSection, onSectionChange: showSidebar, expanded: sidebarExpanded,
      pdf, currentPage, pageInput, navigating, onPageInputChange: editPageInput,
      onPageInputSubmit: value => {
        const page = Number(value)
        void runAfterFormFlush(() => {
          setPageInput(String(page))
          if (page !== state.current.currentPage) void jumpWithoutFormFlush(page)
        })
      },
      onPageInputReset: () => setPageInput(String(currentPage)),
      onNavigatePage: page => { void jump(page) },
      onStepPage: page => { void jump(page, {}, false) },
      onNavigateDestination: value => { void destination(value) },
      outlineAccess: snapshot ? { documentId: snapshot.id, revision: snapshot.revision, items: snapshot.document.outline,
        readOnlyReason: snapshot.document.outlineReadOnlyReason, editable, busy,
        change: async (operations, expectedRevision) => !!await act(current => {
          if (current.id !== snapshot.id || current.revision !== expectedRevision) throw new Error(t('reader.sidebar.outlineChanged'))
          return api.change(sessionId, current.id, expectedRevision, operations, tab.signal)
        }) } : undefined,
      onExpandedChange: changeSidebarExpanded, t, panels: sidebarPanels,
    }}
    screenshot={screenshot ? {
      image: screenshot, t, onError: notifyError, onClose: screenshotCtl.close,
      onOcr: ocrAvailability?.status === 'available' && !ocrProgress
        ? () => { void recognize({ page: screenshot.page, rect: screenshot.region }) } : undefined,
    } : undefined}
  /></ReaderFormCommitProvider>
}

export default Reader
