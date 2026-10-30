import { ToolbarIcon } from './ToolbarIcon.js'

export interface ExplanationStatusBarProps {
  compact?: boolean
  /** A narrow reader rail places this action with its scrollable tools. */
  hideAreaAction?: boolean
  count: number
  max: number
  sending: boolean
  disabled?: boolean
  error: string
  imageAvailable: boolean
  imageReason?: string
  selectingArea: boolean
  t(key: string): string
  onSend(): void
  onExit(): void
  onSelectArea(): void
}

type ExplanationAreaActionProps = Pick<ExplanationStatusBarProps,
  'sending' | 'disabled' | 'imageAvailable' | 'imageReason' | 'selectingArea' | 't' | 'onSelectArea'> & { className?: string }

/** One action and capability guard, whether shown in the mode bar or the tool list. */
export function ExplanationAreaAction({ sending, disabled = false, imageAvailable, imageReason,
  selectingArea, t, onSelectArea, className = '' }: ExplanationAreaActionProps) {
  const label = t(selectingArea ? 'reader.explain.cancelArea' : 'reader.explain.selectArea')
  return <span className="dsh-pdf-explanation-area-action" title={imageReason || label} data-tooltip={imageReason || label}>
    <button type="button" className={`dsh-pdf-explanation-status-area ${className}`.trim()} aria-pressed={selectingArea}
      aria-label={label} disabled={!imageAvailable || sending || disabled} onClick={onSelectArea}>
      <ToolbarIcon name="crop" />
    </button>
  </span>
}

/** The mode stays visible without covering the page with an excerpt list. */
export function ExplanationStatusBar({ compact = false, hideAreaAction = false, count, max, sending, disabled = false, error, imageAvailable, imageReason,
  selectingArea, t, onSend, onExit, onSelectArea }: ExplanationStatusBarProps) {
  return <section className="dsh-pdf-explanation-status" aria-label={t('reader.explain.title')}>
    <div className="dsh-pdf-explanation-status-row">
      {!compact && <span className="dsh-pdf-explanation-status-mode">
        <span className="dsh-pdf-explanation-status-dot" aria-hidden="true" />
        {t('reader.explain.title')}
        <span className="dsh-pdf-explanation-status-count">{count}/{max}</span>
      </span>}
      <span className="dsh-pdf-explanation-status-actions">
        {!hideAreaAction && <ExplanationAreaAction sending={sending} disabled={disabled} imageAvailable={imageAvailable}
          imageReason={imageReason} selectingArea={selectingArea} t={t} onSelectArea={onSelectArea} />}
        <button type="button" className="dsh-pdf-explanation-status-send" disabled={!count || sending || disabled || selectingArea}
          aria-label={t(sending ? 'reader.explain.sending' : 'reader.explain.send')}
          title={t('reader.explain.send')} onClick={onSend}>
          <ToolbarIcon name="send" /><span>{t(sending ? 'reader.explain.sending' : 'reader.explain.sendShort')}</span>
        </button>
        <button type="button" className="dsh-pdf-explanation-status-exit" disabled={sending}
          aria-label={t('reader.explain.exit')} title={t('reader.explain.exit')} onClick={onExit}>
          <ToolbarIcon name="close" /><span>{t('reader.explain.exitShort')}</span>
        </button>
      </span>
    </div>
    {selectingArea && !compact && <p className="dsh-pdf-explanation-status-hint" role="status">{t('reader.explain.regionHint')}</p>}
    {error && <p className="dsh-pdf-explanation-status-error" role="alert">{error}</p>}
  </section>
}
