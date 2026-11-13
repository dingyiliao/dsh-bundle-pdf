import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { TranslationError, type TranslationErrorCode, type TranslationRequest, type TranslationResult } from '../../../translation/index.js'
import { translationSourceLanguage, translationTargetLanguages } from '../../../shared/contracts.js'
import { ScrollablePanel } from './ScrollablePanel.js'
import { TranslationLanguageMenu } from './TranslationLanguageMenu.js'
import { ToolbarIcon } from './ToolbarIcon.js'

export interface TranslationPanelProps {
  selection: {
    text: string
    pages: readonly number[]
    targetLanguage: string
    selectionBefore?: string
    selectionAfter?: string
    sourceKind?: 'ocr'
  }
  engineName: string
  translate: (request: TranslationRequest) => Promise<TranslationResult>
  rememberTargetLanguage?: (language: string) => Promise<boolean>
  onClose: () => void
  onReturnToSource?: () => void
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
}

interface PanelResult { value: TranslationResult; sourceText: string; sourceKind?: 'ocr' }
type PanelStatus = 'loading' | 'complete' | 'cancelled' | 'error'

function interpretationLabel(interpretation: NonNullable<TranslationResult['interpretation']>, t: (key: string) => string): string {
  const key = interpretation.kind === 'correction'
    ? interpretation.certainty === 'tentative' ? 'interpretationPossibleCorrection' : 'interpretationCorrection'
    : interpretation.certainty === 'tentative' ? 'interpretationPossibleCompletion' : 'interpretationCompletion'
  return t(`reader.translation.${key}`)
}

/** Clamp only the presentation; requests and copying always retain the captured selection. */
function TranslationSourceText({ text, t }: { text: string; t: (key: string) => string }) {
  const textId = useId()
  const paragraph = useRef<HTMLParagraphElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflow, setOverflow] = useState(false)

  useEffect(() => {
    const element = paragraph.current
    if (!element || expanded) return
    const measure = () => setOverflow(element.clientHeight > 0 && element.scrollHeight > element.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [expanded])

  return <>
    <p ref={paragraph} id={textId} className="dsh-pdf-translation-source-text" data-expanded={expanded} dir="auto">{text}</p>
    {(overflow || expanded) && <button type="button" className="dsh-pdf-translation-source-toggle"
      aria-expanded={expanded} aria-controls={textId} onClick={() => setExpanded(value => !value)}>
      {t(`reader.translation.${expanded ? 'collapseOriginal' : 'expandOriginal'}`)}
    </button>}
  </>
}

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
export function TranslationDetails({ detail, t }: {
  detail: NonNullable<TranslationResult['detail']>
  t: (key: string) => string
}) {
  const label = (key: string) => t(`reader.translation.${key}`)
  return <div className="dsh-pdf-translation-details" data-translation-kind={detail.kind} tabIndex={0}>
    <div className="dsh-pdf-translation-kind">{label(detail.kind)}</div>
    {detail.pronunciation && <p className="dsh-pdf-translation-pronunciation">
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

export function TranslationContent({ value, t }: {
  value: TranslationResult
  t: (key: string) => string
}) {
  const interpretation = value.interpretation
  return <>
    {interpretation && <aside className="dsh-pdf-translation-interpretation" role="note"
      data-certainty={interpretation.certainty} data-interpretation-kind={interpretation.kind}>
      <details>
        <summary>
          <strong>{interpretationLabel(interpretation, t)}</strong>
          <span className="dsh-pdf-translation-interpretation-toggle">{t('reader.translation.viewInterpretation')}</span>
          <ToolbarIcon name="chevronDown" />
        </summary>
        <p className="dsh-pdf-translation-interpreted-text" dir="auto">{interpretation.text}</p>
        <p className="dsh-pdf-translation-interpretation-explanation" dir="auto">{interpretation.explanation}</p>
      </details>
    </aside>}
    {value.detail
      ? <TranslationDetails detail={value.detail} t={t} />
      : <div className="dsh-pdf-translation-text" dir="auto" tabIndex={0}>{value.text}</div>}
  </>
}

/** An explicit, cancellable translation of the selection captured by the reader. */
export function TranslationPanel({ selection, engineName, translate, rememberTargetLanguage, onClose, onReturnToSource, t }: TranslationPanelProps) {
  const callbacks = useRef({ translate, rememberTargetLanguage, onClose, onReturnToSource, t })
  callbacks.current = { translate, rememberTargetLanguage, onClose, onReturnToSource, t }
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
        const completed = { value, sourceText: source.text, sourceKind: source.sourceKind }
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
    startTranslation(selection, language)
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
      const interpretation = captured.value.interpretation
      const copied = interpretation ? [
        `${callbacks.current.t(`reader.translation.${captured.sourceKind === 'ocr' ? 'ocrOriginal' : 'original'}`)}: ${captured.sourceText}`,
        `${interpretationLabel(interpretation, callbacks.current.t)}: ${interpretation.text}`,
        interpretation.explanation, '', captured.value.text,
      ].join('\n') : captured.value.text
      await navigator.clipboard.writeText(copied)
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

  return <ScrollablePanel className="dsh-pdf-translation-panel" verticalLabel={t('reader.verticalScroll')}
    horizontalLabel={t('reader.horizontalScroll')} title={label(selection.sourceKind === 'ocr' ? 'ocrTitle' : 'title')} titleId={titleId}
    actions={<>
      {onReturnToSource && <button type="button" aria-label={label('backToOcr')} title={label('backToOcr')}
        onClick={() => { const back = callbacks.current.onReturnToSource; requestClose(); back?.() }}>
        <ToolbarIcon name="back" />
      </button>}
      <button type="button" onClick={requestClose} aria-label={label('close')}>×</button>
    </>}
    onKeyDown={(event) => {
      // Shortcuts inside the panel must not edit the PDF behind it.
      event.stopPropagation()
      if (event.key === 'Escape') {
        event.preventDefault()
        requestClose()
      }
    }}>
    <section className="dsh-pdf-translation-content" aria-labelledby={titleId}>
      <div className="dsh-pdf-translation-source">
        <span className="dsh-pdf-translation-source-label">{label(selection.sourceKind === 'ocr' ? 'ocrOriginal' : 'original')}</span>
        <TranslationSourceText key={selection.text} text={selection.text} t={t} />
        <p className="dsh-pdf-translation-meta">{label('sourcePages').replace('{pages}', pages)}</p>
      </div>
      <div className="dsh-pdf-translation-result-header">
        <div className="dsh-pdf-translation-result-heading">
          <h4 title={`${label('engine')} ${engineName}`}>{label('result')}</h4>
          <TranslationLanguageMenu value={targetLanguage} label={label('targetLanguage')}
            languageName={languageName} onChange={changeTargetLanguage} />
        </div>
        {result && <button type="button" disabled={copyState === 'copying'} onClick={() => void copyResult()}>
          {label(copyState === 'copied' ? 'copied' : copyState === 'copying' ? 'copying' : 'copy')}
        </button>}
        {loading && <button type="button" onClick={cancel}>{label('cancel')}</button>}
        {(status === 'error' || status === 'cancelled') &&
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
            <TranslationContent value={result.value} t={t} />
          </>}
          {copyErrorKey && <p className="dsh-pdf-translation-copy-error" role="alert">{label(copyErrorKey)}</p>}
        </div>
      </section>
      <p className="dsh-pdf-translation-note">{label('selectionOnly')}</p>
    </section>
  </ScrollablePanel>
}
