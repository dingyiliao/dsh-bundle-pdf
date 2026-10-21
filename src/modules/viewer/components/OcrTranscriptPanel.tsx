import React, { useState } from 'react'
import type { HostOcrRecognition } from '../ports/ocr.js'

export interface OcrTranscriptPanelProps {
  result: HostOcrRecognition | null
  region: boolean
  t: (key: string) => string
}

/** Text-only OCR is a transcript, not a selectable PDF text layer. */
export function OcrTranscriptPanel({ result, region, t }: OcrTranscriptPanelProps) {
  const [copyError, setCopyError] = useState('')
  return <div className="dsh-pdf-ocr-panel">
    {!result ? <p className="dsh-pdf-muted">{t('reader.ocrHint')}</p> : <>
      <div className="dsh-pdf-ocr-meta">
        <span>{t('reader.page')} {result.page} · {t(region ? 'reader.ocrRegion' : 'reader.ocrPage')}</span>
        <span>{result.source.backendId}</span>
      </div>
      {result.status === 'partial' && <p className="dsh-pdf-ocr-warning" role="status">{t('reader.ocrPartial')}</p>}
      <p className="dsh-pdf-muted">{t('reader.ocrTranscriptHint')}</p>
      {result.text ? <>
        <pre className="dsh-pdf-ocr-transcript">{result.text}</pre>
        <button type="button" onClick={() => {
          setCopyError('')
          try {
            if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
            void navigator.clipboard.writeText(result.text).catch(() => setCopyError(t('reader.ocrCopyFailed')))
          } catch { setCopyError(t('reader.ocrCopyFailed')) }
        }}>{t('reader.ocrCopy')}</button>
        {copyError && <p role="alert" className="dsh-pdf-ocr-warning">{copyError}</p>}
      </> : <p className="dsh-pdf-muted">{t('reader.ocrNoText')}</p>}
    </>}
  </div>
}
