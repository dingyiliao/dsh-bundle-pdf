import { useEffect, useId, useRef, useState } from 'react'
import type { PdfDocumentIndexPolicy } from '../../../contracts/indexing.js'
import type { EngineCatalogSnapshot, EngineDescriptor } from '../../engines/index.js'
import type { ReaderIndexingControl } from '../controllers/use-reader-indexing.js'
import { ToolbarIcon } from './ToolbarIcon.js'

/** Document choices reference the shared engine directory; connection details stay in Settings. */
export function DocumentIndexSettings({ control, catalog, t }: {
  control: ReaderIndexingControl
  catalog?: EngineCatalogSnapshot
  t(key: string): string
}) {
  const configuration = control.configuration
  const [draft, setDraft] = useState<Partial<PdfDocumentIndexPolicy>>()
  const [failure, setFailure] = useState<{ message: string; defaults: boolean }>()
  const mounted = useRef(true)
  const attempt = useRef(0)
  const id = useId()
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
  const select = (field: 'embeddingEngine' | 'ocrEngine' | 'imageEngine', label: string, engines: readonly EngineDescriptor[]) => {
    if (!value) return null
    const available = engines.some(engine => engine.id === value[field])
    return <label className="dsh-pdf-index-setting" htmlFor={`${id}-${field}`}>
      <span>{t(label)}</span>
      <select id={`${id}-${field}`} value={value[field]} disabled={disabled}
        onChange={event => { void persist({ ...value, [field]: event.target.value }) }}>
        {!available && <option value={value[field]} disabled>{t('reader.indexing.engineMissing')}: {value[field]}</option>}
        {engines.map(engine => <option key={engine.id} value={engine.id}>{engine.name}</option>)}
      </select>
    </label>
  }
  const engines = catalog?.engines
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
        {select('embeddingEngine', 'reader.indexing.embeddingEngine', engines?.embedding ?? [])}
        <label className="dsh-pdf-index-toggle">
          <input type="checkbox" checked={value.indexScanPages} disabled={disabled}
            onChange={event => { void persist({ ...value, indexScanPages: event.target.checked }) }} />
          <span>{t('reader.indexing.scanPages')}</span>
        </label>
        {value.indexScanPages && select('ocrEngine', 'reader.indexing.ocrEngine', engines?.ocr.filter(engine =>
          engine.capabilities?.includes('ocr-text')) ?? [])}
        <label className="dsh-pdf-index-toggle">
          <input type="checkbox" checked={value.indexImageDescriptions} disabled={disabled}
            onChange={event => { void persist({ ...value, indexImageDescriptions: event.target.checked }) }} />
          <span>{t('reader.indexing.imageDescriptions')}</span>
        </label>
        {value.indexImageDescriptions && select('imageEngine', 'reader.indexing.imageEngine', engines?.image.filter(engine =>
          engine.capabilities?.includes('image-description')) ?? [])}
        <p className="dsh-pdf-muted" role="status" aria-live="polite">
          {t(configuration.saving ? 'reader.indexing.savingSettings' : failure ? 'reader.indexing.settingsNotSaved'
            : configuration.value.pending ? 'reader.indexing.settingsPending' : 'reader.indexing.settingsSaved')}
        </p>
        {configuration.value.pending && <p className="dsh-pdf-index-impact">
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
