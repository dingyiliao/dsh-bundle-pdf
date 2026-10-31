import { useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { createPdfIndexingApi } from '../../../src/adapters/client/remote/indexing.js'
import type { PdfConnection } from '../../../src/adapters/client/remote/pdf-api.js'
import type { PdfDocumentIndexPolicy, PdfIndexingSnapshot, PdfIndexingTask } from '../../../src/contracts/indexing.js'
import { createTranslationRegistry } from '../../../src/translation/index.js'
import { readerSidebarPanels } from '../../../src/modules/viewer/components/ReaderSidebarPanels.js'
import { ReaderToolbar, type ReaderToolbarActions, type ReaderToolbarState } from '../../../src/modules/viewer/components/ReaderToolbar.js'
import { ReadingSidebar } from '../../../src/modules/viewer/components/ReadingSidebar.js'
import { useReaderIndexing } from '../../../src/modules/viewer/controllers/use-reader-indexing.js'
import { useReaderSearch } from '../../../src/modules/viewer/controllers/use-reader-search.js'
import { NativeDocument } from '../../../src/modules/viewer/rendering/document.js'
import { readerLocales } from '../../../src/modules/viewer/locales.js'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.js'

interface Waiter { sessionId: string; resolve(value: unknown): void; abort(): void }
const lifetime = new AbortController()
const hosts = new Map<string, PdfIndexingSnapshot>()
const waiters = new Set<Waiter>()
const calls: Array<{ action: string; sessionId: string; documentId: string }> = []
const errors: string[] = []
let revision = 0
const t = (key: string) => readerLocales.en[key] ?? key
const defaults: PdfDocumentIndexPolicy = { embeddingEngine: 'fixture-embedding', ocrEngine: 'fixture-ocr',
  imageEngine: 'fixture-image', indexScanPages: true, indexImageDescriptions: false }
const engineCatalog = { revision: 'fixture', engines: {
  embedding: [{ id: 'none', name: 'Disabled', version: '1', execution: 'disabled' as const },
    { id: 'fixture-embedding', name: 'Fixture embedding', version: '1', execution: 'service' as const }],
  ocr: [{ id: 'fixture-ocr', name: 'Fixture OCR', version: '1', execution: 'local' as const, capabilities: ['ocr-text' as const] }],
  image: [{ id: 'fixture-image', name: 'Fixture image understanding', version: '1', execution: 'remote' as const,
    capabilities: ['image-description' as const] }], translation: [],
} }

function host(sessionId: string): PdfIndexingSnapshot {
  let value = hosts.get(sessionId)
  if (!value) {
    value = { revision: String(++revision), enabled: true, tasks: [], documents: [{
      documentId: sessionId === 'session-a' ? 'alpha' : 'beta', revision: 0,
      policy: { ...defaults }, activePolicy: { ...defaults }, pending: false, impact: 'none',
    }] }
    hosts.set(sessionId, value)
  }
  return value
}
function respond(value: PdfIndexingSnapshot) { return { ok: true, value: structuredClone(value) } }
function changed(sessionId: string, value: Omit<PdfIndexingSnapshot, 'revision'>) {
  const snapshot = { ...host(sessionId), ...value, revision: String(++revision) }
  hosts.set(sessionId, snapshot)
  for (const waiter of [...waiters]) if (waiter.sessionId === sessionId) waiter.resolve(respond(snapshot))
}
const connection: PdfConnection = { rpc: { async call(_path, method, raw, signal) {
  if (method !== 'pdf.indexing') throw new Error(`Unexpected fixture RPC: ${method}`)
  const input = raw as { action: string; sessionId: string; documentId: string; revision?: string | number; policy?: PdfDocumentIndexPolicy }
  const current = host(input.sessionId)
  if (input.action === 'status') {
    if (input.revision !== current.revision) return respond(current)
    return new Promise((resolve, reject) => {
      const cleanup = () => { waiters.delete(waiter); signal?.removeEventListener('abort', waiter.abort) }
      const waiter: Waiter = { sessionId: input.sessionId,
        resolve(value) { cleanup(); resolve(value) },
        abort() { cleanup(); reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError')) } }
      waiters.add(waiter)
      signal?.addEventListener('abort', waiter.abort, { once: true })
      if (signal?.aborted) waiter.abort()
    })
  }
  calls.push({ action: input.action, sessionId: input.sessionId, documentId: input.documentId })
  if (input.action === 'configure' || input.action === 'defaults') {
    const settings = current.documents!.find(value => value.documentId === input.documentId)!
    if (input.revision !== settings.revision) return { ok: false, error: { code: 'pdf/index-settings-conflict', message: 'Index settings changed.' } }
    const policy = input.action === 'defaults' ? { ...defaults } : input.policy!
    const pending = policy.embeddingEngine !== 'none' && JSON.stringify(policy) !== JSON.stringify(settings.activePolicy)
    const next = { ...settings, revision: settings.revision + 1, policy, pending,
      activePolicy: policy.embeddingEngine === 'none' ? policy : settings.activePolicy,
      impact: pending ? policy.embeddingEngine === settings.activePolicy.embeddingEngine ? 'content' as const : 'embedding' as const : 'none' as const }
    changed(input.sessionId, { ...current, enabled: policy.embeddingEngine !== 'none', documents: [next] })
    return respond(host(input.sessionId))
  }
  const previous = current.tasks.find(task => task.documentId === input.documentId)
  const task: PdfIndexingTask = {
    documentId: input.documentId, title: `${input.documentId}.pdf`,
    occurrence: input.action === 'cancel' ? previous?.occurrence ?? 1 : (previous?.occurrence ?? 0) + 1,
    state: input.action === 'cancel' ? 'cancelled' : 'running',
    ...(input.action === 'cancel' ? {} : { progress: { indexedPages: 1, totalPages: 3, embeddedChunks: 0, totalChunks: 3, phase: 'extracting' as const } }),
  }
  changed(input.sessionId, { enabled: current.enabled, tasks: [task] })
  return respond(host(input.sessionId))
} } }
const api = createPdfIndexingApi(connection, lifetime.signal)
const translationRegistry = createTranslationRegistry({ timeoutMs: 1000, maxInputCharacters: 8192, maxOutputCharacters: 32768 })
const state: ReaderToolbarState = {
  hasDocument: true, canPromptExplanation: false, explanationActive: false, explanationSending: false,
  screenshotActive: false, screenshotPreparing: false, busy: false, editable: false, ocrBusy: false,
  ocrAvailability: null, dirty: false, canUndo: false, canRedo: false, conflict: false, colorPending: false,
  saveAsPicking: false, hasUnappliedAnnotation: false, canGoBack: false, navigating: false,
  history: { revision: 0, positions: [] }, fit: 'width', zoom: 1,
}
const actions: ReaderToolbarActions = {
  onOpenMenu() {}, onToggleExplanation() {}, onScreenshot() {}, onNote() {}, onOcr() {},
  onReload() {}, onSaveAs() {}, onDiscard() {}, onUndo() {}, onRedo() {}, onSave() {},
  onBack() {}, onBackTo() {}, onZoom() {},
}

function View({ name, sessionId, documentId }: { name: string; sessionId: string; documentId: string }) {
  const menu = useRef<HTMLDetailsElement>(null)
  const indexing = useReaderIndexing({ api, sessionId, documentId, signal: lifetime.signal, t,
    onError(error) { errors.push(String(error)) } })
  const snapshot = { id: documentId, contentVersion: 'fixture-v1', document: { pageCount: 3, pages: [], annotations: [] },
    reader: { bytesHash: 'fixture-hash' } } as WorkspaceSnapshot
  const pdf = useRef<NativeDocument>()
  pdf.current ??= new NativeDocument(snapshot, sessionId, {
    async outline() { return [] }, async destination(_session, _id, _reader, value) { return value },
    async links() { return [] }, async text() { return { lang: null, styles: {}, items: [] } },
    async tile() { throw new Error('Indexing controls fixture does not render native PDF tiles') },
  })
  const search = useReaderSearch({ document: pdf.current, pages: [], ocrPages: new Map(), tabSignal: lifetime.signal,
    onError(error) { errors.push(String(error)) } })
  const panels = readerSidebarPanels({ snapshot, pdf: pdf.current, annotations: [], clearAnnotation() {}, selectAnnotation() {},
    jump() {}, ocrTranscript: null, search, indexing: indexing.control, engineCatalog,
    translation: { selection: null, async translate() { throw new Error('Translation is outside this fixture') },
      begin() {}, close() {}, reset() {} }, translationRegistry, translationEngine: 'none', t })
  return <div className="dsh-pdf-reader" data-reader-view={name} style={{ height: '100%', width: '100%' }}>
    <div className="dsh-pdf-body">
      <ReaderToolbar menuRef={menu} state={state} actions={actions} statuses={indexing.statuses} t={t} />
      <div className="dsh-pdf-content"><div className="dsh-pdf-scroll"><p>Shared PDF index controls</p></div></div>
      <ReadingSidebar activeSection="search" expanded onSectionChange={() => {}} onExpandedChange={() => {}}
        panels={{ search: panels.search }} pdf={pdf.current} currentPage={1} pageInput="1" navigating={false}
        onPageInputChange={() => {}} onPageInputSubmit={() => {}} onPageInputReset={() => {}} onNavigatePage={() => {}}
        onStepPage={() => {}} onNavigateDestination={() => {}} t={t} />
    </div>
  </div>
}

createRoot(document.getElementById('indexing-root')!).render(<>
  <div data-view-shell="first" style={{ height: '100%' }}><View name="first" sessionId="session-a" documentId="alpha" /></div>
  <div data-view-shell="mirror" style={{ height: '100%', display: 'none' }}><View name="mirror" sessionId="session-a" documentId="alpha" /></div>
  <div data-view-shell="other-session" style={{ height: '100%', display: 'none' }}><View name="other-session" sessionId="session-b" documentId="beta" /></div>
</>)

Object.assign(window, { __pdfIndexingFixture: {
  calls: () => structuredClone(calls), errors: () => [...errors], revision: () => api.getSnapshot('session-a').revision,
  show(name: string) { for (const element of document.querySelectorAll<HTMLElement>('[data-view-shell]')) element.style.display = element.dataset.viewShell === name ? '' : 'none' },
  publish(state: PdfIndexingTask['state'], sessionId = 'session-a', documentId = 'alpha') {
    const value = host(sessionId), current = value.tasks.find(task => task.documentId === documentId)
    changed(sessionId, { enabled: value.enabled, tasks: [{ documentId, title: `${documentId}.pdf`,
      occurrence: current?.occurrence ?? 1, state, ...(state === 'failed' ? { failureCode: 'fixture/unavailable' } : {}) }],
      documents: value.documents?.map(settings => state === 'ready' && settings.documentId === documentId
        ? { ...settings, activePolicy: settings.policy, pending: false, impact: 'none' } : settings) })
  },
  republish() { const value = host('session-a'); changed('session-a', value) },
  disable() { const value = host('session-a'); changed('session-a', { enabled: false, tasks: [], documents: value.documents?.map(settings => ({
    ...settings, revision: settings.revision + 1, policy: { ...settings.policy, embeddingEngine: 'none' },
    activePolicy: { ...settings.policy, embeddingEngine: 'none' }, pending: false, impact: 'none',
  })) }) },
} })
