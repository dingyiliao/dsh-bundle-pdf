import { ToolbarIcon } from './ToolbarIcon.js'

export interface ReaderModeStatus {
  kind: 'note' | 'region'
  label: string
  onCancel(): void
}

/** Ordinary note/capture placement stays with its own cancel action. */
export function ReaderModeControl({ mode, t }: { mode?: ReaderModeStatus | null; t(key: string): string }) {
  if (!mode) return null
  return <div className="dsh-pdf-mode-control dsh-pdf-mode-inline" role="status" aria-label={mode.label}
    data-status-id={mode.kind === 'region' ? 'region-selection' : 'note-mode'}>
    <ToolbarIcon name={mode.kind === 'note' ? 'note' : 'crop'} />
    <span className="dsh-pdf-mode-label">{mode.label}</span>
    <button type="button" aria-label={t('reader.cancel')} data-tooltip={t('reader.cancel')} onClick={mode.onCancel}>
      <ToolbarIcon name="close" />
    </button>
  </div>
}
