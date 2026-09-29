import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { TranslationError, type TranslationRequest, type TranslationResult } from '../translation/index.js'
import { ScrollablePanel } from './ScrollablePanel.js'

export interface TranslationPanelProps {
  selection: {
    text: string
    pages: readonly number[]
    sourceLanguage: string
    targetLanguage: string
  }
  engineName: string
  translate: (request: TranslationRequest) => Promise<TranslationResult>
  onClose: () => void
  t: (key: string) => string
}

const targetLanguages = ['zh', 'en', 'ja', 'ko', 'fr', 'de'] as const
const errorKeys: Readonly<Record<TranslationError['code'], string>> = {
  disabled: 'errorDisabled',
  'not-configured': 'errorNotConfigured',
  'engine-unavailable': 'errorEngineUnavailable',
  'authentication-failed': 'errorAuthentication',
  'invalid-request': 'errorInvalidRequest',
  'limit-exceeded': 'errorLimitExceeded',
  timeout: 'errorTimeout',
  cancelled: 'cancelled',
  'stale-result': 'cancelled',
  'translation-failed': 'errorFailed',
}

interface PanelResult { value: TranslationResult; targetLanguage: string }
type PanelStatus = 'loading' | 'complete' | 'cancelled' | 'error'

/** An explicit, cancellable translation of the selection captured by the reader. */
export function TranslationPanel({ selection, engineName, translate, onClose, t }: TranslationPanelProps) {
  const callbacks = useRef({ translate, onClose, t })
  callbacks.current = { translate, onClose, t }
  const alive = useRef(false)
  const closeRequested = useRef(false)
  const generation = useRef(0)
  const active = useRef<AbortController>()
  const latestResult = useRef<PanelResult>()
  const titleId = useId()
  const targetId = useId()
  const [targetLanguage, setTargetLanguage] = useState(selection.targetLanguage)
  const [status, setStatus] = useState<PanelStatus>('loading')
  const [result, setResult] = useState<PanelResult>()
  const [errorKey, setErrorKey] = useState<string>()
  const [copyErrorKey, setCopyErrorKey] = useState<string>()
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied'>('idle')

  const invalidate = useCallback(() => {
    generation.current++
    active.current?.abort()
    active.current = undefined
  }, [])

  const startTranslation = useCallback((source: TranslationPanelProps['selection'], target: string) => {
    if (!alive.current || closeRequested.current) return
    invalidate()
    const requestGeneration = generation.current
    const controller = new AbortController()
    active.current = controller
    latestResult.current = undefined
    setResult(undefined)
    setStatus('loading')
    setErrorKey(undefined)
    setCopyErrorKey(undefined)
    setCopyState('idle')
    const translateSelection = callbacks.current.translate
    const current = () => alive.current && !closeRequested.current && !controller.signal.aborted
      && generation.current === requestGeneration

    // StrictMode's first cleanup aborts this request before its microtask runs.
    void Promise.resolve().then(async () => {
      if (!current()) return
      try {
        const value = await translateSelection({
          text: source.text,
          sourceLanguage: source.sourceLanguage,
          targetLanguage: target,
          signal: controller.signal,
        })
        if (!current()) return
        const completed = { value, targetLanguage: target }
        latestResult.current = completed
        setResult(completed)
        setStatus('complete')
      } catch (cause) {
        if (!current()) return
        if (cause instanceof TranslationError && (cause.code === 'cancelled' || cause.code === 'stale-result')) {
          setStatus('cancelled')
        } else {
          setErrorKey(cause instanceof TranslationError ? errorKeys[cause.code] : 'errorFailed')
          setStatus('error')
        }
      } finally {
        if (active.current === controller) active.current = undefined
      }
    })
  }, [invalidate])

  useEffect(() => {
    alive.current = true
    closeRequested.current = false
    setTargetLanguage(selection.targetLanguage)
    startTranslation(selection, selection.targetLanguage)
    return () => {
      alive.current = false
      invalidate()
    }
  }, [selection, invalidate, startTranslation])

  const requestClose = useCallback(() => {
    if (closeRequested.current) return
    closeRequested.current = true
    invalidate()
    callbacks.current.onClose()
  }, [invalidate])

  const cancel = () => {
    invalidate()
    setStatus('cancelled')
    setErrorKey(undefined)
  }

  const copyResult = async () => {
    const captured = latestResult.current
    if (!captured || !alive.current || closeRequested.current) return
    const copyGeneration = generation.current
    const current = () => alive.current && !closeRequested.current && generation.current === copyGeneration
      && latestResult.current === captured
    setCopyErrorKey(undefined)
    try {
      if (!navigator.clipboard?.writeText) {
        setCopyErrorKey('clipboardUnavailable')
        return
      }
      setCopyState('copying')
      // Begin the clipboard write in the click gesture, before awaiting anything.
      await navigator.clipboard.writeText(captured.value.text)
      if (current()) setCopyState('copied')
    } catch {
      if (current()) {
        setCopyState('idle')
        setCopyErrorKey('copyFailed')
      }
    }
  }

  const label = (key: string) => t(`reader.translation.${key}`)
  const languageName = (language: string) => language === 'auto' || targetLanguages.some(value => value === language)
    ? label(`language.${language}`) : language
  const languages: readonly string[] = targetLanguages.some(value => value === selection.targetLanguage)
    ? targetLanguages : [...targetLanguages, selection.targetLanguage]
  const pages = [...new Set(selection.pages)].join(', ')
  const loading = status === 'loading'

  return <ScrollablePanel className="dsh-pdf-translation-panel" verticalLabel={t('reader.verticalScroll')}
    horizontalLabel={t('reader.horizontalScroll')}>
    <section className="dsh-pdf-translation-content" aria-labelledby={titleId} onKeyDown={(event) => {
      // Shortcuts inside the panel must not edit the PDF behind it.
      event.stopPropagation()
      if (event.key === 'Escape') {
        event.preventDefault()
        requestClose()
      }
    }}>
      <div className="dsh-pdf-panel-heading">
        <h3 id={titleId}>{label('title')}</h3>
        <button type="button" onClick={requestClose} aria-label={label('close')}>×</button>
      </div>
      <p className="dsh-pdf-translation-meta">
        {label('engine')} {engineName}<br />{label('pages')} {pages}
      </p>
      <p className="dsh-pdf-muted">{label('selectionOnly')}</p>
      <div className="dsh-pdf-translation-controls">
        <label htmlFor={targetId}>{label('targetLanguage')}</label>
        <select id={targetId} value={targetLanguage} onChange={(event) => setTargetLanguage(event.target.value)}>
          {languages.map(language => <option key={language} value={language}>{languageName(language)}</option>)}
        </select>
        <button type="button" disabled={loading} onClick={() => startTranslation(selection, targetLanguage)}>
          {label(status === 'error' || status === 'cancelled' ? 'retry' : 'translate')}
        </button>
        {loading && <button type="button" onClick={cancel}>{label('cancel')}</button>}
      </div>
      <details className="dsh-pdf-translation-original">
        <summary>{label('original')} · {languageName(selection.sourceLanguage)}</summary>
        <div className="dsh-pdf-translation-text" dir="auto">{selection.text}</div>
      </details>
      <div className="dsh-pdf-translation-status" role="status" aria-live="polite">
        {loading ? label('loading') : status === 'cancelled' ? label('cancelled') : copyState === 'copied' ? label('copied') : null}
      </div>
      {errorKey && <p className="dsh-pdf-translation-error" role="alert">{label(errorKey)}</p>}
      {result && <section className="dsh-pdf-translation-result" aria-busy={loading}>
        <h4>{label('result')} · {languageName(result.targetLanguage)}</h4>
        {result.value.detectedSourceLanguage && <p className="dsh-pdf-translation-meta">
          {label('detectedLanguage')} {languageName(result.value.detectedSourceLanguage)}
        </p>}
        {result.value.status === 'partial' && <p className="dsh-pdf-translation-warning" role="status">{label('partial')}</p>}
        {!!result.value.warnings.length && <ul className="dsh-pdf-translation-warnings">
          {result.value.warnings.map((warning, index) => <li key={`${index}:${warning}`}>
            {warning === 'max-tokens' ? label('warningMaxTokens') : <>{label('warningUnknown')} {warning}</>}
          </li>)}
        </ul>}
        <div className="dsh-pdf-translation-text" dir="auto" tabIndex={0}>{result.value.text}</div>
        <button type="button" disabled={copyState === 'copying'} onClick={() => void copyResult()}>
          {label(copyState === 'copying' ? 'copying' : 'copy')}
        </button>
      </section>}
      {copyErrorKey && <p className="dsh-pdf-translation-error" role="alert">{label(copyErrorKey)}</p>}
    </section>
  </ScrollablePanel>
}
