import { useEffect, useId, useRef, useState } from 'react'
import type { PdfDocumentIndexPolicy } from '../../../contracts/indexing.js'
import type { ReaderIndexingControl } from '../controllers/use-reader-indexing.js'
import { ToolbarIcon } from './ToolbarIcon.js'

/** Document-local content switches; engine choices and connections stay in Settings. */
export function DocumentIndexSettings({ control, t }: {
  control: ReaderIndexingControl
  t(key: string): string
}) {
  const id = useId()
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
  const pendingSettings = configuration?.value.pending && (configuration.value.enabled || configuration.value.activeEnabled)
  return <details className="dsh-pdf-search-indexing" aria-label={t('reader.indexing.title')} open>
    <summary><strong>{t('reader.indexing.title')}</strong><ToolbarIcon name="chevronDown" /></summary>
    <div className="dsh-pdf-index-settings-content">
      {control.statusLabel !== t('reader.indexing.start') && (control.statusLabel !== control.label || control.disabled) &&
        <div className="dsh-pdf-search-indexing-heading" role="status">{control.statusLabel}</div>}
      {configuration && value && <>
        <div className="dsh-pdf-index-options" role="group" aria-label={t('reader.indexing.content')}>
          <label className="dsh-pdf-index-option">
            <input type="checkbox" checked={value.indexScanPages} disabled={disabled}
              aria-labelledby={`${id}-scan-title`} aria-describedby={`${id}-scan-help`}
              onChange={event => { void persist({ ...value, indexScanPages: event.target.checked }) }} />
            <span className="dsh-pdf-index-option-copy">
              <span id={`${id}-scan-title`} className="dsh-pdf-index-option-title">
                <span className="dsh-pdf-index-option-full-title">{t('reader.indexing.scanPages')}</span>
                <span className="dsh-pdf-index-option-short-title" aria-hidden="true">{t('reader.indexing.scanShort')}</span>
              </span>
              <span id={`${id}-scan-help`} className="dsh-pdf-index-option-help">{t('reader.indexing.scanHelp')}</span>
            </span>
          </label>
          <label className="dsh-pdf-index-option">
            <input type="checkbox" checked={value.indexImageDescriptions} disabled={disabled}
              aria-labelledby={`${id}-image-title`} aria-describedby={`${id}-image-help`}
              onChange={event => { void persist({ ...value, indexImageDescriptions: event.target.checked }) }} />
            <span className="dsh-pdf-index-option-copy">
              <span id={`${id}-image-title`} className="dsh-pdf-index-option-title">
                <span className="dsh-pdf-index-option-full-title">{t('reader.indexing.imageDescriptions')}</span>
                <span className="dsh-pdf-index-option-short-title" aria-hidden="true">{t('reader.indexing.imageShort')}</span>
              </span>
              <span id={`${id}-image-help`} className="dsh-pdf-index-option-help">{t('reader.indexing.imageHelp')}</span>
            </span>
          </label>
          <p className="dsh-pdf-index-native">{t('reader.indexing.nativeAlways')}</p>
        </div>
        <p className="dsh-pdf-index-save-status" role="status" aria-live="polite">
          {t(configuration.saving ? 'reader.indexing.savingSettings' : failure ? 'reader.indexing.settingsNotSaved'
            : pendingSettings ? 'reader.indexing.settingsPending' : 'reader.indexing.settingsSaved')}
        </p>
        {pendingSettings && <p className="dsh-pdf-index-impact">
          {t(`reader.indexing.impact.${configuration.value.impact}`)}
        </p>}
        {failure && <div className="dsh-pdf-index-settings-error" role="alert">
          <span>{failure.message}</span>
          <button type="button" disabled={disabled} onClick={() => { void persist(failure.defaults ? undefined : value) }}>
            {t('reader.indexing.retrySettings')}
          </button>
        </div>}
      </>}
      {control.enabled && <button type="button" className="dsh-pdf-index-primary-action"
        disabled={control.disabled || !!draft || !!failure} onClick={control.onStart}>{control.label}</button>}
      {configuration && value && <>
        <div className="dsh-pdf-index-secondary-actions">
          <button type="button" disabled={disabled} onClick={() => { void persist() }}>{t('reader.indexing.useDefaults')}</button>
          {control.onRebuild && configuration.value.enabled && <button type="button" disabled={(control.updateDisabled ?? control.disabled) || !!draft || !!failure}
            onClick={control.onRebuild}>{t('reader.indexing.rebuild')}</button>}
        </div>
      </>}
      <details className="dsh-pdf-index-help">
        <summary>{t('reader.indexing.details')}<ToolbarIcon name="chevronDown" /></summary>
        {control.onUpdate && <button type="button" disabled={(control.updateDisabled ?? control.disabled) || !!draft || !!failure}
          onClick={control.onUpdate}>{t('reader.indexing.applyUpdate')}</button>}
        {configuration && <div className="dsh-pdf-index-compact-help">
          <p><strong>{t('reader.indexing.scanPages')}</strong> · {t('reader.indexing.scanHelp')}</p>
          <p><strong>{t('reader.indexing.imageDescriptions')}</strong> · {t('reader.indexing.imageHelp')}</p>
        </div>}
        <p>{t('reader.indexing.documentOnly')}</p>
        <p>{t('reader.indexing.searchHint')}</p>
      </details>
    </div>
  </details>
}
