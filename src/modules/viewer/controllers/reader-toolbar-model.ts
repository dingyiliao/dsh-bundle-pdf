import type { WorkspaceSnapshot, PdfClientApi } from '../../../shared/contracts.js'
import type { HostOcrAvailability } from '../ports/ocr.js'
import type { ReaderToolbarActions, ReaderToolbarState } from '../components/ReaderToolbar.js'

type Fit = ReaderToolbarState['fit']
type Act = (operation: (current: WorkspaceSnapshot) => Promise<WorkspaceSnapshot>) => Promise<WorkspaceSnapshot | undefined>

export interface ReaderToolbarModelOptions {
  snapshot: WorkspaceSnapshot | null
  sessionId: string
  signal: AbortSignal
  api: Pick<PdfClientApi, 'reload' | 'undo' | 'redo'>
  act: Act
  busy: boolean
  editable: boolean
  colorPending: boolean
  saveAsPicking: boolean
  hasUnappliedAnnotation: boolean
  explanation: {
    allowed: boolean
    active: boolean
    sending: boolean
    start(): void
    cancel(): void
  }
  screenshot: {
    active: boolean
    preparing: boolean
    begin(): void
    canPlaceNote(): boolean
    clearRegionPurpose(): void
  }
  ocr: {
    busy: boolean
    availability: HostOcrAvailability | null
    refresh(): void
    recognize(): void
  }
  navigation: {
    canGoBack: boolean
    navigating: boolean
    history: ReaderToolbarState['history']
    fit: Fit
    zoom: number
    back(depth?: number, revision?: number): void
    canZoom(): boolean
    setFit(value: Fit): void
    setZoom(value: number): void
  }
  commands: {
    clearSelection(): void
    clearAnnotation(): void
    setMode(value: 'text' | 'note'): void
    closeMenu(): void
    confirmReload(): void
    beginSaveAs(): void
    discardChanges(): void
    save(): void
  }
}

/** Translate live Reader ownership into the toolbar's visual state and commands. */
export function readerToolbarModel(options: ReaderToolbarModelOptions): {
  state: ReaderToolbarState
  actions: ReaderToolbarActions
} {
  const { snapshot, sessionId, signal, api, act, busy, editable, colorPending,
    saveAsPicking, hasUnappliedAnnotation, explanation, screenshot, ocr, navigation, commands } = options
  const state: ReaderToolbarState = {
    hasDocument: !!snapshot, canPromptExplanation: explanation.allowed,
    explanationActive: explanation.active, explanationSending: explanation.sending,
    screenshotActive: screenshot.active, screenshotPreparing: screenshot.preparing,
    busy, editable, ocrBusy: ocr.busy, ocrAvailability: ocr.availability,
    dirty: !!snapshot?.dirty, canUndo: !!snapshot?.canUndo, canRedo: !!snapshot?.canRedo,
    conflict: !!snapshot?.conflict, colorPending, saveAsPicking, hasUnappliedAnnotation,
    canGoBack: navigation.canGoBack, navigating: navigation.navigating,
    history: navigation.history, fit: navigation.fit, zoom: navigation.zoom,
  }
  const actions: ReaderToolbarActions = {
    onOpenMenu: ocr.refresh,
    onToggleExplanation: () => explanation.active ? explanation.cancel() : explanation.start(),
    onScreenshot: screenshot.begin,
    onNote: () => {
      if (!screenshot.canPlaceNote()) return
      screenshot.clearRegionPurpose()
      commands.clearSelection(); commands.clearAnnotation(); commands.setMode('note'); commands.closeMenu()
    },
    onOcr: () => { commands.setMode('text'); ocr.recognize(); commands.closeMenu() },
    onReload: () => {
      if (snapshot?.dirty || snapshot?.canRedo) commands.confirmReload()
      else void act(current => api.reload(sessionId, current.id, current.revision, signal))
      commands.closeMenu()
    },
    onSaveAs: () => { commands.closeMenu(); commands.beginSaveAs() },
    onDiscard: () => { commands.closeMenu(); commands.discardChanges() },
    onUndo: () => { commands.closeMenu(); void act(current => api.undo(sessionId, current.id, current.revision, signal)) },
    onRedo: () => { commands.closeMenu(); void act(current => api.redo(sessionId, current.id, current.revision, signal)) },
    onSave: () => { commands.closeMenu(); commands.save() },
    onBack: () => { commands.closeMenu(); navigation.back() },
    onBackTo: (depth, revision) => navigation.back(depth, revision),
    onZoom: value => {
      if (!navigation.canZoom()) return
      if (typeof value === 'number') { navigation.setFit('custom'); navigation.setZoom(value) }
      else navigation.setFit(value)
    },
  }
  return { state, actions }
}
