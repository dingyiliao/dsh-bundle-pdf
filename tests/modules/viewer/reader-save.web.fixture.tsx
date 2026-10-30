import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { PdfClientApi, WorkspaceSnapshot } from '../../../src/shared/contracts.js'
import { ReaderToolbar } from '../../../src/modules/viewer/components/ReaderToolbar.js'
import { readerFloatingStatuses } from '../../../src/modules/viewer/controllers/reader-floating-statuses.js'
import { readerToolbarModel } from '../../../src/modules/viewer/controllers/reader-toolbar-model.js'
import { useReaderMutations } from '../../../src/modules/viewer/controllers/use-reader-mutations.js'
import { useReaderSave } from '../../../src/modules/viewer/controllers/use-reader-save.js'
import { readerLocales } from '../../../src/modules/viewer/locales.js'

export interface ReaderSaveFixtureInput {
  dirty?: boolean
  loading?: boolean
  readOnly?: boolean
  conflict?: boolean
  pending?: boolean
  formPending?: boolean
  mutationBusy?: boolean
  language?: 'en' | 'zh'
}

interface PendingSave {
  snapshot: WorkspaceSnapshot
  resolve(snapshot: WorkspaceSnapshot): void
  reject(failure: Error): void
}
const lifetime = new AbortController()
const calls: number[] = []
const errors: string[] = []
let pending: PendingSave | undefined
let update: (input: ReaderSaveFixtureInput) => void = () => {}
const initial = { id: 'save-fixture', path: '/reading.pdf', sourceVersion: 'source-1', contentVersion: 'content-1',
  revision: 1, dirty: true, canUndo: true, canRedo: false, conflict: false,
  document: { pageCount: 1, pages: [], annotations: [] }, reader: { bytesHash: 'save-fixture' } } as WorkspaceSnapshot
const api = {
  save(_sessionId: string, _id: string, revision: number) {
    calls.push(revision)
    return new Promise<WorkspaceSnapshot>((resolve, reject) => { pending = { snapshot: { ...initial, revision }, resolve, reject } })
  },
  async inspectTarget() { return { version: null } },
  async reload() { return initial }, async undo() { return initial }, async redo() { return initial },
} as unknown as PdfClientApi
const noop = () => {}

function Fixture() {
  const [snapshot, setSnapshot] = useState(initial)
  const [input, setInput] = useState<ReaderSaveFixtureInput>({ language: 'en' })
  const [, setError] = useState('')
  const ownerSequence = useRef(1)
  const current = useRef<WorkspaceSnapshot | null>(snapshot)
  const menu = useRef<HTMLDetailsElement>(null)
  current.current = input.loading ? null : snapshot
  const t = (key: string) => readerLocales[input.language ?? 'en'][key] ?? key
  update = value => {
    setInput(previous => ({ ...previous, ...value }))
    if (value.dirty !== undefined || value.conflict !== undefined) setSnapshot(previous => ({ ...previous,
      revision: previous.revision + 1,
      dirty: value.dirty ?? previous.dirty, conflict: value.conflict ?? previous.conflict }))
  }
  const mutations = useReaderMutations({ api, sessionId: 'save-session', tabSignal: lifetime.signal, ownerSequence,
    currentSnapshot: () => current.current,
    acceptSnapshot: next => { setSnapshot(next); setInput(previous => ({ ...previous, formPending: false })) },
    clearError: () => setError(''), onError: failure => { errors.push(String(failure)) } })
  const save = useReaderSave({ api, sessionId: 'save-session', resourceAddress: 'session-file:///reading.pdf',
    tabSignal: lifetime.signal, snapshot: current.current, ownerSequence, operationLock: mutations.operationLock,
    currentSnapshot: () => current.current, act: mutations.act,
    openResource: noop, addressForPath: (_sessionId, path) => path,
    setError, onError: failure => { errors.push(String(failure)) }, t })
  const model = readerToolbarModel({ snapshot: current.current, sessionId: 'save-session', signal: lifetime.signal,
    api, act: mutations.act, busy: mutations.busy || !!input.mutationBusy,
    editable: !!current.current && !input.readOnly && !snapshot.conflict,
    readOnly: input.readOnly, formPending: input.formPending, saveFeedback: save.feedback,
    colorPending: false, saveAsPicking: save.saveAsPicking, hasUnappliedAnnotation: !!input.pending,
    explanation: { allowed: true, active: false, sending: false, start: noop, cancel: noop },
    screenshot: { active: false, preparing: false, begin: noop, canPlaceNote: () => true, clearRegionPurpose: noop },
    ocr: { busy: false, availability: { status: 'available' }, refresh: noop, recognize: noop },
    navigation: { canGoBack: false, navigating: false, history: { revision: 0, positions: [] }, fit: 'width', zoom: 1,
      back: noop, canZoom: () => true, setFit: noop, setZoom: noop },
    commands: { clearSelection: noop, clearAnnotation: noop, setMode: noop, closeMenu: noop, confirmReload: noop,
      beginSaveAs: noop, discardChanges: noop, save: () => { void save.save() } } })
  const statuses = readerFloatingStatuses({ saveFeedback: save.feedback, documentPath: snapshot.path, mode: 'text',
    explanationActive: false, regionPurpose: null, screenshotPhase: null, ocrProgress: null,
    onSaveExpired: occurrence => save.setFeedback(previous => previous?.occurrence === occurrence ? null : previous),
    onExitNote: noop, onCancelScreenshot: noop, onCancelOcr: noop, t })
  return <div className="dsh-pdf-reader"><div className="dsh-pdf-body">
    <ReaderToolbar t={t} menuRef={menu} state={model.state} actions={model.actions} statuses={statuses} />
    <div className="dsh-pdf-content"><div className="dsh-pdf-scroll">
      <article aria-label="Fixture PDF page" style={{ maxWidth: 620, minHeight: 720, margin: '24px auto', padding: 40,
        background: '#fff', color: '#222', boxShadow: '0 1px 8px #00000014' }}>
        <p style={{ fontSize: 10, letterSpacing: 1.5, color: '#666' }}>PDF READING FIXTURE · PAGE 1</p>
        <h1 style={{ fontFamily: 'Georgia, serif' }}>A clear place for save feedback</h1>
        <p style={{ fontFamily: 'Georgia, serif', lineHeight: 1.7 }}>The save command keeps its place as changes are written,
          confirmed, or retried. The document stays ready to read.</p>
      </article>
    </div></div>
  </div></div>
}

createRoot(document.getElementById('save-root')!).render(<Fixture />)
Object.assign(window, { __pdfReaderSaveFixture: {
  set: (input: ReaderSaveFixtureInput) => update(input),
  calls: () => [...calls], errors: () => [...errors],
  resolve() { const request = pending!; pending = undefined
    request.resolve({ ...request.snapshot, revision: request.snapshot.revision + 1, dirty: false }) },
  reject() { const request = pending!; pending = undefined; request.reject(new Error('Disk is full')) },
} })
