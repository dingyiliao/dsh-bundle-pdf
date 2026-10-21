import React, { type ReactNode, type RefObject } from 'react'
import type { PdfAnnotation } from '../../../core/pdf-types.js'
import { AnnotationCommentCard } from './AnnotationCommentCard.js'
import { ExplanationQuestionEditor, type ExplanationQuestionEditorProps } from './ExplanationQuestionEditor.js'
import type { ExplanationStatusBarProps } from './ExplanationStatusBar.js'
import type { FloatingStatus } from './FloatingStatusRail.js'
import type { ReaderModeStatus } from './ReaderModeControl.js'
import { OverlayScrollbars } from './OverlayScrollbar.js'
import { ReadingSidebar, type ReadingSidebarProps } from './ReadingSidebar.js'
import { ScreenshotPreview, type ScreenshotPreviewProps } from './ScreenshotPreview.js'
import { ReaderAlerts, type ReaderAlertsProps } from './ReaderAlerts.js'
import { ReaderAnnotationBar, ReaderSelectionBar,
  type ReaderAnnotationBarProps, type ReaderSelectionBarProps } from './ReaderContextBars.js'
import { ReaderCommentEditor, type ReaderCommentEditorProps } from './ReaderCommentEditor.js'
import { ReaderNoteEditor, type ReaderNoteEditorProps } from './ReaderNoteEditor.js'
import { ReaderToolbar, type ReaderToolbarActions, type ReaderToolbarState } from './ReaderToolbar.js'

export interface ReaderViewProps {
  t(key: string): string
  readerElement: RefObject<HTMLDivElement>
  readerBody: RefObject<HTMLDivElement>
  scrollRoot: HTMLDivElement | null
  menuRef: RefObject<HTMLDetailsElement>
  editable: boolean
  selected?: PdfAnnotation
  onDismissContext(): void
  onCloseTranslation(): void
  onCancelScreenshot(): void
  onSave(): void
  onUndoRedo(redo: boolean): void
  onDeleteAnnotation(): void
  toolbar: { state: ReaderToolbarState; actions: ReaderToolbarActions }
  selectionBar: ReaderSelectionBarProps
  annotationBar: ReaderAnnotationBarProps
  alerts: ReaderAlertsProps
  floating: { statuses: readonly FloatingStatus[]; mode?: ReaderModeStatus | null; explanation?: ExplanationStatusBarProps }
  question?: { key: string; props: ExplanationQuestionEditorProps }
  comment?: {
    key: string
    viewport: HTMLElement | null
    getAnchor(): DOMRect | null
    getPosition?(): DOMRect | null
    onMove?(delta: { x: number; y: number }, position: { left: number; top: number }): boolean | Promise<boolean>
    onVisible(): void
    editor: ReaderCommentEditorProps
  }
  note?: {
    key: string
    sizeKey: string
    viewport: HTMLElement | null
    getAnchor(): DOMRect | null
    onVisible(): void
    onMove(delta: { x: number; y: number }): boolean | Promise<boolean>
    noteColor: string
    editor: ReaderNoteEditorProps
  }
  pages: {
    scrollRef(node: HTMLDivElement | null): void
    onScroll(): void
    mode: 'text' | 'region' | 'note'
    setDraggingPage(page: number | null): void
    setSelection(value: null): void
    clearSelection(): void
    clearAnnotation(): void
    scheduleCaptureSelection(): void
    captureSelection(): void
    hasDocument: boolean
    error: string
    elements: ReactNode
  }
  sidebar: ReadingSidebarProps
  screenshot?: ScreenshotPreviewProps
}

