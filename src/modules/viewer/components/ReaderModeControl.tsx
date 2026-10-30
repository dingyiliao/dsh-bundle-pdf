import { useEffect, useRef, useState } from 'react'
import type { ExplanationStatusBarProps } from './ExplanationStatusBar.js'
import { ExplanationStatusBar } from './ExplanationStatusBar.js'
import { ToolbarIcon } from './ToolbarIcon.js'
import { ReaderPopover } from './ReaderPopover.js'

export interface ReaderModeStatus {
  kind: 'note' | 'region'
  label: string
  onCancel(): void
}

/** An active input mode and its actions share the toolbar's one surface. */
export function ReaderModeControl({ mode, explanation, t }: {
  mode?: ReaderModeStatus | null
  explanation?: ExplanationStatusBarProps
  t(key: string): string
}) {
  const errorAnchor = useRef<HTMLButtonElement>(null)
  const [errorOpen, setErrorOpen] = useState(false)
  useEffect(() => {
    if (explanation?.error) errorAnchor.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    setErrorOpen(!!explanation?.error)
  }, [explanation?.error])
  const identity = explanation && <>
    <ToolbarIcon name="explain" />
    <span className="dsh-pdf-mode-label">{t(explanation.selectingArea ? 'reader.explain.selectArea' : 'reader.explain.title')}</span>
    <span className="dsh-pdf-mode-count">{explanation.count}/{explanation.max}</span>
  </>
  if (explanation) return <div className="dsh-pdf-mode-control dsh-pdf-mode-explanation"
    data-selecting-area={explanation.selectingArea || undefined}
    aria-label={`${t(explanation.selectingArea ? 'reader.explain.regionHint' : 'reader.explain.title')}, ${explanation.count}/${explanation.max}`}>
    {explanation.error ? <button ref={errorAnchor} type="button" className="dsh-pdf-mode-identity dsh-pdf-mode-error-indicator"
      aria-label={`${explanation.count}/${explanation.max}: ${explanation.error}`} aria-expanded={errorOpen}
      data-tooltip={explanation.error} onClick={() => setErrorOpen(value => !value)}>{identity}</button>
      : <span className="dsh-pdf-mode-identity" title={t(explanation.selectingArea ? 'reader.explain.regionHint' : 'reader.explain.title')}>
        {identity}
      </span>}
    <ExplanationStatusBar {...explanation} error="" compact hideAreaAction />
    {explanation.error && <>
      <ReaderPopover anchor={errorAnchor} open={errorOpen} onClose={() => setErrorOpen(false)}
        className="dsh-pdf-mode-error-popover dsh-pdf-glass" role="alert">
        <p>{explanation.error}</p>
        <button type="button" onClick={() => { setErrorOpen(false); errorAnchor.current?.focus({ preventScroll: true }) }}>{t('reader.dismiss')}</button>
      </ReaderPopover>
    </>}
  </div>
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
