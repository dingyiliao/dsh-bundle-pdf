import React from 'react'
import type { HostOcrAvailability } from '../ports/ocr.js'
import type { SaveFeedbackState } from '../controllers/use-reader-save.js'
import { ReaderSaveButton } from './ReaderSaveButton.js'
import { BackHistoryControl } from './BackHistoryControl.js'
import { ZoomMenu } from './ZoomMenu.js'
import { ToolbarDisclosure } from './ToolbarDisclosure.js'
import { ToolbarIcon, type ToolbarIconName } from './ToolbarIcon.js'
import { ToolbarTooltip } from './ToolbarTooltip.js'
import { ReaderModeControl, type ReaderModeStatus } from './ReaderModeControl.js'
import { ExplanationAreaAction, type ExplanationStatusBarProps } from './ExplanationStatusBar.js'
import { FloatingStatusRail, type FloatingStatus } from './FloatingStatusRail.js'

type History = React.ComponentProps<typeof BackHistoryControl>['history']
type Fit = 'custom' | 'width' | 'page'
const documentMenuStyleProperties = ['--pdf-document-history-display'] as const
interface ToolbarCommand { name: string; icon: ToolbarIconName; label: string; disabled: boolean; onClick(): void }

export interface ReaderToolbarState {
  hasDocument: boolean
  canPromptExplanation: boolean
  explanationActive: boolean
  explanationSending: boolean
  screenshotActive: boolean
  screenshotPreparing: boolean
  busy: boolean
  editable: boolean
  readOnly?: boolean
  formPending?: boolean
  saveFeedback?: SaveFeedbackState | null
  ocrBusy: boolean
  ocrAvailability: HostOcrAvailability | null
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
  conflict: boolean
  colorPending: boolean
  saveAsPicking: boolean
  hasUnappliedAnnotation: boolean
  canGoBack: boolean
  navigating: boolean
  history: History
  fit: Fit
  zoom: number
}

export interface ReaderToolbarActions {
  onOpenMenu(): void
  onToggleExplanation(): void
  onScreenshot(): void
  onNote(): void
  onOcr(): void
  onReload(): void
  onSaveAs(): void
  onDiscard(): void
  onUndo(): void
  onRedo(): void
  onSave(): void
  onBack(): void
  onBackTo(depth: number, revision: number): void
  onZoom(value: Fit | number): void
}

