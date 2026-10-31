import { useEffect, useRef, useState } from 'react'
import type { ExplanationExcerpt } from '../../explanation/index.js'
import { ToolbarIcon } from './ToolbarIcon.js'
import { ReaderPopover } from './ReaderPopover.js'

export interface ExplanationToolsProps {
  excerpts: readonly ExplanationExcerpt[]
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
  onSelectText(): void
  onEditQuestion(id: string): void
  onRemoveQuestion(id: string): void
}

/** Explanation tools replace ordinary editing; navigation and file commands stay mounted. */
export function ExplanationTools({ excerpts, max, sending, disabled = false, error, imageAvailable, imageReason,
  selectingArea, t, onSend, onExit, onSelectArea, onSelectText, onEditQuestion, onRemoveQuestion }: ExplanationToolsProps) {
  const listAnchor = useRef<HTMLButtonElement>(null)
  const [listOpen, setListOpen] = useState(false)
  const count = excerpts.length
  const areaLabel = t(selectingArea ? 'reader.explain.cancelArea' : 'reader.explain.selectArea')
  useEffect(() => { if (sending) setListOpen(false) }, [sending])
  return <div className="dsh-pdf-mode-control dsh-pdf-mode-explanation"
    data-selecting-area={selectingArea || undefined} aria-label={t('reader.explain.title')}>
    <span className="dsh-pdf-mode-identity"><ToolbarIcon name="explain" />
      <span className="dsh-pdf-mode-label">{t('reader.explain.modeLabel')}</span>
    </span>
    <div className="dsh-pdf-tool-middle" role="group" aria-label={t('reader.explain.selectTools')}>
      <button type="button" className="dsh-pdf-explanation-select-text" aria-pressed={!selectingArea}
        aria-label={t('reader.explain.selectText')} data-tooltip={t('reader.explain.selectText')}
        disabled={sending || disabled} onClick={onSelectText}><ToolbarIcon name="selectText" /></button>
      <span className="dsh-pdf-explanation-area-action" data-tooltip={!imageAvailable ? imageReason || areaLabel : areaLabel}>
        <button type="button" className="dsh-pdf-explanation-status-area dsh-pdf-tool-screenshot" aria-pressed={selectingArea}
          aria-label={areaLabel} disabled={!imageAvailable || sending || disabled || (!selectingArea && count >= max)}
          onClick={onSelectArea}><ToolbarIcon name="crop" /></button>
      </span>
      <button ref={listAnchor} type="button" className="dsh-pdf-explanation-materials-trigger"
        aria-label={`${t('reader.explain.materials')}: ${count}`} aria-expanded={listOpen}
        data-tooltip={`${t('reader.explain.materials')}: ${count}`} onClick={() => setListOpen(value => !value)}>
        <ToolbarIcon name="materials" />
        {count > 0 && <span className="dsh-pdf-mode-count" aria-hidden="true">{count}</span>}
      </button>
    </div>
    <div className="dsh-pdf-explanation-status-actions">
      <button type="button" className="dsh-pdf-explanation-status-send" disabled={!count || sending || disabled || selectingArea}
        aria-label={t(sending ? 'reader.explain.sending' : error ? 'reader.explain.retry' : 'reader.explain.send')}
        aria-busy={sending || undefined} data-error={!!error || undefined}
        data-tooltip={t(sending ? 'reader.explain.sending' : disabled ? 'reader.explain.finishQuestion'
          : error ? 'reader.explain.retry' : 'reader.explain.send')} onClick={onSend}>
        {sending ? <span className="dsh-pdf-floating-status-spinner" aria-hidden="true" /> : <ToolbarIcon name="send" />}
        {error && <span className="dsh-pdf-explanation-error-dot" aria-hidden="true" />}
      </button>
      <button type="button" className="dsh-pdf-explanation-status-exit" aria-label={t('reader.explain.exit')}
        data-tooltip={t('reader.explain.exitKeep')} onClick={onExit}><ToolbarIcon name="close" /></button>
    </div>
    <ReaderPopover anchor={listAnchor} open={listOpen} onClose={() => setListOpen(false)} role="dialog"
      aria-label={t('reader.explain.materials')} className="dsh-pdf-explanation-materials dsh-pdf-glass">
      <div className="dsh-pdf-explanation-materials-heading"><span>{t('reader.explain.materials')}</span>
        <button type="button" aria-label={t('reader.explain.closeMaterials')} onClick={() => { setListOpen(false); listAnchor.current?.focus({ preventScroll: true }) }}>
          <ToolbarIcon name="close" /></button>
      </div>
      {!count && <p className="dsh-pdf-explanation-materials-empty">{t('reader.explain.materialsEmpty')}</p>}
      {excerpts.map((excerpt, index) => <div className="dsh-pdf-explanation-material" key={excerpt.id}>
        <span className="dsh-pdf-explanation-material-number" aria-hidden="true">{index + 1}</span>
        <button type="button" className="dsh-pdf-explanation-material-edit" disabled={sending || disabled}
          aria-label={`${t('reader.explain.editQuestion')} ${index + 1}`}
          onClick={() => { listAnchor.current?.focus({ preventScroll: true }); setListOpen(false); onEditQuestion(excerpt.id) }}>
          <span>{excerpt.question}</span><small>{t('reader.explain.page')} {excerpt.fragments.map(part => part.page).filter((page, i, pages) => pages.indexOf(page) === i).join(', ')}
            {' · '}{excerpt.kind === 'text' ? excerpt.text : t('reader.explain.region')}</small>
        </button>
        <button type="button" className="dsh-pdf-explanation-material-remove" disabled={sending || disabled}
          aria-label={`${t('reader.explain.deleteQuestion')} ${index + 1}`}
          onClick={() => { listAnchor.current?.focus({ preventScroll: true }); onRemoveQuestion(excerpt.id) }}>
          <ToolbarIcon name="discard" /></button>
      </div>)}
    </ReaderPopover>
  </div>
}
