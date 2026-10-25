import type { EngineConfiguration, EngineDescriptor, EngineJson } from '../modules/engines/index.js'

/** Only contributor-declared scalar fields are rendered; secrets stay in Host credential providers. */
export function EngineConfigurationFields({ descriptor, config, disabled, prefix, change, referenceHint }:
  { descriptor: EngineDescriptor; config: EngineConfiguration; disabled: boolean; prefix: string;
    change(key: string, value: EngineJson | undefined): void; referenceHint: string }) {
  return <>{descriptor.configurationFields?.map(field => {
    const id = `${prefix}-${field.key}`, value = config[field.key]
    return <div className="dsh-pdf-settings-field" key={field.key}>
      <label className="dsh-pdf-settings-label" htmlFor={id}>{field.label}{field.required ? ' *' : ''}</label>
      {field.type === 'boolean'
        ? <input id={id} type="checkbox" disabled={disabled} checked={value === true}
            onChange={event => change(field.key, event.target.checked)} />
        : <input className="dsh-pdf-settings-control" id={id} disabled={disabled}
            type={field.type === 'number' ? 'number' : 'text'} autoComplete="off" spellCheck={false}
            value={typeof value === 'string' || typeof value === 'number' ? value : ''}
            onChange={event => change(field.key, event.target.value === '' ? undefined
              : field.type === 'number' && Number.isFinite(Number(event.target.value)) ? Number(event.target.value) : event.target.value)} />}
      {field.type === 'secret-reference' && <small className="dsh-pdf-settings-hint">{referenceHint}</small>}
    </div>
  })}</>
}
