import React, { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { ConfigForm as DshConfigForm, ConfigFormSnapshot as DshConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { defaultSettings, effectiveTranslationEngine, type PdfSettings } from '../shared/contracts.js'
import { defaultExplanationPromptTemplate, explanationTemplateIssue,
  MAX_EXPLANATION_INSTRUCTION_LENGTH } from '../shared/explanation-template.js'
import { engineBinding, validateEngineConfiguration, type EngineCatalogSnapshot, type EngineConfigurations,
  type EngineKind, type EngineDescriptor, type EngineJson } from '../modules/engines/index.js'
import { EngineConfigurationFields } from './EngineConfigurationFields.js'

// `mode` was removed from DSH's snapshot. Keep only the stable public fields so
// the editor works with both older and newer Host connections.
export type ConfigFormSnapshot = Pick<DshConfigFormSnapshot<PdfSettings>,
  'status' | 'value' | 'base' | 'user' | 'revision' | 'writable'>
/** The PDF settings card uses only these operations of DSH's public form. */
export type ConfigForm = Pick<DshConfigForm<PdfSettings>, 'subscribe' | 'mutate'> & {
  getSnapshot(): ConfigFormSnapshot
}
export interface SettingsProps {
  form: ConfigForm
  t: (key: string) => string
  translationEngines: readonly { id: string; label: string }[]
  engineCatalog?: EngineCatalogSnapshot
}

export const settingsLocales = {
  zh: {
    'settings.title': 'PDF',
    'settings.loading': '正在加载 PDF 设置…',
    'settings.unavailable': '当前连接无法读取或保存 PDF 设置。已编辑的内容会保留在这里。',
    'settings.readOnly': '当前设置为只读。',
    'settings.engines': 'AI 引擎',
    'settings.enginesHelp': '按需调用所选引擎；模型或远程引擎会接收待处理的文字或图片。',
    'settings.ocrEngine': 'OCR 引擎',
    'settings.imageEngine': '图像理解引擎',
    'settings.embeddingEngine': '语义检索引擎',
    'settings.embeddingHelp': '按需为文档文字建立语义索引。默认关闭，仍可关键词检索；远程引擎会接收检索范围内的文字。',
    'settings.imageHelp': '理解图片内容；解释模式的最终回答仍由当前会话模型完成。',
    'settings.engineConfigurations': '引擎配置',
    'settings.engineConfigInvalid': '请检查所选引擎的配置。',
    'settings.engineReference': '填写此引擎插件管理的凭据引用，不要输入 API key 或其他密钥。',
    'settings.engineLocal': '本地',
    'settings.engineRemote': '模型 / 远程',
    'settings.engineMissing': '引擎未加载，已保留选择，不会自动切换。',
    'settings.invalidEngine': '请选择已安装的引擎。',
    'settings.ocrHelp': '从图片或扫描页提取文字。',
    'settings.navigation': '阅读与跳转',
    'settings.unknownEngine': '当前引擎未加载',
    'settings.translationEngine': '翻译引擎',
    'settings.translationDshModel': 'DSH 模型 · 文字翻译',
    'settings.translationHelp': '翻译选中文字，不加入会话历史。',
    'settings.translationTimeoutMs': '翻译超时（毫秒）',
    'settings.translationTimeoutHelp': '最长等待时间：1000–600000 毫秒。',
    'settings.historyCapacity': '跳转历史容量',
    'settings.historyHelp': '每个 PDF 标签最多保留多少个可返回的位置。',
    'settings.explanationPrompts': '解释模式提示词',
    'settings.explanationPromptsHelp': '留空使用默认提示词。选段、问题和来源会自动附上，无需占位符。',
    'settings.explanationGeneralInstruction': '总体要求',
    'settings.explanationGeneralDefault': '例如：先解释概念，再逐项回答问题。',
    'settings.explanationTextInstruction': '文字选段',
    'settings.explanationTextDefault': '例如：解释公式推导，并指出前提条件。',
    'settings.explanationImageInstruction': '图片区域',
    'settings.explanationImageDefault': '例如：先描述图表元素，再解释它们的关系。',
    'settings.explanationPromptTemplate': '旧版完整模板',
    'settings.legacyPromptNotice': '旧版完整模板仍在生效。可以保留它；切换后将使用下方分项提示词，空白项采用默认行为。',
    'settings.useSplitPrompts': '改用分项提示词',
    'settings.invalidTemplate': '模板无效：请保留且仅使用一次 {{items}}，只使用列出的占位符，内容不超过 8192 字符。',
    'settings.invalidInstruction': '每个提示词最多 2000 个字符。',
    'settings.unsaved': '有未保存的修改',
    'settings.current': '设置已同步',
    'settings.save': '保存设置',
    'settings.saving': '正在保存…',
    'settings.saved': '设置已保存',
    'settings.reset': '恢复默认',
    'settings.discard': '撤销修改',
    'settings.resetHint': '默认值已填入，保存后生效。',
    'settings.conflict': '设置已在其他地方更新。你的修改已保留，请先选择如何处理。',
    'settings.latest': '载入最新设置',
    'settings.keep': '保留我的修改',
    'settings.keepHint': '保留你修改过的字段，并采用其他字段的最新值；再次保存后生效。',
    'settings.remoteChanges': '查看其他地方更新的字段',
    'settings.refused': '设置未被接受。请检查字段或重新载入最新设置。',
    'settings.failed': '保存失败：',
    'settings.invalidNumber': '请输入大于 0 的整数。',
    'settings.invalidTimeout': '请输入 1000 到 600000 之间的整数。',
    'settings.invalidTranslationEngine': '请选择一个可用的翻译引擎。',
    'settings.validation': '请先修正标出的设置。',
  },
  en: {
    'settings.title': 'PDF',
    'settings.loading': 'Loading PDF settings…',
    'settings.unavailable': 'PDF settings are unavailable on this connection. Your edits are retained here.',
    'settings.readOnly': 'These settings are read-only.',
    'settings.engines': 'AI engines',
    'settings.enginesHelp': 'Engines run on demand. Model or remote engines receive the text or images being processed.',
    'settings.ocrEngine': 'OCR engine',
    'settings.imageEngine': 'Image understanding engine',
    'settings.embeddingEngine': 'Semantic search engine',
    'settings.embeddingHelp': 'Indexes document text on demand. Off by default; keyword search remains available. Remote engines receive text from the search scope.',
    'settings.imageHelp': 'Interprets images. The current chat model still provides the final explanation.',
    'settings.engineConfigurations': 'Engine configuration',
    'settings.engineConfigInvalid': 'Check the selected engine configuration.',
    'settings.engineReference': 'Enter a credential reference managed by this engine plugin, not an API key or another secret.',
    'settings.engineLocal': 'Local',
    'settings.engineRemote': 'Model / remote',
    'settings.engineMissing': 'Engine not loaded. Your choice is retained; no automatic fallback occurs.',
    'settings.invalidEngine': 'Choose an installed engine.',
    'settings.ocrHelp': 'Extracts text from images or scanned pages.',
    'settings.navigation': 'Reading and navigation',
    'settings.unknownEngine': 'Current engine is not loaded',
    'settings.translationEngine': 'Translation engine',
    'settings.translationDshModel': 'DSH model · Text translation',
    'settings.translationHelp': 'Translates selected text without adding it to conversation history.',
    'settings.translationTimeoutMs': 'Translation timeout (milliseconds)',
    'settings.translationTimeoutHelp': 'Maximum wait: 1000–600000 milliseconds.',
    'settings.historyCapacity': 'Navigation history capacity',
    'settings.historyHelp': 'Maximum number of return locations retained for each PDF tab.',
    'settings.explanationPrompts': 'Explanation prompts',
    'settings.explanationPromptsHelp': 'Leave blank to use defaults. Excerpts, questions and sources are attached automatically—no placeholders needed.',
    'settings.explanationGeneralInstruction': 'Overall guidance',
    'settings.explanationGeneralDefault': 'For example: explain the concepts, then answer each question.',
    'settings.explanationTextInstruction': 'Text passages',
    'settings.explanationTextDefault': 'For example: walk through a derivation and name its assumptions.',
    'settings.explanationImageInstruction': 'Image regions',
    'settings.explanationImageDefault': 'For example: describe the chart elements before interpreting them.',
    'settings.explanationPromptTemplate': 'Legacy full template',
    'settings.legacyPromptNotice': 'A legacy full template is still active. Keep it, or switch to the fields below; blank fields use built-in behavior.',
    'settings.useSplitPrompts': 'Use separate prompts',
    'settings.invalidTemplate': 'Invalid template: use {{items}} exactly once, only the listed placeholders, and at most 8192 characters.',
    'settings.invalidInstruction': 'Each prompt can contain at most 2000 characters.',
    'settings.unsaved': 'Unsaved changes',
    'settings.current': 'Settings are up to date',
    'settings.save': 'Save settings',
    'settings.saving': 'Saving…',
    'settings.saved': 'Settings saved',
    'settings.reset': 'Restore defaults',
    'settings.discard': 'Discard changes',
    'settings.resetHint': 'Defaults are staged. Save to apply them.',
    'settings.conflict': 'Settings changed elsewhere. Your edits are retained; choose how to continue.',
    'settings.latest': 'Load latest settings',
    'settings.keep': 'Keep my changes',
    'settings.keepHint': 'Keep the fields you edited and use the latest values for other fields. Save again to apply.',
    'settings.remoteChanges': 'Show fields changed elsewhere',
    'settings.refused': 'Settings were not accepted. Check the fields or load the latest settings.',
    'settings.failed': 'Could not save: ',
    'settings.invalidNumber': 'Enter a positive integer.',
    'settings.invalidTimeout': 'Enter an integer from 1000 to 600000.',
    'settings.invalidTranslationEngine': 'Choose an available translation engine.',
    'settings.validation': 'Correct the highlighted settings first.',
  },
} as const

const promptFields = ['explanationGeneralInstruction', 'explanationTextInstruction', 'explanationImageInstruction'] as const
const fields = ['ocrEngine', 'imageEngine', 'embeddingEngine', 'engineConfigurations', 'translationEngine', 'translationTimeoutMs', 'historyCapacity', ...promptFields,
  'explanationPromptTemplate'] as const
type Field = typeof fields[number]
const fieldHints: Partial<Record<Field, keyof typeof settingsLocales.zh>> = {
  ocrEngine: 'settings.ocrHelp', imageEngine: 'settings.imageHelp', translationEngine: 'settings.translationHelp',
  embeddingEngine: 'settings.embeddingHelp',
  translationTimeoutMs: 'settings.translationTimeoutHelp', historyCapacity: 'settings.historyHelp',
}
type Draft = Record<Field, string>
interface Editor { source: Draft; draft: Draft; revision: number | undefined; conflict: boolean; unsets: Field[] }
function toDraft(settings: PdfSettings): Draft {
  const complete = { ...defaultSettings, ...settings }
  complete.translationEngine = effectiveTranslationEngine(complete.translationEngine)
  return Object.fromEntries(fields.map(field => [field, field === 'engineConfigurations'
    ? JSON.stringify(complete.engineConfigurations ?? {}) : String(complete[field])])) as Draft
}
function isDirty(editor: Editor | null): boolean {
  return editor !== null && (editor.unsets.length > 0 || fields.some(field => editor.source[field] !== editor.draft[field]))
}
function acceptedEditor(snapshot: ConfigFormSnapshot): Editor | null {
  if (snapshot.value === undefined) return null
  const draft = toDraft(snapshot.value)
  return { source: draft, draft: { ...draft }, revision: snapshot.revision, conflict: false, unsets: [] }
}

/** Settings card with an explicit save boundary and revision-fenced local edits. */
export function Settings({ form, t, translationEngines, engineCatalog }: SettingsProps) {
  const tr = useCallback((key: keyof typeof settingsLocales.zh): string => {
    const value = t(key)
    return value && value !== key ? value : settingsLocales.zh[key]
  }, [t])
  const snapshot = useSyncExternalStore(
    useCallback(listener => form.subscribe(listener), [form]),
    useCallback(() => form.getSnapshot(), [form]),
    useCallback(() => form.getSnapshot(), [form]),
  )
  const [editor, setEditor] = useState<Editor | null>(() => acceptedEditor(snapshot))
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const formIdentity = useRef(form)
  const mounted = useRef(true)
  const id = useId()

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (formIdentity.current !== form) {
      formIdentity.current = form
      setEditor(acceptedEditor(snapshot)); setError(''); setNotice(''); setSubmitted(false); setSaving(false)
      return
    }
    if (snapshot.status !== 'ready' || snapshot.value === undefined) return
    setEditor(current => {
      if (current === null || !isDirty(current)) return acceptedEditor(snapshot)
      if (snapshot.revision !== current.revision) return { ...current, conflict: true }
      return current
    })
  }, [form, snapshot])

  const dirty = isDirty(editor)
  useEffect(() => {
    if (!dirty) return
    const onUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [dirty])

  const disabled = saving || snapshot.status !== 'ready' || !snapshot.writable || snapshot.revision === undefined
  const validation: Partial<Record<Field, string>> = {}
  const configurations: EngineConfigurations = editor ? JSON.parse(editor.draft.engineConfigurations) : {}
  const descriptors = (kind: EngineKind): readonly EngineDescriptor[] => engineCatalog?.engines[kind]
    ?? (kind === 'translation' ? translationEngines.filter(engine => engine.id !== 'none').map(engine => ({
      id: engine.id, name: engine.label, version: '1', execution: 'remote' as const,
    })) : [])
  if (editor) {
    const sourceConfigurations: EngineConfigurations = JSON.parse(editor.source.engineConfigurations)
    for (const field of ['translationTimeoutMs', 'historyCapacity'] as const) {
      const value = Number(editor.draft[field])
      if (!/^\d+$/.test(editor.draft[field]) || !Number.isSafeInteger(value) || value < 1) validation[field] = tr('settings.invalidNumber')
      if (field === 'translationTimeoutMs' && (value < 1000 || value > 600000)) {
        validation[field] = tr('settings.invalidTimeout')
      }
    }
    for (const [kind, field] of [['ocr', 'ocrEngine'], ['image', 'imageEngine'], ['translation', 'translationEngine'], ['embedding', 'embeddingEngine']] as const) {
      const touched = editor.draft[field] !== editor.source[field]
        || JSON.stringify(configurations[kind]?.[editor.draft[field]])
          !== JSON.stringify(sourceConfigurations[kind]?.[editor.source[field]])
      const descriptor = descriptors(kind).find(engine => engine.id === editor.draft[field])
      if (!descriptor && touched) validation[field] = tr('settings.invalidEngine')
      if (descriptor && touched) {
        try { validateEngineConfiguration(descriptor, engineBinding(kind, descriptor.id, configurations).config) }
        catch { validation.engineConfigurations = tr('settings.engineConfigInvalid') }
      }
    }
    for (const field of promptFields) {
      if (editor.draft[field].length > MAX_EXPLANATION_INSTRUCTION_LENGTH) {
        validation[field] = tr('settings.invalidInstruction')
      }
    }
    if (explanationTemplateIssue(editor.draft.explanationPromptTemplate)) {
      validation.explanationPromptTemplate = tr('settings.invalidTemplate')
    }
  }

  const legacyPromptActive = !!editor && editor.draft.explanationPromptTemplate !== defaultExplanationPromptTemplate
    && promptFields.every(field => !editor.draft[field].trim())

  function edit(field: Field, value: string) {
    const splitPromptEdited = promptFields.some(prompt => prompt === field)
    setEditor(current => current && ({ ...current,
      draft: { ...current.draft, [field]: value,
        ...(splitPromptEdited && current.source.explanationPromptTemplate !== defaultExplanationPromptTemplate
          ? { explanationPromptTemplate: defaultExplanationPromptTemplate } : {}) },
      unsets: current.unsets.filter(key => key !== field
        && (!splitPromptEdited || key !== 'explanationPromptTemplate')) }))
    setNotice(''); setError('')
  }
  function useSplitPrompts() {
    setEditor(current => current && ({ ...current,
      draft: { ...current.draft, explanationPromptTemplate: defaultExplanationPromptTemplate },
      unsets: current.unsets.filter(key => key !== 'explanationPromptTemplate') }))
    setNotice(''); setError('')
  }
  function loadLatest() {
    const latest = form.getSnapshot()
    if (latest.status !== 'ready') return
    setEditor(acceptedEditor(latest)); setError(''); setNotice(''); setSubmitted(false)
  }
  function keepChanges() {
    const latest = form.getSnapshot()
    if (latest.status !== 'ready' || latest.value === undefined) return
    const source = toDraft(latest.value)
    const base = latest.base && typeof latest.base === 'object' ? latest.base as Partial<PdfSettings> : {}
    const defaults = toDraft({ ...defaultSettings, ...base })
    setEditor(current => current && ({
      source, revision: latest.revision, conflict: false, unsets: current.unsets,
      draft: Object.fromEntries(fields.map(field => [field, current.unsets.includes(field) ? defaults[field] : current.draft[field] !== current.source[field] ? current.draft[field] : source[field]])) as Draft,
    }))
    setError(''); setNotice(tr('settings.keepHint'))
  }
  function restoreDefaults() {
    const base = snapshot.base && typeof snapshot.base === 'object' ? snapshot.base as Partial<PdfSettings> : {}
    const defaults = toDraft({ ...defaultSettings, ...base })
    setEditor(current => current && ({ ...current, draft: defaults, unsets: [...fields] }))
    setError(''); setNotice(tr('settings.resetHint')); setSubmitted(false)
  }
  async function save() {
    if (!editor || disabled || !dirty || editor.conflict) return
    setSubmitted(true)
    if (Object.keys(validation).length > 0) { setError(tr('settings.validation')); return }
    const latest = form.getSnapshot()
    if (latest.revision !== editor.revision) { setEditor(current => current && ({ ...current, conflict: true })); return }
    const ops = fields.filter(field => editor.unsets.includes(field) || editor.draft[field] !== editor.source[field]).map(field =>
      editor.unsets.includes(field) ? { op: 'unset' as const, path: [field] } : {
        op: 'set' as const, path: [field],
        value: field === 'translationTimeoutMs' || field === 'historyCapacity'
          ? Number(editor.draft[field]) : field === 'engineConfigurations'
            ? JSON.parse(editor.draft[field]) : editor.draft[field].trim(),
      })
    const owner = form
    setSaving(true); setError(''); setNotice('')
    try {
      const accepted = await owner.mutate(ops, editor.revision)
      if (!mounted.current || formIdentity.current !== owner) return
      const current = owner.getSnapshot()
      if (accepted) {
        setEditor(acceptedEditor(current)); setSubmitted(false); setNotice(tr('settings.saved'))
      } else {
        setEditor(previous => previous && ({ ...previous, conflict: current.revision !== previous.revision }))
        setError(tr('settings.refused'))
      }
    } catch (cause) {
      if (mounted.current && formIdentity.current === owner) setError(`${tr('settings.failed')}${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      if (mounted.current && formIdentity.current === owner) setSaving(false)
    }
  }

  const fieldRow = (field: Field, control: React.ReactNode, status?: React.ReactNode) => <div key={field} className="dsh-pdf-settings-field">
    <div className="dsh-pdf-settings-field-heading">
      <label htmlFor={`${id}-${field}`} className="dsh-pdf-settings-label">{tr(`settings.${field}`)}</label>
      {status}
    </div>
    {control}
    {fieldHints[field] && <small id={`${id}-${field}-hint`} className="dsh-pdf-settings-hint">{tr(fieldHints[field])}</small>}
    {submitted && validation[field] && <small id={`${id}-${field}-error`} className="dsh-pdf-settings-error" role="alert">{validation[field]}</small>}
  </div>
  const attributes = (field: Field) => ({
    id: `${id}-${field}`, disabled,
    'aria-invalid': submitted && Boolean(validation[field]),
    'aria-describedby': `${id}-${fieldHints[field] ? `${field}-hint` : 'prompts-hint'}${submitted && validation[field] ? ` ${id}-${field}-error` : ''}`,
    className: 'dsh-pdf-settings-control',
  })

  const engineFields = (kind: EngineKind, field: 'ocrEngine' | 'imageEngine' | 'translationEngine' | 'embeddingEngine') => {
    if (!editor) return null
    const engines = descriptors(kind).filter(engine => kind === 'embedding' || engine.execution !== 'disabled')
    const selected = engines.find(engine => engine.id === editor.draft[field])
    return <div className="dsh-pdf-settings-engine">
      {fieldRow(field, <select {...attributes(field)} value={editor.draft[field]}
        onChange={event => edit(field, event.target.value)}>
        {!selected && <option value={editor.draft[field]} disabled>{tr('settings.unknownEngine')}: {editor.draft[field]}</option>}
        {engines.map(engine => <option key={engine.id} value={engine.id}>{engine.id === 'dsh-model'
          ? tr('settings.translationDshModel') : engine.name}</option>)}
      </select>, selected && <small className="dsh-pdf-settings-engine-kind">{tr(selected.execution === 'local' ? 'settings.engineLocal' : 'settings.engineRemote')}</small>)}
      {!selected ? <p className="dsh-pdf-settings-hint" role="status">{tr('settings.engineMissing')}</p>
        : <div className="dsh-pdf-settings-engine-options">
          <EngineConfigurationFields descriptor={selected} config={configurations[kind]?.[selected.id] ?? {}}
            prefix={`${id}-${kind}`} disabled={disabled} referenceHint={tr('settings.engineReference')}
            change={(key: string, value: EngineJson | undefined) => {
              const next = structuredClone(configurations), config = { ...next[kind]?.[selected.id] }
              if (value === undefined) delete config[key]; else config[key] = value
              next[kind] = { ...next[kind], [selected.id]: config }
              edit('engineConfigurations', JSON.stringify(next))
            }} />
        </div>}
    </div>
  }

  return <section aria-labelledby={`${id}-title`} className="dsh-pdf-settings">
    <header className="dsh-pdf-settings-header">
      <h2 id={`${id}-title`}>{tr('settings.title')}</h2>
    </header>
    {snapshot.status === 'loading' && <p role="status" className="dsh-pdf-settings-status">{tr('settings.loading')}</p>}
    {snapshot.status === 'unavailable' && <p role="status" className="dsh-pdf-settings-status">{tr('settings.unavailable')}</p>}
    {snapshot.status === 'ready' && !snapshot.writable && <p role="status" className="dsh-pdf-settings-status">{tr('settings.readOnly')}</p>}
    {editor && <form onSubmit={event => { event.preventDefault(); void save() }} className="dsh-pdf-settings-form">
      {editor.conflict && <div role="alert" className="dsh-pdf-settings-notice">
        <p>{tr('settings.conflict')}</p>
        {snapshot.value && <details><summary>{tr('settings.remoteChanges')}</summary><ul>
          {fields.filter(field => String(snapshot.value![field]) !== editor.source[field]).map(field => <li key={field}>{tr(`settings.${field}`)}: {editor.source[field]} → {String(snapshot.value![field])}</li>)}
        </ul></details>}
        <div className="dsh-pdf-settings-notice-actions"><button type="button" disabled={disabled} className="dsh-pdf-settings-secondary" onClick={loadLatest}>{tr('settings.latest')}</button><button type="button" disabled={disabled} className="dsh-pdf-settings-secondary" onClick={keepChanges}>{tr('settings.keep')}</button></div>
        <small className="dsh-pdf-settings-hint">{tr('settings.keepHint')}</small>
      </div>}
      <section className="dsh-pdf-settings-group" aria-labelledby={`${id}-engines-title`}>
        <h3 id={`${id}-engines-title`}>{tr('settings.engines')}</h3>
        <p className="dsh-pdf-settings-hint">{tr('settings.enginesHelp')}</p>
        {engineFields('ocr', 'ocrEngine')}
        {engineFields('image', 'imageEngine')}
        {engineFields('translation', 'translationEngine')}
        {engineFields('embedding', 'embeddingEngine')}
        {submitted && validation.engineConfigurations && <p role="alert" className="dsh-pdf-settings-error">{validation.engineConfigurations}</p>}
        {fieldRow('translationTimeoutMs', <input {...attributes('translationTimeoutMs')} type="number" min={1000} max={600000} step={1} value={editor.draft.translationTimeoutMs} onChange={event => edit('translationTimeoutMs', event.target.value)} />)}
      </section>
      <section className="dsh-pdf-settings-group" aria-labelledby={`${id}-navigation-title`}>
        <h3 id={`${id}-navigation-title`}>{tr('settings.navigation')}</h3>
        {fieldRow('historyCapacity', <input {...attributes('historyCapacity')} type="number" min={1} step={1} value={editor.draft.historyCapacity} onChange={event => edit('historyCapacity', event.target.value)} />)}
      </section>
      <section className="dsh-pdf-settings-group" aria-labelledby={`${id}-prompts-title`}>
        <h3 id={`${id}-prompts-title`}>{tr('settings.explanationPrompts')}</h3>
        <p id={`${id}-prompts-hint`} className="dsh-pdf-settings-hint">{tr('settings.explanationPromptsHelp')}</p>
        {legacyPromptActive && <div className="dsh-pdf-settings-notice" role="status">
          <p>{tr('settings.legacyPromptNotice')}</p>
          <button type="button" disabled={disabled} className="dsh-pdf-settings-secondary" onClick={useSplitPrompts}>{tr('settings.useSplitPrompts')}</button>
        </div>}
        {promptFields.map((field, index) => fieldRow(field,
          <textarea {...attributes(field)} rows={index === 0 ? 3 : 2}
            maxLength={MAX_EXPLANATION_INSTRUCTION_LENGTH}
            placeholder={tr((['settings.explanationGeneralDefault', 'settings.explanationTextDefault',
              'settings.explanationImageDefault'] as const)[index])}
            value={editor.draft[field]} onChange={event => edit(field, event.target.value)} />))}
      </section>
      {error && <p role="alert" className="dsh-pdf-settings-error dsh-pdf-settings-form-error">{error}</p>}
      <div className="dsh-pdf-settings-footer">
        <div className="dsh-pdf-settings-footer-actions">
          <button type="button" disabled={disabled} className="dsh-pdf-settings-quiet" onClick={restoreDefaults}>{tr('settings.reset')}</button>
          <button type="button" disabled={disabled || !dirty} className="dsh-pdf-settings-quiet" onClick={loadLatest}>{tr('settings.discard')}</button>
        </div>
        <span aria-live="polite" className="dsh-pdf-settings-save-status">{notice || tr(dirty ? 'settings.unsaved' : 'settings.current')}</span>
        <button type="submit" disabled={disabled || !dirty || editor.conflict} className="dsh-pdf-settings-save">{tr(saving ? 'settings.saving' : 'settings.save')}</button>
      </div>
    </form>}
  </section>
}

export default Settings
