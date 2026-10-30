import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { EngineConfiguration, EngineJson } from '../modules/engines/index.js'
import type { ModelOptionsStore } from '../adapters/client/remote/model-options.js'

export type VisionModelMode = 'follow' | 'specified'
export type VisionModelTextKey =
  | 'settings.visionModelSource' | 'settings.visionFollow' | 'settings.visionSpecified'
  | 'settings.visionModel' | 'settings.visionChooseModel' | 'settings.visionUnavailableModel'
  | 'settings.visionEffort' | 'settings.visionDefaultEffort' | 'settings.visionUnavailableEffort'
  | 'settings.visionLoading' | 'settings.visionCatalogError' | 'settings.visionPartialCatalog'
  | 'settings.visionEmptyCatalog' | 'settings.visionRefresh' | 'settings.visionFollowHelp'

type CatalogState = ReturnType<ModelOptionsStore['getSnapshot']>
const unavailable: CatalogState = { status: 'error' }
const selectionKey = (provider: string, model: string) => JSON.stringify([provider, model])

/** PDF-local model selection over DSH's read-only catalog; never changes the chat model. */
export function DshVisionModelSettings({ mode, config, options, disabled, prefix, t, error,
  changeMode, changeConfig }: {
  mode: VisionModelMode
  config: EngineConfiguration
  options?: ModelOptionsStore
  disabled: boolean
  prefix: string
  t(key: VisionModelTextKey): string
  error?: string
  changeMode(mode: VisionModelMode): void
  changeConfig(config: EngineConfiguration): void
}) {
  const activeOptions = mode === 'specified' ? options : undefined
  const subscribe = useCallback((listener: () => void) => activeOptions?.subscribe(listener) ?? (() => {}), [activeOptions])
  const getSnapshot = useCallback(() => activeOptions?.getSnapshot() ?? unavailable, [activeOptions])
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  useEffect(() => {
    if (mode === 'specified') void options?.refresh().catch(() => {})
  }, [mode, options])
  const groups = state.catalog?.groups ?? []
  const choices = groups.flatMap(group => group.models.map(model => ({ group, model,
    key: selectionKey(group.id, model.id) })))
  const provider = typeof config.provider === 'string' ? config.provider.trim() : ''
  const model = typeof config.model === 'string' ? config.model.trim() : ''
  const key = provider && model ? selectionKey(provider, model) : ''
  const current = choices.find(choice => choice.key === key)
  const effort = typeof config.reasoningEffort === 'string' ? config.reasoningEffort : ''
  const efforts = current?.model.reasoning?.efforts ?? []
  const missingEffort = effort && !efforts.some(choice => choice.id === effort)
  const refresh = () => { void options?.refresh().catch(() => {}) }
  const control = 'dsh-pdf-settings-control'
  return <>
    <div className="dsh-pdf-settings-field">
      <label className="dsh-pdf-settings-label" htmlFor={`${prefix}-source`}>{t('settings.visionModelSource')}</label>
      <select id={`${prefix}-source`} className={control} disabled={disabled} value={mode}
        onChange={event => changeMode(event.target.value === 'specified' ? 'specified' : 'follow')}>
        <option value="follow">{t('settings.visionFollow')}</option>
        <option value="specified">{t('settings.visionSpecified')}</option>
      </select>
      {mode === 'follow' && <small className="dsh-pdf-settings-hint">{t('settings.visionFollowHelp')}</small>}
    </div>
    {mode === 'specified' && <>
      <div className="dsh-pdf-settings-field">
        <div className="dsh-pdf-settings-field-heading">
          <label className="dsh-pdf-settings-label" htmlFor={`${prefix}-model`}>{t('settings.visionModel')}</label>
          <button type="button" className="dsh-pdf-settings-quiet" disabled={disabled || state.status === 'loading' || !options}
            onClick={refresh}>{t('settings.visionRefresh')}</button>
        </div>
        <select id={`${prefix}-model`} className={control} disabled={disabled || choices.length === 0}
          value={key} aria-invalid={Boolean(error)} aria-describedby={error ? `${prefix}-error` : undefined}
          onChange={event => {
            const selected = choices.find(choice => choice.key === event.target.value)
            if (!selected) return
            const next: Record<string, EngineJson> = { ...config, provider: selected.group.id, model: selected.model.id }
            delete next.reasoningEffort
            if (selected.model.reasoning?.defaultEffort) next.reasoningEffort = selected.model.reasoning.defaultEffort
            changeConfig(next)
          }}>
          {!current && <option value={key} disabled>{key
            ? `${t('settings.visionUnavailableModel')}: ${provider} / ${model}` : t('settings.visionChooseModel')}</option>}
          {groups.map(group => <optgroup key={group.id} label={group.name}>
            {group.models.map(item => <option key={item.id} value={selectionKey(group.id, item.id)}>{item.name}</option>)}
          </optgroup>)}
        </select>
        {(state.status === 'idle' || state.status === 'loading') && <small role="status" className="dsh-pdf-settings-hint">{t('settings.visionLoading')}</small>}
        {state.status === 'error' && <small role="status" className="dsh-pdf-settings-error">{t('settings.visionCatalogError')}</small>}
        {!!state.catalog?.failures.length && <small role="status" className="dsh-pdf-settings-hint">{t('settings.visionPartialCatalog')}</small>}
        {state.status === 'ready' && choices.length === 0 && <small role="status" className="dsh-pdf-settings-hint">{t('settings.visionEmptyCatalog')}</small>}
        {error && <small id={`${prefix}-error`} role="alert" className="dsh-pdf-settings-error">{error}</small>}
      </div>
      {(efforts.length > 0 || missingEffort) && <div className="dsh-pdf-settings-field">
        <label className="dsh-pdf-settings-label" htmlFor={`${prefix}-effort`}>{t('settings.visionEffort')}</label>
        <select id={`${prefix}-effort`} className={control} value={effort} disabled={disabled || !current}
          onChange={event => {
            const next = { ...config }
            if (event.target.value) next.reasoningEffort = event.target.value
            else delete next.reasoningEffort
            changeConfig(next)
          }}>
          <option value="">{t('settings.visionDefaultEffort')}</option>
          {missingEffort && <option value={effort} disabled>{t('settings.visionUnavailableEffort')}: {effort}</option>}
          {efforts.map(choice => <option key={choice.id} value={choice.id}>{choice.name}</option>)}
        </select>
      </div>}
    </>}
  </>
}
