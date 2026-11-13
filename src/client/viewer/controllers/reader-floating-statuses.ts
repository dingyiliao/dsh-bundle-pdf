import type { FloatingStatus } from '../components/FloatingStatusRail.js'
import type { ReaderModeStatus } from '../components/ReaderModeControl.js'
import type { SaveFeedbackState } from './use-reader-save.js'

export interface ReaderFloatingStatusesOptions {
  saveFeedback: SaveFeedbackState | null
  documentPath?: string
  mode: 'text' | 'region' | 'note'
  explanationActive: boolean
  explanation?: { sending: boolean; error: string; review(): void; dismiss(): void }
  regionPurpose: 'explanation' | 'screenshot' | null
  screenshotPhase: 'preparing' | 'cancelling' | null
  ocrProgress: 'preparing' | 'recognizing' | 'cancelling' | null
  onSaveExpired(occurrence: number): void
  onExitNote(): void
  onCancelScreenshot(): void
  onCancelOcr(): void
  t(key: string): string
}

/** Mutually exclusive input mode, placed in the toolbar rather than the activity list. */
export function readerModeStatus(options: ReaderFloatingStatusesOptions): ReaderModeStatus | null {
  const { mode, explanationActive, regionPurpose, onExitNote, onCancelScreenshot, t } = options
  if (explanationActive) return null
  if (mode === 'note') return { kind: 'note', label: t('reader.placeNote'), onCancel: onExitNote }
  if (mode === 'region' && regionPurpose === 'screenshot') return {
    kind: 'region', label: t('reader.screenshotHint'), onCancel: onCancelScreenshot,
  }
  return null
}

/** Background work and short-lived outcomes; modes have their own toolbar control. */
export function readerFloatingStatuses(options: ReaderFloatingStatusesOptions): FloatingStatus[] {
  const { saveFeedback, documentPath, screenshotPhase, ocrProgress,
    onSaveExpired, onCancelScreenshot, onCancelOcr, t } = options
  const statuses: FloatingStatus[] = []
  if (options.explanation?.sending) statuses.push({ id: 'explanation', activity: 'progress',
    content: t('reader.explain.sending'), title: documentPath })
  else if (options.explanation?.error) statuses.push({ id: 'explanation', kind: 'error', tone: 'error', activity: 'dot',
    content: options.explanation.error, title: documentPath,
    actions: [{ label: t('reader.explain.review'), onClick: options.explanation.review },
      { label: t('reader.dismiss'), onClick: options.explanation.dismiss }] })
  if (saveFeedback) {
    const { kind, durationMs, occurrence } = saveFeedback
    statuses.push({ id: 'save', kind: kind === 'failed' ? 'error' : kind, className: 'dsh-pdf-save-feedback', activity: 'dot',
      tone: kind === 'saving' ? 'progress' : kind === 'saved' ? 'success' : kind === 'failed' ? 'error' : 'neutral',
      content: t(kind === 'saving' ? 'reader.saving' : kind === 'saved' ? 'reader.saved'
        : kind === 'failed' ? 'reader.saveFailed' : 'reader.unsaved'),
      title: saveFeedback.path ?? documentPath, durationMs, occurrence,
      onExpire: () => onSaveExpired(occurrence) })
  }
  if (screenshotPhase) statuses.push({ id: 'screenshot', activity: 'progress',
    content: t(screenshotPhase === 'cancelling' ? 'reader.screenshotCancelling' : 'reader.screenshotPreparing'),
    actions: [{ label: t('reader.cancel'), onClick: onCancelScreenshot, disabled: screenshotPhase === 'cancelling' }] })
  if (ocrProgress) statuses.push({ id: 'ocr', activity: 'progress',
    content: t(ocrProgress === 'preparing' ? 'reader.ocrPreparing'
      : ocrProgress === 'recognizing' ? 'reader.recognizing' : 'reader.ocrCancelling'),
    actions: [{ label: t('reader.cancel'), onClick: onCancelOcr, disabled: ocrProgress === 'cancelling' }] })
  return statuses
}