/** Visual controls only; application commands and navigation locks stay in Reader. */
export function ReaderToolbar({ t, menuRef, state, actions, mode, explanation, statuses = [] }: {
  t(key: string): string
  menuRef: React.RefObject<HTMLDetailsElement>
  state: ReaderToolbarState
  actions: ReaderToolbarActions
  mode?: ReaderModeStatus | null
  explanation?: ExplanationStatusBarProps
  statuses?: readonly FloatingStatus[]
}) {
  const disabledDiscard = !state.hasDocument || state.busy || state.saveAsPicking || state.colorPending
    || (!state.dirty && !state.formPending && !state.conflict && !state.canRedo && !state.hasUnappliedAnnotation)
  const ocrLabel = state.ocrAvailability?.status === 'available' ? t('reader.ocrPage')
    : state.ocrAvailability?.reason ?? t('reader.ocrChecking')
  const historyCommands: ToolbarCommand[] = [
    { name: 'undo', icon: 'undo', label: t('reader.undo'),
      disabled: (!state.canUndo && !state.formPending) || state.busy || state.colorPending, onClick: actions.onUndo },
    { name: 'redo', icon: 'redo', label: t('reader.redo'),
      disabled: !state.canRedo || state.busy || state.colorPending, onClick: actions.onRedo },
  ]
  const documentCommands: ToolbarCommand[] = [
    { name: 'save-as', icon: 'saveAs', label: t('reader.saveAs'), disabled: !state.editable || state.hasUnappliedAnnotation, onClick: actions.onSaveAs },
    { name: 'reload', icon: 'reload', label: t('reader.reload'), disabled: !state.hasDocument || state.busy || state.colorPending, onClick: actions.onReload },
    { name: 'discard', icon: 'discard', label: t('reader.discard'), disabled: disabledDiscard, onClick: actions.onDiscard },
  ]
  return <ToolbarTooltip><div className="dsh-pdf-tool-rail dsh-pdf-main-toolbar" data-pdf-tool-rail="" role="toolbar"
    aria-label={t('reader.sidebar.toolbar')} aria-busy={state.busy || undefined}>
    <div className="dsh-pdf-tool-rail-shell dsh-pdf-rail-shell dsh-pdf-glass">
    <div className="dsh-pdf-tool-group" role="group" data-tool-group="navigation" aria-label={t('reader.navigation')} data-reader-command="">
      <BackHistoryControl history={state.history} disabled={state.busy || state.navigating} t={t}
        onBack={actions.onBack} onBackTo={actions.onBackTo} />
      <ZoomMenu fit={state.fit} zoom={state.zoom} t={t} onSelect={actions.onZoom} />
    </div>
    <div className="dsh-pdf-tool-group dsh-pdf-tool-interaction" role="group" data-tool-group="interaction" aria-label={t('reader.editing')}
      data-explanation-active={!!explanation || undefined} data-reader-command="">
      <div className="dsh-pdf-tool-middle">
        <button type="button" className="dsh-pdf-tool-explain" aria-pressed={state.explanationActive}
          aria-label={t(state.explanationActive ? 'reader.explain.exit' : 'reader.explain.start')}
          data-tooltip={t(state.explanationActive ? 'reader.explain.exit' : 'reader.explain.start')}
          disabled={!state.hasDocument || !state.canPromptExplanation || state.explanationSending || state.screenshotPreparing || state.screenshotActive}
          onClick={actions.onToggleExplanation}><ToolbarIcon name="explain" /></button>
        <button type="button" className="dsh-pdf-tool-note" aria-label={t('reader.note')} data-tooltip={t('reader.note')}
          aria-pressed={mode?.kind === 'note'} disabled={!state.editable || state.screenshotPreparing || state.screenshotActive || state.explanationActive}
          onClick={() => mode?.kind === 'note' ? mode.onCancel() : actions.onNote()}><ToolbarIcon name="note" /></button>
        {explanation ? <ExplanationAreaAction {...explanation} className="dsh-pdf-tool-screenshot" /> : <button type="button" className="dsh-pdf-tool-screenshot" aria-label={t('reader.regionScreenshot')} data-tooltip={t('reader.regionScreenshot')}
          aria-pressed={mode?.kind === 'region'} disabled={!state.hasDocument || state.busy || state.screenshotPreparing || state.screenshotActive || state.explanationActive}
          onClick={() => mode?.kind === 'region' ? mode.onCancel() : actions.onScreenshot()}><ToolbarIcon name="crop" /></button>}
        <span data-tooltip={ocrLabel} className="dsh-pdf-tool-availability">
          <button type="button" className="dsh-pdf-tool-ocr" aria-label={t('reader.ocrPage')} title={ocrLabel}
            disabled={!state.hasDocument || state.ocrBusy || state.ocrAvailability?.status !== 'available'}
            onClick={actions.onOcr}><ToolbarIcon name="ocr" /></button>
        </span>
      </div>
      <ReaderModeControl mode={mode} explanation={explanation} t={t} />
    </div>
    <div className="dsh-pdf-tool-group dsh-pdf-tool-document" role="group" data-tool-group="document" aria-label={t('reader.fileMenu')} data-reader-command="">
      <div className="dsh-pdf-tool-history">
        {historyCommands.map(command => <button key={command.name} type="button"
          className={`dsh-pdf-toolbar-${command.name}`} data-document-command={command.name} data-command-surface="direct"
          disabled={command.disabled} aria-label={command.label} data-tooltip={command.label} onClick={command.onClick}>
          <ToolbarIcon name={command.icon} />
        </button>)}
      </div>
      <ReaderSaveButton state={state} onSave={actions.onSave} t={t} />
      <div className="dsh-pdf-document-direct" role="group" aria-label={t('reader.fileMenu')}>
        {documentCommands.map(command => <button key={command.name} type="button"
          className={`dsh-pdf-toolbar-${command.name}`} data-document-command={command.name} data-command-surface="direct"
          disabled={command.disabled} aria-label={command.label} data-tooltip={command.label} onClick={command.onClick}>
          <ToolbarIcon name={command.icon} />
        </button>)}
      </div>
      <ToolbarDisclosure detailsRef={menuRef} className="dsh-pdf-tools dsh-pdf-document-menu" label={t('reader.fileMenu')}
        menuStyleProperties={documentMenuStyleProperties}
        menuLabel={t('reader.fileMenu')} onOpen={actions.onOpenMenu} trigger={<ToolbarIcon name="file" />}>
        <div className="dsh-pdf-document-history-menu">
          {historyCommands.map(command => <button key={command.name} type="button"
            className={`dsh-pdf-toolbar-${command.name}`} data-document-command={command.name} data-command-surface="menu"
            disabled={command.disabled} aria-label={command.label} data-tooltip={command.label} onClick={command.onClick}>{command.label}</button>)}
        </div>
        {documentCommands.map(command => <button key={command.name} type="button"
          className={`dsh-pdf-toolbar-${command.name}`} data-document-command={command.name} data-command-surface="menu"
          disabled={command.disabled} aria-label={command.label} data-tooltip={command.label}
          onClick={command.onClick}>{command.label}</button>)}
      </ToolbarDisclosure>
      <FloatingStatusRail statuses={statuses} t={t} />
    </div>
    </div>
  </div></ToolbarTooltip>
}
