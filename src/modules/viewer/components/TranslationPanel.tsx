import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { TranslationError, type TranslationErrorCode, type TranslationRequest, type TranslationResult } from '../../../translation/index.js'
import { translationSourceLanguage, translationTargetLanguages } from '../../../shared/contracts.js'
import { ScrollablePanel } from './ScrollablePanel.js'
import { TranslationLanguageMenu } from './TranslationLanguageMenu.js'

export interface TranslationPanelProps {
  selection: {
    text: string
    pages: readonly number[]
    targetLanguage: string
    selectionBefore?: string
    selectionAfter?: string
  }
  engineName: string
  translate: (request: TranslationRequest) => Promise<TranslationResult>
  rememberTargetLanguage?: (language: string) => Promise<boolean>
  onClose: () => void
  t: (key: string) => string
}

const errorKeys: Readonly<Record<TranslationErrorCode, string>> = {
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
  'invalid-model-output': 'errorInvalidModelOutput',
  'incomplete-model-output': 'errorIncompleteModelOutput',
  'empty-model-output': 'errorEmptyModelOutput',
  'incomplete-selection': 'errorIncompleteSelection',
  'unrecognized-selection': 'errorUnrecognizedSelection',
}

interface PanelResult { value: TranslationResult }
type PanelStatus = 'loading' | 'complete' | 'cancelled' | 'error'

/** Show only classified, localized failures; Remote error messages may contain provider diagnostics. */
export function TranslationErrorNotice({ code, t }: { code: TranslationErrorCode; t: (key: string) => string }) {
  const label = (key: string) => t(`reader.translation.${key}`)
  return <div className="dsh-pdf-translation-error" role="alert">
    <span className="dsh-pdf-translation-error-icon" aria-hidden="true">!</span>
    <div>
      <strong>{label('errorTitle')}</strong>
      <p>{label(errorKeys[code])}</p>
    </div>
  </div>
}

/** Render lexical translations without repeating their serialized copy text. */
export function TranslationDetails({ detail, sourceText, t }: {
  detail: NonNullable<TranslationResult['detail']>
  sourceText: string
  t: (key: string) => string
}) {
  const label = (key: string) => t(`reader.translation.${key}`)
  return <div className="dsh-pdf-translation-details" data-translation-kind={detail.kind} tabIndex={0}>
    <div className="dsh-pdf-translation-lexical-heading">
      <strong className="dsh-pdf-translation-term" dir="auto">{sourceText}</strong>
      <span className="dsh-pdf-translation-kind">{label(detail.kind)}</span>
    </div>
    {detail.kind === 'word' && detail.pronunciation && <p className="dsh-pdf-translation-pronunciation">
      <span>{label('pronunciation')}</span> <span dir="auto">{detail.pronunciation}</span>
    </p>}
    <ol className="dsh-pdf-translation-meanings">
      {detail.meanings.map(({ partOfSpeech, meaning, example, exampleTranslation }, index) => <li key={index}>
        <div className="dsh-pdf-translation-meaning">
          <span className="dsh-pdf-translation-part-of-speech" dir="auto">{partOfSpeech}</span>
          <span dir="auto">{meaning}</span>
        </div>
        <div className="dsh-pdf-translation-example-pair">
          <p className="dsh-pdf-translation-example"><span className="dsh-pdf-visually-hidden">{label('example')}: </span><span dir="auto">{example}</span></p>
          <p className="dsh-pdf-translation-example-translation"><span className="dsh-pdf-visually-hidden">{label('exampleTranslation')}: </span><span dir="auto">{exampleTranslation}</span></p>
        </div>
      </li>)}
    </ol>
  </div>
}

export function TranslationContent({ value, sourceText, t }: {
  value: TranslationResult
  sourceText: string
  t: (key: string) => string
}) {
  return value.detail
    ? <TranslationDetails detail={value.detail} sourceText={sourceText} t={t} />
    : <div className="dsh-pdf-translation-text" dir="auto" tabIndex={0}>{value.text}</div>
}

