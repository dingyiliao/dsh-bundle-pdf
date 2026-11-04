import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { PdfRect } from '../../../src/core/pdf-types.js'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.js'
import { NativeViewport } from '../../../src/shared/geometry/native-viewport.js'
import { NavigationHistory } from '../../../src/shared/navigation-history.js'
import { TranslationError, TranslationRegistry, type TranslationRequest } from '../../../src/translation/index.js'
import { useReaderOcr } from '../../../src/modules/viewer/controllers/use-reader-ocr.js'
import { useReaderScreenshot } from '../../../src/modules/viewer/controllers/use-reader-screenshot.js'
import { useReaderTranslation } from '../../../src/modules/viewer/controllers/use-reader-translation.js'
import type { ReaderLifetime } from '../../../src/modules/viewer/controllers/reader-lifetime.js'
import type { ReaderSelection } from '../../../src/modules/viewer/model/reader-selection.js'
import type { ReaderDocument } from '../../../src/modules/viewer/ports/reader-document.js'
import type { HostOcrApi } from '../../../src/modules/viewer/ports/ocr.js'
import type { NativeDocument } from '../../../src/modules/viewer/rendering/document.js'
import { readerSidebarPanels } from '../../../src/modules/viewer/components/ReaderSidebarPanels.js'
import { ScreenshotPreview } from '../../../src/modules/viewer/components/ScreenshotPreview.js'
import { readerLocales } from '../../../src/modules/viewer/locales.js'

// This fixture exercises browser boundaries with controlled engines. It does
// not assert OCR accuracy or a remote model's translation quality.
const text = 'First OCR sentence.\nSecond OCR sentence with selected words.\n'
  + 'A long recognized paragraph supplies context around a short selected fragment. '.repeat(8)
  + '\nLast OCR sentence.'
const t = (key: string) => readerLocales.en[key] ?? key
const ocrRequests: Array<{ sessionId: string; documentId: string; page: number; region?: PdfRect }> = []
const translations: Array<Pick<TranslationRequest, 'text' | 'targetLanguage' | 'context'>> = []
const renders: Array<{ annotations?: boolean; width: number; height: number }> = []
let next: 'normal' | 'fail' | 'defer' = 'normal', aborted = 0
let release: (() => void) | undefined
const registry = new TranslationRegistry({ timeoutMs: 5000, maxInputCharacters: 10000, maxOutputCharacters: 10000 })
registry.register({ descriptor: { id: 'controlled', name: 'Controlled translation', version: '1', execution: 'local' },
  async translate(request) {
    translations.push({ text: request.text, targetLanguage: request.targetLanguage, context: request.context })
    request.signal.addEventListener('abort', () => { aborted++ }, { once: true })
    const response = next
    next = 'normal'
    if (response === 'fail') throw new TranslationError('invalid-model-output', 'Controlled response failure')
    if (response === 'defer') await new Promise<void>(resolve => { release = resolve })
    return { text: `Translated (${request.targetLanguage}): ${request.text}`, status: 'complete', warnings: [] }
  } })
registry.select({ engineId: 'controlled', id: 'fixture', configurationRevision: '1', config: {} })

const pdf: ReaderDocument = {
  numPages: 3, async getOutline() { return [] }, async getDestination(name) { return name }, async getPageIndex(ref) { return Number(ref) },
  async getPage(number) {
    return { pageNumber: number, rotate: 0, userUnit: 1, view: [0, 0, 400, 600],
      getViewport({ scale, rotation }) { return new NativeViewport({ page: number, mediaBox: [0, 0, 400, 600],
        cropBox: [0, 0, 400, 600], rotation: 0, userUnit: 1 }, scale, rotation) },
      async getTextContent() { return { lang: null, styles: {}, items: [] } }, async getAnnotations() { return [] },
      async tile() { throw new Error('Controlled scan fixture does not request tiles') },
      render({ canvas, viewport, transform, annotations }) {
        renders.push({ annotations, width: canvas.width, height: canvas.height })
        const context = canvas.getContext('2d')!
        if (transform) context.setTransform(transform[0]!, transform[1]!, transform[2]!, transform[3]!, transform[4]!, transform[5]!)
        context.fillStyle = '#fff'; context.fillRect(0, 0, viewport.width, viewport.height)
        context.fillStyle = '#222'; context.font = `${16 * viewport.scale}px sans-serif`
        text.split('\n').forEach((line, index) => context.fillText(line, 20 * viewport.scale, (90 + index * 28) * viewport.scale))
        return { promise: Promise.resolve(), cancel() {} }
      } }
  },
}
const initial = { id: 'scanned-document', contentVersion: 'scan-v1', revision: 7,
  reader: { bytesHash: 'fixture' }, document: { pages: [1, 2, 3].map(number => ({ number })) } } as WorkspaceSnapshot