/** The reader shell owns placement and input routing; feature controls own their own behavior. */
export function ReaderView(props: ReaderViewProps) {
  const { t, readerElement, readerBody, scrollRoot, menuRef, editable, selected,
    onDismissContext, onCloseTranslation, onCancelScreenshot, onSave, onUndoRedo,
    onDeleteAnnotation, toolbar, selectionBar, annotationBar, alerts, floating,
    question, comment, note, pages, sidebar, screenshot } = props
  return <div className="dsh-pdf-reader" ref={readerElement} aria-label={t('reader.title')} onPointerDown={event => {
    if (event.button !== 0 || !(event.target instanceof Element) || scrollRoot?.contains(event.target)) return
    if (!event.target.closest('button,a,input,textarea,select,summary,.dsh-pdf-context-toolbar,.dsh-pdf-sidebar-divider,.dsh-pdf-translation-text,.dsh-pdf-translation-original')) onDismissContext()
  }} onKeyDown={event => {
    if (event.target instanceof Element && event.target.closest('.dsh-pdf-translation-panel')) {
      if (event.key === 'Escape') { event.preventDefault(); onCloseTranslation() }
      return
    }
    const input = event.target instanceof HTMLElement && event.target.closest('input,textarea,[contenteditable="true"]')
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (editable) onSave() }
    if (!input && editable && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault(); onUndoRedo(event.shiftKey)
    }
    if (!input && selected && event.key === 'Delete' && editable && selected.editable) {
      event.preventDefault(); onDeleteAnnotation()
    }
    if (!input && event.key === 'Escape') {
      onDismissContext(); onCancelScreenshot(); onCloseTranslation()
      if (menuRef.current) menuRef.current.open = false
    }
  }}>
    <ReaderSelectionBar {...selectionBar} />
    <ReaderAnnotationBar {...annotationBar} />
    <ReaderAlerts {...alerts} />
    <div className="dsh-pdf-body" ref={readerBody}>
      <div className="dsh-pdf-content" aria-label={t('reader.sidebar.pdfContent')}>
        <div className="dsh-pdf-floating-controls">
          <div className="dsh-pdf-floating-controls-layout">
            <ReaderToolbar t={t} menuRef={menuRef} state={toolbar.state} actions={toolbar.actions}
              mode={floating.mode} explanation={floating.explanation} statuses={floating.statuses} />
          </div>
        </div>
        {question && <ExplanationQuestionEditor key={question.key} {...question.props} />}
        {comment && <AnnotationCommentCard key={comment.key} viewport={comment.viewport} getAnchor={comment.getAnchor}
          getPosition={comment.getPosition} onMove={comment.onMove} label={t('reader.commentText')} onVisible={comment.onVisible}>
          <ReaderCommentEditor {...comment.editor} />
        </AnnotationCommentCard>}
        {note && <AnnotationCommentCard key={note.key} viewport={note.viewport} getAnchor={note.getAnchor}
          label={t('reader.note')} onVisible={note.onVisible} onMove={note.onMove} connector={false}
          cardKind="note" noteColor={note.noteColor} sizeKey={note.sizeKey} resizeLabel={t('reader.resizeNote')}>
          <ReaderNoteEditor {...note.editor} />
        </AnnotationCommentCard>}
        <div className="dsh-pdf-scroll" ref={pages.scrollRef} tabIndex={0} onScroll={pages.onScroll}
          onPointerDown={event => {
            if (event.button !== 0 || pages.mode !== 'text' || (event.target instanceof Element && event.target.closest('button,a,input,textarea'))) return
            const wrapper = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-page-number]') : null
            pages.setDraggingPage(wrapper ? Number(wrapper.dataset.pageNumber) : null)
            // Remove the old native Range before browser default selection starts.
            if (event.shiftKey) pages.setSelection(null)
            else pages.clearSelection()
            pages.clearAnnotation()
          }}
          onPointerUp={pages.scheduleCaptureSelection} onPointerCancel={() => pages.setDraggingPage(null)}
          onKeyUp={pages.captureSelection}>
          {!pages.hasDocument && <div className="dsh-pdf-empty" role="status">{pages.error ? t('reader.cannotOpen') : t('reader.loading')}</div>}
          {pages.elements}
        </div>
        <OverlayScrollbars target={scrollRoot} verticalLabel={t('reader.verticalScroll')} horizontalLabel={t('reader.horizontalScroll')} />
      </div>
      <ReadingSidebar {...sidebar} />
    </div>
    {screenshot && <ScreenshotPreview {...screenshot} />}
  </div>
}
