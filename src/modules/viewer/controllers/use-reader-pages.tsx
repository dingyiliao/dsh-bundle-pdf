import React, { useCallback, useMemo, useRef } from 'react'
import type { PdfAnnotation, PdfPageInfo, PdfRect } from '../../../core/pdf-types.js'
import type { WorkspaceSnapshot } from '../../../shared/contracts.js'
import type { NativeDocument } from '../rendering/document.js'
import { WindowedPages } from '../rendering/WindowedPages.js'
import type { ReaderPage } from '../rendering/ReaderPage.js'
import type { ReaderSelection, PageView } from '../model/reader-selection.js'
import type { OcrPage } from './reader-lifetime.js'
import type { ExplanationExcerpt } from '../../explanation/index.js'

type Region = { rect: PdfRect; quadPoints: number[] }
type PageComponent = typeof ReaderPage

export interface ReaderPagesOptions {
  PageComponent: PageComponent
  pdf: NativeDocument | null
  snapshot: WorkspaceSnapshot | null
  selection: ReaderSelection | null
  selectedAnnotation: PdfAnnotation | undefined
  annotationsByPage: ReadonlyMap<number, PdfAnnotation[]>
  renderedAnnotationsByPage: ReadonlyMap<number, PdfAnnotation[]>
  activeExplanation: { excerpts: ExplanationExcerpt[] } | null
  draftExplanationSelection: ReaderSelection | null
  draggingPage: number | null
  navigationTarget: { page: number } | null
  ocrPages: ReadonlyMap<number, OcrPage>
  zoom: number
  fit: 'custom' | 'width' | 'page'
  size: { width: number; height: number }
  scrollRoot: HTMLDivElement | null
  mode: 'text' | 'region' | 'note'
  t(key: string): string
  pageScale(page: PdfPageInfo): number
  registerView(page: number, view: PageView | null): void
  destination(value: unknown): unknown
  jump(page: number): unknown
  currentPageCount(): number | undefined
  beginNote(page: number, point: number[]): void
  takeScreenshot(page: number, region: Region): unknown
  selectExplanationRegion(page: number, region: Region): boolean
  editExplanationQuestion(id: string, marker: HTMLElement): void
  selectAnnotation(id: string, intent?: 'select' | 'comment'): void
  dismissContext(): void
  notifyError(error: unknown): void
}

/** Pin pages that contain an active selection or an unresolved navigation target. */
export function readerPagePins(selection: ReaderSelection | null, selectedAnnotation: PdfAnnotation | undefined,
  navigationTarget: { page: number } | null) {
  const selectedPages = new Set(selection?.fragments.map(fragment => fragment.page))
  const pinnedPages = new Set(selectedPages)
  const selectedTextPages = new Set(selection?.kind === 'text' ? selectedPages : [])
  if (selectedAnnotation) pinnedPages.add(selectedAnnotation.page)
  // Navigation must register a PageView before its intersection observer runs.
  if (navigationTarget) {
    pinnedPages.add(navigationTarget.page)
    selectedTextPages.add(navigationTarget.page)
  }
  return { selectedPages, pinnedPages, selectedTextPages }
}

export function namedPageActionTarget(page: number, action: string, last: number): number {
  return action === 'FirstPage' ? 1 : action === 'LastPage' ? last
    : action === 'NextPage' ? page + 1 : page - 1
}

const noAnnotations: PdfAnnotation[] = []

/** Keeps per-page handlers stable while the visible page window follows Reader state. */
export function useReaderPages(options: ReaderPagesOptions): React.ReactNode {
  const { PageComponent, pdf, snapshot, selection, selectedAnnotation, annotationsByPage,
    renderedAnnotationsByPage, activeExplanation, draftExplanationSelection, draggingPage,
    navigationTarget, ocrPages, zoom, fit, size, scrollRoot, mode, t, pageScale,
    registerView, editExplanationQuestion, selectAnnotation, dismissContext, notifyError } = options
  const callbacks = useRef({ destination: options.destination, jump: options.jump,
    beginNote: options.beginNote, takeScreenshot: options.takeScreenshot,
    selectExplanationRegion: options.selectExplanationRegion, currentPageCount: options.currentPageCount })
  callbacks.current = { destination: options.destination, jump: options.jump,
    beginNote: options.beginNote, takeScreenshot: options.takeScreenshot,
    selectExplanationRegion: options.selectExplanationRegion, currentPageCount: options.currentPageCount }
  const pageDestination = useCallback((value: unknown) => { void callbacks.current.destination(value) }, [])
  const pageAction = useCallback((page: number, action: string) => {
    const last = callbacks.current.currentPageCount() ?? page
    void callbacks.current.jump(namedPageActionTarget(page, action, last))
  }, [])
  const pageNote = useCallback((page: number, point: number[]) => callbacks.current.beginNote(page, point), [])
  const pageRegion = useCallback((page: number, region: Region) => {
    if (!callbacks.current.selectExplanationRegion(page, region)) void callbacks.current.takeScreenshot(page, region)
  }, [])

  return useMemo(() => {
    if (!pdf || !snapshot) return null
    const { selectedPages, pinnedPages, selectedTextPages } = readerPagePins(selection, selectedAnnotation, navigationTarget)
    return <WindowedPages key={snapshot.id} pages={snapshot.document.pages}
      rotation={0} zoom={zoom} fit={fit} size={size} scrollRoot={scrollRoot}
      scaleForPage={pageScale}
      pinnedPages={pinnedPages} selectedTextPages={selectedTextPages} dragAnchorPage={draggingPage}
      preserveAnchor={!navigationTarget}
      renderPage={(geometry, retainTextLayer) => <PageComponent key={`${snapshot.id}:${geometry.page}`} pdf={pdf} geometry={geometry}
        scale={pageScale(geometry)} rotation={0} mode={mode} t={t} scrollRoot={scrollRoot}
        retainTextLayer={retainTextLayer}
        annotations={annotationsByPage.get(geometry.page) ?? noAnnotations}
        renderedAnnotations={renderedAnnotationsByPage.get(geometry.page) ?? noAnnotations}
        selectedAnnotation={selectedAnnotation?.page === geometry.page ? selectedAnnotation.id : undefined}
        selection={selectedPages.has(geometry.page) ? selection : null} ocrWords={ocrPages.get(geometry.page)?.words}
        explanationExcerpts={activeExplanation?.excerpts}
        explanationDraft={draftExplanationSelection?.fragments.at(-1)?.page === geometry.page
          ? { index: (activeExplanation?.excerpts.length ?? 0) + 1, fragment: draftExplanationSelection.fragments.at(-1)! }
          : undefined}
        onExplanationMark={editExplanationQuestion}
        onView={registerView} onDestination={pageDestination} onAction={pageAction}
        onAnnotation={selectAnnotation} onNote={pageNote} onRegion={pageRegion}
        onBackground={dismissContext} onError={notifyError} />} />
  }, [PageComponent, pdf, snapshot?.id, snapshot?.contentVersion, snapshot?.document.pages, mode, t, scrollRoot,
    annotationsByPage, renderedAnnotationsByPage, selectedAnnotation?.id, selectedAnnotation?.page,
    selection, activeExplanation, draftExplanationSelection, draggingPage, navigationTarget,
    ocrPages, zoom, fit, size, pageScale, registerView, pageDestination, pageAction,
    selectAnnotation, pageNote, pageRegion, editExplanationQuestion, dismissContext, notifyError])
}
