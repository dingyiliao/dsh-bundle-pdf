import React from 'react'
import { ToolbarIcon } from './ToolbarIcon.js'

export interface ExplanationStatusBarProps {
  compact?: boolean
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

/** The mode stays visible without covering the page with an excerpt list. */
export function ExplanationStatusBar({ compact = false, count, max, sending, disabled = false, error, imageAvailable, imageReason,
  selectingArea, t, onSend, onExit, onSelectArea }: ExplanationStatusBarProps) {
  return <section className="dsh-pdf-explanation-status" aria-label={t('reader.explain.title')}>
    <div className="dsh-pdf-explanation-status-row">
      {!compact && <span className="dsh-pdf-explanation-status-mode">
        <span className="dsh-pdf-explanation-status-dot" aria-hidden="true" />
        {t('reader.explain.title')}
        <span className="dsh-pdf-explanation-status-count">{count}/{max}</span>
      </span>}
      <span className="dsh-pdf-explanation-status-actions">
        <span title={imageReason || t(selectingArea ? 'reader.explain.cancelArea' : 'reader.explain.selectArea')}>
          <button type="button" className="dsh-pdf-explanation-status-area" aria-pressed={selectingArea}
            aria-label={t(selectingArea ? 'reader.explain.cancelArea' : 'reader.explain.selectArea')}
            disabled={!imageAvailable || sending || disabled} onClick={onSelectArea}>
            <svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 7V4a1 1 0 0 1 1-1h3m6 0h3a1 1 0 0 1 1 1v3m0 6v3a1 1 0 0 1-1 1h-3m-6 0H4a1 1 0 0 1-1-1v-3" />
              <path d="M6.5 12.5 9 9l2.1 2.3 1.3-1.5 1.6 2.7H6.5Z" />
            </svg>
          </button>
        </span>
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
