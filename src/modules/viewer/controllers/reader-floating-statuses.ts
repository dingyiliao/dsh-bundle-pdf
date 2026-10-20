import type { FloatingStatus } from '../components/FloatingStatusRail.js'
import type { SaveFeedbackState } from './use-reader-save.js'

export interface ReaderFloatingStatusesOptions {
  saveFeedback: SaveFeedbackState | null
  documentPath?: string
  mode: 'text' | 'region' | 'note'
  explanationActive: boolean
  regionPurpose: 'explanation' | 'screenshot' | null
  screenshotPhase: 'preparing' | 'cancelling' | null
  ocrProgress: 'preparing' | 'recognizing' | 'cancelling' | null
  onSaveExpired(occurrence: number): void
  onExitNote(): void
  onCancelScreenshot(): void
  onCancelOcr(): void
  t(key: string): string
}

/** Right-aligned transient feedback, ordered by first appearance in the rail. */
export function readerFloatingStatuses(options: ReaderFloatingStatusesOptions): FloatingStatus[] {
  const { saveFeedback, documentPath, mode, explanationActive, regionPurpose,
    screenshotPhase, ocrProgress, onSaveExpired, onExitNote, onCancelScreenshot, onCancelOcr, t } = options
  const statuses: FloatingStatus[] = []
  if (saveFeedback) {
    const { kind, durationMs, occurrence } = saveFeedback
    statuses.push({ id: 'save', kind, className: 'dsh-pdf-save-feedback', activity: 'dot',
      content: t(kind === 'saving' ? 'reader.saving' : kind === 'saved' ? 'reader.saved' : 'reader.unsaved'),
      title: saveFeedback.path ?? documentPath, durationMs, occurrence,
      onExpire: () => onSaveExpired(occurrence) })
  }
  if (mode === 'note' && !explanationActive) statuses.push({ id: 'note-mode',
    content: t('reader.placeNote'),
    actions: [{ label: t('reader.cancel'), onClick: onExitNote }] })
  if (mode === 'region' && regionPurpose === 'screenshot' && !explanationActive) statuses.push({ id: 'region-selection',
    content: t('reader.screenshotHint'),
    actions: [{ label: t('reader.cancel'), onClick: onCancelScreenshot }] })
  if (screenshotPhase) statuses.push({ id: 'screenshot', activity: 'progress',
    content: t(screenshotPhase === 'cancelling' ? 'reader.screenshotCancelling' : 'reader.screenshotPreparing'),
    actions: [{ label: t('reader.cancel'), onClick: onCancelScreenshot, disabled: screenshotPhase === 'cancelling' }] })
  if (ocrProgress) statuses.push({ id: 'ocr', activity: 'progress',
    content: t(ocrProgress === 'preparing' ? 'reader.ocrPreparing'
      : ocrProgress === 'recognizing' ? 'reader.recognizing' : 'reader.ocrCancelling'),
    actions: [{ label: t('reader.cancel'), onClick: onCancelOcr, disabled: ocrProgress === 'cancelling' }] })
  return statuses
}
