import { useEffect, useRef, useState } from 'react'
import type { PdfDocumentIndexPolicy } from '../../../contracts/indexing.js'
import type { ReaderIndexingControl } from '../controllers/use-reader-indexing.js'
import { ToolbarIcon } from './ToolbarIcon.js'

/** Document-local content switches; engine choices and connections stay in Settings. */
export function DocumentIndexSettings({ control, t }: {
  control: ReaderIndexingControl
  t(key: string): string
}) {
  const configuration = control.configuration
  const [draft, setDraft] = useState<Partial<PdfDocumentIndexPolicy>>()
  const [failure, setFailure] = useState<{ message: string; defaults: boolean }>()
  const mounted = useRef(true)
  const attempt = useRef(0)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; attempt.current++ } }, [])
  const value = configuration ? { ...configuration.value.policy, ...draft } : undefined
  async function persist(policy?: PdfDocumentIndexPolicy) {
    if (!configuration || configuration.disabled || configuration.saving) return
    const sequence = ++attempt.current
    if (policy) setDraft(Object.fromEntries(Object.entries(policy).filter(([key, value]) =>
      configuration.value.policy[key as keyof PdfDocumentIndexPolicy] !== value)))
    setFailure(undefined)
    try {
      const accepted = policy ? await configuration.configure(policy) : await configuration.useDefaults()
      if (mounted.current && sequence === attempt.current) {
        if (accepted) setDraft(undefined)
        else setFailure({ defaults: !policy, message: t('reader.indexing.settingsNotSaved') })
      }
    } catch (error) {
      if (mounted.current && sequence === attempt.current) setFailure({ defaults: !policy,
        message: error instanceof Error ? error.message : String(error) })
    }
  }
  const disabled = !configuration || configuration.disabled || configuration.saving
  return <details className="dsh-pdf-search-indexing" aria-label={t('reader.indexing.title')} open>
    <summary><strong>{t('reader.indexing.title')}</strong><ToolbarIcon name="chevronDown" /></summary>
    <div className="dsh-pdf-index-settings-content">
      <div className="dsh-pdf-search-indexing-heading">
        <span className="dsh-pdf-muted" role="status">{control.statusLabel}</span>
        {control.enabled && <button type="button" disabled={control.disabled || !!draft || !!failure}
          onClick={control.onStart}>{control.label}</button>}
      </div>
      {configuration && value && <>
        <p className="dsh-pdf-muted">{t('reader.indexing.nativeAlways')}</p>
        <label className="dsh-pdf-index-toggle">
          <input type="checkbox" checked={value.indexScanPages} disabled={disabled}
            onChange={event => { void persist({ ...value, indexScanPages: event.target.checked }) }} />
          <span>{t('reader.indexing.scanPages')}</span>
        </label>
        <label className="dsh-pdf-index-toggle">
          <input type="checkbox" checked={value.indexImageDescriptions} disabled={disabled}
            onChange={event => { void persist({ ...value, indexImageDescriptions: event.target.checked }) }} />
          <span>{t('reader.indexing.imageDescriptions')}</span>
        </label>
        <p className="dsh-pdf-muted" role="status" aria-live="polite">
          {t(configuration.saving ? 'reader.indexing.savingSettings' : failure ? 'reader.indexing.settingsNotSaved'
            : control.enabled && configuration.value.pending ? 'reader.indexing.settingsPending' : 'reader.indexing.settingsSaved')}
        </p>
        {control.enabled && configuration.value.pending && <p className="dsh-pdf-index-impact">
          {t(`reader.indexing.impact.${configuration.value.impact}`)}
        </p>}
        {failure && <div className="dsh-pdf-index-settings-error" role="alert">
          <span>{failure.message}</span>
          <button type="button" disabled={disabled} onClick={() => { void persist(failure.defaults ? undefined : value) }}>
            {t('reader.indexing.retrySettings')}
          </button>
        </div>}
        <p className="dsh-pdf-muted">{t('reader.indexing.documentOnly')}</p>
        <div className="dsh-pdf-index-secondary-actions">
          <button type="button" disabled={disabled} onClick={() => { void persist() }}>{t('reader.indexing.useDefaults')}</button>
          {control.enabled && control.onRebuild && <button type="button" disabled={control.disabled || !!draft || !!failure}
            onClick={control.onRebuild}>{t('reader.indexing.forceRebuild')}</button>}
        </div>
      </>}
      <p className="dsh-pdf-muted">{t('reader.indexing.searchHint')}</p>
    </div>
  </details>
}
