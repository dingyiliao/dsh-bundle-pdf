import { useEffect, useRef, useState } from 'react'
import type { HostOcrRecognition } from '../ports/ocr.js'
import { SplitActionControl } from './SplitActionControl.js'
import { ToolbarIcon } from './ToolbarIcon.js'

export interface OcrTranscriptPanelProps {
  result: HostOcrRecognition | null
  region: boolean
  t: (key: string) => string
  onTranslate?: (range?: { start: number; end: number }) => void
}

/** Text-only OCR is a transcript, not a selectable PDF text layer. */
export function OcrTranscriptPanel({ result, region, t, onTranslate }: OcrTranscriptPanelProps) {
  const transcript = useRef<HTMLPreElement>(null)
  const actions = useRef<HTMLDivElement>(null)
  const generation = useRef(0)
  const [selection, setSelection] = useState<{ result: HostOcrRecognition; start: number; end: number } | null>(null)
  const [copyError, setCopyError] = useState('')
  const canTranslate = !!onTranslate
  const selected = selection?.result === result ? selection : null
  const translationLabel = t(selected ? 'reader.ocrTranslateSelection' : 'reader.ocrTranslateAll')

  useEffect(() => {
    setCopyError('')
    setSelection(null)
    const element = transcript.current
    const document = element?.ownerDocument
    const captureSelection = () => {
      const selected = document?.getSelection()
      const range = selected?.rangeCount === 1 && !selected.isCollapsed ? selected.getRangeAt(0) : null
      // The shared popup moves keyboard focus to its choices. Keep that range
      // while choosing an action, without accepting a selection from elsewhere.
      if (!range && document) {
        const trigger = actions.current?.querySelector('[aria-expanded="true"][aria-controls]')
        const popupId = trigger?.getAttribute('aria-controls')
        const focused = document.activeElement
        if (trigger && focused && (actions.current?.contains(focused)
          || popupId && document.getElementById(popupId)?.contains(focused))) return
      }
      if (!element || !result || !range || !element.contains(range.startContainer) || !element.contains(range.endContainer)) {
        setSelection(null)
        return
      }
      const prefix = element.ownerDocument.createRange()
      prefix.selectNodeContents(element)
      prefix.setEnd(range.startContainer, range.startOffset)
      const start = prefix.toString().length
      const end = start + range.toString().length
      const boundary = (offset: number) => !(offset > 0 && offset < result.text.length
        && /[\uD800-\uDBFF]/.test(result.text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(result.text[offset]!))
      setSelection(result.text.slice(start, end).trim() && result.text.slice(start, end) === range.toString()
        && boundary(start) && boundary(end) ? { result, start, end } : null)
    }
    if (canTranslate) document?.addEventListener('selectionchange', captureSelection)
    return () => {
      generation.current++
      document?.removeEventListener('selectionchange', captureSelection)
      const selected = document?.getSelection()
      if (element && selected?.rangeCount && element.contains(selected.anchorNode) && element.contains(selected.focusNode)) {
        selected.removeAllRanges()
      }
    }
  }, [result, canTranslate])

  const copy = () => {
    if (!result) return
    setCopyError('')
    const current = generation.current
    const fail = () => { if (generation.current === current) setCopyError(t('reader.ocrCopyFailed')) }
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      void navigator.clipboard.writeText(result.text).catch(fail)
    } catch { fail() }
  }

  return <div className="dsh-pdf-ocr-panel">
    {!result ? <p className="dsh-pdf-muted">{t('reader.ocrHint')}</p> : <>
      <div className="dsh-pdf-ocr-meta">
        <span>{t('reader.ocrPageLabel').replace('{page}', String(result.page))} · {t(region ? 'reader.ocrRegionResult' : 'reader.ocrPageResult')}</span>
        <span className="dsh-pdf-ocr-badge" title={t('reader.ocrTranscriptHint')} aria-label={t('reader.ocrTranscriptHint')}>OCR</span>
      </div>
      {result.status === 'partial' && <p className="dsh-pdf-ocr-warning" role="status">{t('reader.ocrPartial')}</p>}
      {result.text ? <>
        <div ref={actions} className="dsh-pdf-ocr-actions" onPointerDownCapture={event => {
          // Mouse actions retain the native text range; keyboard focus remains available.
          if (selected && event.button === 0) event.preventDefault()
        }}>
          {onTranslate && <SplitActionControl className="dsh-pdf-ocr-translate" menuClassName="dsh-pdf-ocr-translation-menu"
            menuTestId="pdf-ocr-translation-options" label={t('reader.ocrTranslationOptions')}
            actionLabel={translationLabel} actionTooltip={translationLabel} menuLabel={t('reader.ocrTranslationOptions')}
            action={<><ToolbarIcon name="translate" />
              <span className="dsh-pdf-ocr-translate-label-full">{t(selected ? 'reader.ocrTranslateSelectionLabel' : 'reader.ocrTranslateAll')}</span>
              <span className="dsh-pdf-ocr-translate-label-compact">{t('reader.translation.translate')}</span>
            </>}
            onAction={() => onTranslate(selected ? { start: selected.start, end: selected.end } : undefined)}>
            {close => <>
              <button type="button" onClick={() => { close(); onTranslate() }}>{t('reader.ocrTranslateAll')}</button>
              <button type="button" disabled={!selected} onClick={() => {
                if (selected) { close(); onTranslate({ start: selected.start, end: selected.end }) }
              }}>{t('reader.ocrTranslateSelection')}</button>
            </>}
          </SplitActionControl>}
          <button type="button" className="dsh-pdf-ocr-copy" onClick={copy}
            aria-label={t('reader.ocrCopy')} title={t('reader.ocrCopy')} data-tooltip={t('reader.ocrCopy')}>
            <ToolbarIcon name="copy" />
          </button>
        </div>
        <pre ref={transcript} className="dsh-pdf-ocr-transcript" tabIndex={0}>{result.text}</pre>
        {copyError && <p role="alert" className="dsh-pdf-ocr-warning">{copyError}</p>}
      </> : <p className="dsh-pdf-muted">{t('reader.ocrNoText')}</p>}
    </>}
  </div>
}
