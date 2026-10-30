import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AnnotationCommentCard } from '../../../src/modules/viewer/components/AnnotationCommentCard.js'
import { FloatingToolbar } from '../../../src/modules/viewer/components/FloatingToolbar.js'
import { ReaderToolbar, type ReaderToolbarActions, type ReaderToolbarState } from '../../../src/modules/viewer/components/ReaderToolbar.js'
import { ReaderCommentEditor } from '../../../src/modules/viewer/components/ReaderCommentEditor.js'
import { ReaderAnnotationBar } from '../../../src/modules/viewer/components/ReaderContextBars.js'
import { ReadingSidebar, type ReadingSidebarSection } from '../../../src/modules/viewer/components/ReadingSidebar.js'
import { ScrollablePanel } from '../../../src/modules/viewer/components/ScrollablePanel.js'
import type { ReaderDocument } from '../../../src/modules/viewer/ports/reader-document.js'
import { NativeViewport } from '../../../src/shared/geometry/native-viewport.js'
import { readerFloatingStatuses } from '../../../src/modules/viewer/controllers/reader-floating-statuses.js'
import { readerLocales } from '../../../src/modules/viewer/locales.js'

export interface ReaderToolbarLayoutInput {
  mode: 'text' | 'explanation' | 'note' | 'region'
  language: 'en' | 'zh'
  tasks: 'none' | 'concurrent' | 'cancelling'
  count: number
  sending: boolean
  selectingArea: boolean
  imageAvailable: boolean
  error: string
  context: boolean
  actualAnnotation: boolean
  sidebarExpanded: boolean
  sidebarSection: ReadingSidebarSection
  state?: Partial<ReaderToolbarState>
}

const defaults: ReaderToolbarLayoutInput = { mode: 'text', language: 'en', tasks: 'none', count: 2,
  sending: false, selectingArea: false, imageAvailable: true, error: '', context: false, actualAnnotation: false,
  sidebarExpanded: false, sidebarSection: 'bookmarks' }
let update: (input: Partial<ReaderToolbarLayoutInput>) => void = () => {}
const calls: string[] = []
const pdf: ReaderDocument = {
  numPages: 1151,
  async getOutline() { return Array.from({ length: 20 }, (_, index) => ({
    id: `chapter-${index}`, title: `Chapter ${index + 1}: Reading with context`, dest: [index, { name: 'Fit' }], items: [],
  })) },
  async getDestination(name) { return name },
  async getPageIndex(ref) { return Number(ref) },
  async getPage(number) {
    return { pageNumber: number, rotate: 0, userUnit: 1, view: [0, 0, 400, 600],
      getViewport({ scale, rotation }) { return new NativeViewport({ page: number, mediaBox: [0, 0, 400, 600],
        cropBox: [0, 0, 400, 600], rotation: 0, userUnit: 1 }, scale, rotation) },
      async getTextContent() { return { lang: null, styles: {}, items: [] } }, async getAnnotations() { return [] },
      async tile() { throw new Error('Tool rail fixture has no native tiles') },
      render({ canvas }) {
        const context = canvas.getContext('2d')!
        context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height)
        context.fillStyle = '#333'; context.font = '12px sans-serif'; context.fillText(`Page ${number}`, 8, 24)
        return { promise: Promise.resolve(), cancel() {} }
      },
    }
  },
}