/** An explicit, cancellable translation of the selection captured by the reader. */
export function TranslationPanel({ selection, engineName, translate, rememberTargetLanguage, onClose, t }: TranslationPanelProps) {
  const callbacks = useRef({ translate, rememberTargetLanguage, onClose, t })
  callbacks.current = { translate, rememberTargetLanguage, onClose, t }
  const alive = useRef(false)
  const closeRequested = useRef(false)
  const generation = useRef(0)
  const active = useRef<AbortController>()
  const preferenceGeneration = useRef(0)
  const latestResult = useRef<PanelResult>()
  const titleId = useId()
  const [targetLanguage, setTargetLanguage] = useState(selection.targetLanguage)
  const [status, setStatus] = useState<PanelStatus>('loading')
  const [result, setResult] = useState<PanelResult>()
  const [errorCode, setErrorCode] = useState<TranslationErrorCode>()
  const [copyErrorKey, setCopyErrorKey] = useState<string>()
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied'>('idle')
  const [preferenceStatus, setPreferenceStatus] = useState<'idle' | 'saving' | 'failed'>('idle')

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
    setErrorCode(undefined)
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
          sourceLanguage: translationSourceLanguage,
          targetLanguage: target,
          signal: controller.signal,
        })
        if (!current()) return
        const completed = { value }
        latestResult.current = completed
        setResult(completed)
        setStatus('complete')
      } catch (cause) {
        if (!current()) return
        if (cause instanceof TranslationError && (cause.code === 'cancelled' || cause.code === 'stale-result')) {
          setStatus('cancelled')
        } else {
          setErrorCode(cause instanceof TranslationError ? cause.code : 'translation-failed')
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
    preferenceGeneration.current++
    setPreferenceStatus('idle')
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
    setErrorCode(undefined)
  }

  const changeTargetLanguage = (language: string) => {
    if (language === targetLanguage) return
    setTargetLanguage(language)
    if (errorCode !== 'incomplete-selection' && errorCode !== 'unrecognized-selection') {
      startTranslation(selection, language)
    }
    const generation = ++preferenceGeneration.current
    setPreferenceStatus('saving')
    void (async () => {
      try {
        const accepted = await callbacks.current.rememberTargetLanguage?.(language) ?? false
        if (alive.current && !closeRequested.current && generation === preferenceGeneration.current) {
          setPreferenceStatus(accepted ? 'idle' : 'failed')
        }
      } catch {
        if (alive.current && !closeRequested.current && generation === preferenceGeneration.current) {
          setPreferenceStatus('failed')
        }
      }
    })()
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
  const languageName = (language: string) => language === 'auto' || translationTargetLanguages.some(value => value === language)
    ? label(`language.${language}`) : language
  const pages = [...new Set(selection.pages)].join(', ')
  const loading = status === 'loading'
  const needsNewSelection = errorCode === 'incomplete-selection' || errorCode === 'unrecognized-selection'

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
      <div className="dsh-pdf-translation-source">
        <span className="dsh-pdf-translation-source-label">{label('original')}</span>
        <p className="dsh-pdf-translation-source-text" dir="auto">{selection.text}</p>
        <p className="dsh-pdf-translation-meta">
          <span>{label('pages')} {pages}</span><span aria-hidden="true"> · </span>
          <span>{label('engine')} {engineName}</span>
        </p>
      </div>
      <div className="dsh-pdf-translation-result-header">
        <div className="dsh-pdf-translation-result-heading">
          <h4>{label('result')}</h4>
          <TranslationLanguageMenu value={targetLanguage} label={label('targetLanguage')}
            languageName={languageName} onChange={changeTargetLanguage} />
        </div>
        {result && <button type="button" disabled={copyState === 'copying'} onClick={() => void copyResult()}>
          {label(copyState === 'copied' ? 'copied' : copyState === 'copying' ? 'copying' : 'copy')}
        </button>}
        {loading && <button type="button" onClick={cancel}>{label('cancel')}</button>}
        {(status === 'error' || status === 'cancelled') && !needsNewSelection &&
          <button type="button" onClick={() => startTranslation(selection, targetLanguage)}>{label('retry')}</button>}
      </div>
      {preferenceStatus === 'saving' && <p className="dsh-pdf-translation-preference" role="status">{label('languageSaving')}</p>}
      {preferenceStatus === 'failed' && <p className="dsh-pdf-translation-preference is-error" role="alert">{label('languageSaveFailed')}</p>}
      <section className="dsh-pdf-translation-result" aria-busy={loading}>
        <div className="dsh-pdf-translation-result-body">
          <div className="dsh-pdf-translation-status" role="status" aria-live="polite">
            {loading ? label('loading') : status === 'cancelled' ? label('cancelled') : copyState === 'copied' ? label('copied') : null}
          </div>
          {errorCode && <TranslationErrorNotice code={errorCode} t={t} />}
          {result && <>
            {result.value.detectedSourceLanguage && <p className="dsh-pdf-translation-meta">
              {label('detectedLanguage')} {languageName(result.value.detectedSourceLanguage)}
            </p>}
            {result.value.status === 'partial' && <p className="dsh-pdf-translation-warning" role="status">{label('partial')}</p>}
            {!!result.value.warnings.length && <ul className="dsh-pdf-translation-warnings">
              {result.value.warnings.map((warning, index) => <li key={`${index}:${warning}`}>
                {warning === 'max-tokens' ? label('warningMaxTokens') : <>{label('warningUnknown')} {warning}</>}
              </li>)}
            </ul>}
            <TranslationContent value={result.value} sourceText={selection.text} t={t} />
          </>}
          {copyErrorKey && <p className="dsh-pdf-translation-copy-error" role="alert">{label(copyErrorKey)}</p>}
          {needsNewSelection &&
            <button type="button" className="dsh-pdf-translation-reselect" onClick={requestClose}>{label('reselect')}</button>}
        </div>
      </section>
      <p className="dsh-pdf-translation-note">{label('selectionOnly')}</p>
    </section>
  </ScrollablePanel>
}
