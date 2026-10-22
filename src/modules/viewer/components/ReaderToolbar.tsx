import React from 'react'
import type { HostOcrAvailability } from '../ports/ocr.js'
import { BackHistoryControl } from './BackHistoryControl.js'
import { ZoomMenu } from './ZoomMenu.js'
import { ToolbarDisclosure } from './ToolbarDisclosure.js'
import { ToolbarIcon } from './ToolbarIcon.js'
import { ToolbarTooltip } from './ToolbarTooltip.js'
import { ReaderModeControl, type ReaderModeStatus } from './ReaderModeControl.js'
import type { ExplanationStatusBarProps } from './ExplanationStatusBar.js'
import { FloatingStatusRail, type FloatingStatus } from './FloatingStatusRail.js'

type History = React.ComponentProps<typeof BackHistoryControl>['history']
type Fit = 'custom' | 'width' | 'page'

export interface ReaderToolbarState {
  hasDocument: boolean
  canPromptExplanation: boolean
  explanationActive: boolean
  explanationSending: boolean
  screenshotActive: boolean
  screenshotPreparing: boolean
  busy: boolean
  editable: boolean
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
    || (!state.dirty && !state.conflict && !state.canRedo && !state.hasUnappliedAnnotation)
  return <ToolbarTooltip><div className="dsh-pdf-toolbar dsh-pdf-main-toolbar dsh-pdf-glass" role="toolbar"
    aria-label={t('reader.sidebar.toolbar')} aria-busy={state.busy || undefined}>
    <ReaderModeControl mode={mode} explanation={explanation} t={t} />
    <ToolbarDisclosure detailsRef={menuRef} className="dsh-pdf-tools" label={t('reader.tools')}
      menuLabel={t('reader.tools')} onOpen={actions.onOpenMenu} trigger={<ToolbarIcon name="tools" />}>
        <button disabled={!state.hasDocument || !state.canPromptExplanation || state.explanationSending || state.screenshotPreparing || state.screenshotActive}
          onClick={actions.onToggleExplanation}>{t(state.explanationActive ? 'reader.explain.exit' : 'reader.explain.start')}</button>
        {explanation && <button className="dsh-pdf-ultra-menu-action"
          disabled={!explanation.imageAvailable || explanation.sending || explanation.disabled}
          onClick={explanation.onSelectArea}>
          {t(explanation.selectingArea ? 'reader.explain.cancelArea' : 'reader.explain.selectArea')}
        </button>}
        <button disabled={!state.hasDocument || state.busy || state.screenshotPreparing || state.screenshotActive || state.explanationActive}
          onClick={actions.onScreenshot}>{t('reader.regionScreenshot')}</button>
        <button disabled={!state.editable || state.screenshotPreparing || state.screenshotActive || state.explanationActive}
          onClick={actions.onNote}>{t('reader.note')}</button>
        <button disabled={!state.hasDocument || state.ocrBusy || state.ocrAvailability?.status !== 'available'}
          title={state.ocrAvailability?.status === 'available' ? t('reader.ocrPage') : state.ocrAvailability?.reason ?? t('reader.ocrChecking')}
          onClick={actions.onOcr}>{t('reader.ocrPage')}</button>
        {state.ocrAvailability?.status !== 'available' && <p className="dsh-pdf-tools-hint">
          {state.ocrAvailability?.reason ?? t('reader.ocrChecking')}</p>}
        <button disabled={!state.hasDocument || state.busy || state.colorPending} onClick={actions.onReload}>{t('reader.reload')}</button>
        <button className="dsh-pdf-compact-menu-action" disabled={!state.editable} onClick={actions.onSaveAs}>{t('reader.saveAs')}</button>
        <button className="dsh-pdf-compact-menu-action" disabled={disabledDiscard} onClick={actions.onDiscard}>{t('reader.discard')}</button>
        <button className="dsh-pdf-minimal-menu-action" disabled={!state.canUndo || state.busy || state.colorPending} onClick={actions.onUndo}>{t('reader.undo')}</button>
        <button className="dsh-pdf-minimal-menu-action" disabled={!state.canRedo || state.busy || state.colorPending} onClick={actions.onRedo}>{t('reader.redo')}</button>
        <button className="dsh-pdf-tiny-menu-action" disabled={!state.editable || !state.dirty} onClick={actions.onSave}>{t('reader.save')}</button>
        <button className="dsh-pdf-micro-menu-action" disabled={!state.canGoBack || state.busy || state.navigating} onClick={actions.onBack}>{t('reader.back')}</button>
        <button className="dsh-pdf-ultra-menu-action" onClick={() => { actions.onZoom('width'); if (menuRef.current) menuRef.current.open = false }}>{t('reader.fitWidth')}</button>
        <button className="dsh-pdf-ultra-menu-action" onClick={() => { actions.onZoom('page'); if (menuRef.current) menuRef.current.open = false }}>{t('reader.fitPage')}</button>
        <button className="dsh-pdf-ultra-menu-action" onClick={() => { actions.onZoom(1); if (menuRef.current) menuRef.current.open = false }}>100%</button>
    </ToolbarDisclosure>
    <div className="dsh-pdf-toolbar-controls">
      <BackHistoryControl history={state.history} disabled={state.busy || state.navigating} t={t}
        onBack={actions.onBack} onBackTo={actions.onBackTo} />
      {/* A page jump may still be loading, but zoom should not visibly flicker disabled. */}
      <ZoomMenu fit={state.fit} zoom={state.zoom} t={t} onSelect={actions.onZoom} />
      <span className="dsh-pdf-toolbar-divider" aria-hidden="true" />
      <button className="dsh-pdf-toolbar-undo" disabled={!state.canUndo || state.busy || state.colorPending}
        aria-label={t('reader.undo')} data-tooltip={t('reader.undo')} onClick={actions.onUndo}><ToolbarIcon name="undo" /></button>
      <button className="dsh-pdf-toolbar-redo" disabled={!state.canRedo || state.busy || state.colorPending}
        aria-label={t('reader.redo')} data-tooltip={t('reader.redo')} onClick={actions.onRedo}><ToolbarIcon name="redo" /></button>
      <button className="dsh-pdf-primary dsh-pdf-toolbar-save" disabled={!state.editable || !state.dirty}
        aria-label={t('reader.save')} data-tooltip={t('reader.save')} onClick={actions.onSave}><ToolbarIcon name="save" /></button>
      <button className="dsh-pdf-toolbar-save-as" disabled={!state.editable}
        aria-label={t('reader.saveAs')} data-tooltip={t('reader.saveAs')} onClick={actions.onSaveAs}><ToolbarIcon name="saveAs" /></button>
      <button className="dsh-pdf-toolbar-discard" disabled={disabledDiscard}
        aria-label={t('reader.discard')} data-tooltip={t('reader.discardHelp')} onClick={actions.onDiscard}><ToolbarIcon name="discard" /></button>
    </div>
    <FloatingStatusRail statuses={statuses} t={t} />
  </div></ToolbarTooltip>
}