function Fixture() {
  const [input, setInput] = useState<ReaderToolbarLayoutInput>(defaults)
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
  const [comment, setComment] = useState('A comment on the selected passage')
  const [annotationColor, setAnnotationColor] = useState('#ffff00')
  const [currentPage, setCurrentPage] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  update = value => setInput({ ...defaults, ...value })
  const menu = useRef<HTMLDetailsElement>(null)
  const selection = useRef<HTMLSpanElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const t = (key: string) => readerLocales[input.language][key] ?? key
  const record = (name: string) => () => { calls.push(name) }
  const state: ReaderToolbarState = {
    hasDocument: true, canPromptExplanation: true, explanationActive: input.mode === 'explanation', explanationSending: input.sending,
    screenshotActive: input.mode === 'region', screenshotPreparing: false, busy: false, editable: true, ocrBusy: false,
    ocrAvailability: { status: 'available' }, dirty: true, canUndo: true, canRedo: true, conflict: false, colorPending: false,
    saveAsPicking: false, hasUnappliedAnnotation: false, canGoBack: true, navigating: false,
    history: { revision: 7, positions: [3, 8].map(page => ({ documentVersion: 'fixture', page, x: 0, y: 0, scale: 1, fit: 'width' })) },
    fit: 'width', zoom: 1, ...input.state,
  }
  const actions: ReaderToolbarActions = { onOpenMenu: record('file-menu'), onToggleExplanation: record('explanation'),
    onScreenshot: record('screenshot'), onNote: record('note'), onOcr: record('ocr'),
    onReload: record('reload'), onSaveAs: record('save-as'), onDiscard: record('discard'), onUndo: record('undo'),
    onRedo: record('redo'), onSave: record('save'), onBack: record('back'),
    onBackTo: (depth, revision) => { calls.push(`back-to:${depth}:${revision}`) },
    onZoom: value => { calls.push(`zoom:${value}`) } }
  const explanation = input.mode === 'explanation' ? { count: input.count, max: 20, sending: input.sending, error: input.error,
    imageAvailable: input.imageAvailable, imageReason: input.imageAvailable ? undefined : 'Image engine unavailable',
    selectingArea: input.selectingArea, t, onSend: record('send'), onExit: record('exit-explanation'),
    onSelectArea: record('select-area') } : undefined
  const mode = input.mode === 'note' || input.mode === 'region' ? { kind: input.mode,
    label: t(input.mode === 'note' ? 'reader.placeNote' : 'reader.screenshotHint'), onCancel: record('cancel-mode') } : undefined
  const statuses = readerFloatingStatuses({ saveFeedback: input.tasks === 'none' ? null : { kind: 'saved', durationMs: 0, occurrence: 1 },
    documentPath: '/fixture.pdf', mode: 'text', explanationActive: input.mode === 'explanation', regionPurpose: null,
    screenshotPhase: input.tasks === 'none' ? null : input.tasks === 'cancelling' ? 'cancelling' : 'preparing',
    ocrProgress: input.tasks === 'none' ? null : input.tasks === 'cancelling' ? 'cancelling' : 'recognizing',
    onSaveExpired: record('expire-save'), onExitNote: record('cancel-note'),
    onCancelScreenshot: record('cancel-screenshot'), onCancelOcr: record('cancel-ocr'), t })
  const getAnchor = () => selection.current?.getBoundingClientRect() ?? null
  return <div className="dsh-pdf-reader">
    <div className="dsh-pdf-body">
      <ReaderToolbar t={t} menuRef={menu} state={state} actions={actions} mode={mode} explanation={explanation} statuses={statuses} />
      <div className="dsh-pdf-content" aria-label="PDF content">
        <div className="dsh-pdf-scroll" ref={setViewport} tabIndex={0}>
          <article aria-label="Fixture PDF page" style={{ position: 'relative', minHeight: 740, maxWidth: 680, margin: '16px auto',
            width: 'calc(100% - 32px)', padding: '88px 12px 32px', background: '#fff', color: '#222',
            boxShadow: '0 1px 8px #00000014', overflowWrap: 'anywhere' }}>
            <span ref={selection} data-fixture-selection style={{ position: 'absolute', top: 24, left: 12,
              maxWidth: 'calc(100% - 24px)', background: '#fff0a0' }}>
              Selected PDF text
            </span>
            <p style={{ fontSize: 10, letterSpacing: 1.5, color: '#666', margin: '0 0 12px' }}>PDF READING FIXTURE · PAGE 1</p>
            <h1 style={{ fontFamily: 'Georgia, serif', fontSize: 24, lineHeight: 1.2, margin: '0 0 16px' }}>Reading with room to think</h1>
            <p style={{ fontFamily: 'Georgia, serif', lineHeight: 1.7 }}>Tools stay beside the document, leaving its first lines visible.
              A reader can select a passage, add a comment, or collect evidence for an explanation.</p>
            <div style={{ marginTop: 28, padding: '16px 10px', borderLeft: '3px solid #4278ed', background: '#f1f5fc' }}>
              One reading surface. Independent tools, anchored comments, and background tasks.
            </div>
            <p style={{ fontFamily: 'Georgia, serif', lineHeight: 1.7 }}>This synthetic page makes the PDF column and its top edge
              visible in layout screenshots. It does not load a session, engine, or document from the host.</p>
          </article>
        </div>
      </div>
      <ReadingSidebar activeSection={input.sidebarSection} expanded={input.sidebarExpanded}
        onSectionChange={sidebarSection => setInput(previous => ({ ...previous, sidebarSection }))}
        onExpandedChange={sidebarExpanded => setInput(previous => ({ ...previous, sidebarExpanded }))}
        pdf={pdf} currentPage={currentPage} pageInput={pageInput} navigating={false}
        onPageInputChange={setPageInput} onPageInputReset={() => setPageInput(String(currentPage))}
        onPageInputSubmit={value => { setCurrentPage(Number(value)); setPageInput(value); calls.push(`page:${value}`) }}
        onNavigatePage={page => { setCurrentPage(page); setPageInput(String(page)); calls.push(`page:${page}`) }}
        onStepPage={page => { setCurrentPage(page); setPageInput(String(page)); calls.push(`page:${page}`) }}
        onNavigateDestination={record('bookmark-jump')} t={t}
        panels={Object.fromEntries((['annotations', 'search', 'translation', 'ocr'] as const).map(section => [section,
          <ScrollablePanel key={section} title={t(`reader.sidebar.${section}`)} verticalLabel="Scroll panel" horizontalLabel="Scroll panel horizontally">
            {section === 'search' && <form><input aria-label="Search PDF" defaultValue="context" /><button type="button">Search</button></form>}
            {Array.from({ length: 20 }, (_, index) => <p key={index} style={{ padding: '0 12px' }}>
              {t(`reader.sidebar.${section}`)} {index + 1}: Evidence stays beside the document.
            </p>)}
          </ScrollablePanel>,
        ]))} />
    </div>
    {input.context && !input.actualAnnotation && <FloatingToolbar viewport={viewport} getAnchor={getAnchor} label="Selection actions"
      className="dsh-pdf-annotation-toolbar">
      <button type="button" onClick={record('copy')}>Copy</button>
      <button type="button" onClick={record('highlight')}>Highlight</button>
    </FloatingToolbar>}
    {input.context && input.actualAnnotation && <ReaderAnnotationBar viewport={viewport} getAnchor={getAnchor}
      selected={{ id: 'fixture-highlight', page: 1, subtype: 'Highlight', flags: 0, supported: true, editable: true,
        rect: [12, 24, 128, 45], color: [1, 1, 0] }}
      commentActionAvailable annotationColor={annotationColor} readOnly={false} editable
      updateColor={value => { setAnnotationColor(value); calls.push(`annotation-color:${value}`) }}
      openCommentEditor={record('open-comment')} deleteAnnotation={record('delete-annotation')}
      clearAnnotation={record('clear-annotation')} t={t} />}
    {input.context && <AnnotationCommentCard viewport={viewport} getAnchor={getAnchor} label="Annotation comment">
      <ReaderCommentEditor comments={[]} mode="new" readOnly={false} editable comment={comment} textarea={textarea}
        onComment={setComment} onAdd={record('add-comment')} onEdit={record('edit-comment')} onDeleteComment={record('delete-comment')}
        onApply={record('apply-comment')} onDismiss={record('dismiss-comment')} onClose={record('close-comment')} t={t} />
    </AnnotationCommentCard>}
  </div>
}

createRoot(document.getElementById('toolbar-root')!).render(<Fixture />)
Object.assign(window, { __pdfToolbarLayoutFixture: { set: (input: Partial<ReaderToolbarLayoutInput>) => update(input),
  calls: () => [...calls], resetCalls: () => { calls.length = 0 } } })
