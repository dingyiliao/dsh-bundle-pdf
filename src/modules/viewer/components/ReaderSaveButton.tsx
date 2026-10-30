import { useId } from 'react'
import type { ReaderToolbarState } from './ReaderToolbar.js'
import { ToolbarIcon } from './ToolbarIcon.js'

type SaveState = Pick<ReaderToolbarState, 'hasDocument' | 'readOnly' | 'editable' | 'dirty' | 'formPending'
  | 'hasUnappliedAnnotation' | 'conflict' | 'busy' | 'colorPending' | 'saveAsPicking' | 'saveFeedback'>

/** Save feedback shares the command's fixed footprint and the existing feedback lifetime. */
export function ReaderSaveButton({ state, onSave, t }: {
  state: SaveState
  onSave(): void
  t(key: string): string
}) {
  const description = useId()
  const dirty = state.dirty || !!state.formPending
  const status = !state.hasDocument ? 'loading' : state.readOnly ? 'read-only'
    : state.conflict ? 'conflict' : state.hasUnappliedAnnotation ? 'pending'
      : state.saveFeedback?.kind === 'saving' ? 'saving' : state.saveFeedback?.kind === 'failed' ? 'failed'
        : dirty ? 'dirty' : state.saveFeedback?.kind === 'saved' ? 'saved-success' : 'saved'
  const label = t(status === 'loading' ? 'reader.loading' : status === 'read-only' ? 'reader.readOnly'
    : status === 'conflict' ? 'reader.sourceChanged' : status === 'pending' ? 'reader.pendingEditsHelp'
      : status === 'saving' ? 'reader.saving' : status === 'failed' ? 'reader.saveFailed'
        : status === 'dirty' ? 'reader.unsaved' : 'reader.allChangesSaved')
  const disabled = !state.hasDocument || !state.editable || !!state.readOnly || !dirty
    || state.hasUnappliedAnnotation || state.busy || state.colorPending || state.saveAsPicking || status === 'saving'
  return <span className="dsh-pdf-save-control" data-tooltip={label} tabIndex={disabled ? 0 : undefined}
    role={disabled ? 'group' : undefined} aria-label={disabled ? t('reader.save') : undefined}
    aria-describedby={disabled ? description : undefined}>
    <button type="button" className="dsh-pdf-toolbar-save" data-save-state={status}
      data-dirty={status === 'dirty' || undefined} disabled={disabled}
      aria-label={t('reader.save')} aria-describedby={description} data-tooltip={disabled ? undefined : label} onClick={onSave}>
      {status === 'saving' || status === 'loading'
        ? <span className="dsh-pdf-floating-status-spinner dsh-pdf-save-spinner" aria-hidden="true" />
        : <ToolbarIcon name={status === 'saved-success' ? 'check' : status === 'read-only' ? 'lock'
          : status === 'failed' || status === 'conflict' ? 'warning' : status === 'pending' ? 'edit' : 'save'} />}
    </button>
    <span id={description} className="dsh-pdf-visually-hidden" role="status" aria-live="polite" aria-atomic="true">{label}</span>
  </span>
}