function Fixture() {
  const [snapshot, setSnapshot] = useState(initial)
  const current = useRef(snapshot); current.current = snapshot
  const owner = useRef(1), tab = useRef(new AbortController()), regionPurpose = useRef<'explanation' | 'screenshot' | null>(null)
  const lifetime = useRef<ReaderLifetime>({ history: new NavigationHistory({ capacity: 5 }), ocrPages: new Map() })
  const [selection, setSelection] = useState<ReaderSelection | null>(null)
  const [mode, setMode] = useState<'text' | 'region' | 'note'>('text')
  const [panel, setPanel] = useState<'ocr' | 'translation'>('ocr')
  const [language, setLanguage] = useState('zh'), [error, setError] = useState('')
  const pointer = useRef<{ x: number; y: number }>()
  const screenshot = useReaderScreenshot({ pdf: pdf as NativeDocument, snapshot, tabSignal: tab.current.signal,
    displayOwnerToken: owner.current, ownerSequence: owner, regionPurpose, currentSnapshot: () => current.current,
    documentReady: () => true, setMode, setSelection, clearSelection: () => setSelection(null), clearAnnotation() {},
    closeToolsMenu() {}, clearError: () => setError(''), onError: cause => setError(String(cause)), t })
  const ocrApi = useRef<HostOcrApi>({ async availability() { return { status: 'available' } }, async recognize(request) {
    ocrRequests.push(request)
    const captured = current.current
    return { documentId: captured.id, contentVersion: captured.contentVersion, revision: captured.revision,
      page: request.page, text, status: 'complete', source: { backendId: 'controlled-ocr', backendVersion: '1' },
      geometry: { status: 'none' }, warnings: [] }
  } })
  const ocr = useReaderOcr({ api: ocrApi.current, sessionId: 'scan-session', visible: true, tabSignal: tab.current.signal, snapshot, currentPage: 2,
  lifetime: lifetime.current, screenshot: screenshot.screenshot, t, currentSnapshot: () => current.current,
  onError: cause => setError(String(cause)), onRecognized: () => { setPanel('ocr'); setSelection(null) } })
  const translation = useReaderTranslation({ translation: registry, sessionId: 'scan-session', tabSignal: tab.current.signal,
    snapshot, displayOwnerToken: owner.current, ownerSequence: owner, currentSnapshot: () => current.current,
    selection, targetLanguage: language, engine: 'controlled', timeoutMs: 4000, showSidebar: () => setPanel('translation') })
  const panels = readerSidebarPanels({ snapshot, pdf: pdf as NativeDocument, annotations: [], clearAnnotation() {},
    selectAnnotation() {}, jump() {}, ocrTranscript: ocr.ocrTranscript, translation, translationEngine: 'controlled',
    translationRegistry: registry, async rememberTargetLanguage(value) { setLanguage(value); return true },
    onReturnToOcr: () => setPanel('ocr'),
    search: { query: '', setQuery() {}, hits: [], searched: false, searching: false, async run() {}, cancel() {},
      invalidateDocument() {} }, t })
  Object.assign(window, { __pdfOcrTranslationFixture: {
    state: () => ({ text, revision: current.current.revision, ocr: structuredClone(ocrRequests), translations: structuredClone(translations), renders: structuredClone(renders), aborted }),
    next(value: typeof next) { next = value }, release() { release?.(); release = undefined },
    changeRevision() { setSnapshot(value => ({ ...value, revision: value.revision + 1 })) },
  } })
  return <div className="dsh-pdf-reader">
    <nav className="ocr-fixture-actions"><button type="button" onClick={() => screenshot.begin(false)}>Capture region</button>
      <button type="button" onClick={() => setPanel('ocr')}>Show OCR</button></nav>
    <div className="ocr-fixture-body">
      <div data-testid="scanned-page" className="ocr-fixture-page" data-mode={mode}
        onPointerDown={event => {
          if (mode !== 'region') return
          event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
          const bounds = event.currentTarget.getBoundingClientRect()
          pointer.current = { x: (event.clientX - bounds.left) / bounds.width * 400, y: 600 - (event.clientY - bounds.top) / bounds.height * 600 }
        }} onPointerUp={event => {
          if (!pointer.current) return
          const start = pointer.current; pointer.current = undefined
          const bounds = event.currentTarget.getBoundingClientRect()
          const x = (event.clientX - bounds.left) / bounds.width * 400, y = 600 - (event.clientY - bounds.top) / bounds.height * 600
          const rect: PdfRect = [Math.min(start.x, x), Math.min(start.y, y), Math.max(start.x, x), Math.max(start.y, y)]
          void screenshot.takeRegion(2, { rect, quadPoints: [] })
        }}><p>Controlled scanned page</p><p>{text}</p></div>
      <div className="ocr-fixture-sidebar">{panels[panel]}</div>
    </div>
    {error && <p role="alert">{error}</p>}
    {screenshot.screenshot && <ScreenshotPreview image={screenshot.screenshot} t={t} onClose={screenshot.close}
      onError={cause => setError(String(cause))} onOcr={() => {
        const image = screenshot.screenshot!
        void ocr.recognize({ page: image.page, rect: image.region })
      }} />}
  </div>
}

createRoot(document.getElementById('ocr-translation-root')!).render(<Fixture />)
