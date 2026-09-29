import React, { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { defaultSettings, type PdfSettings } from '../shared/contracts.js'

/** Structural view of DSH's public ConfigForm; no runtime Client package import. */
export interface ConfigFormSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value: PdfSettings | undefined
  base: unknown
  user: unknown
  revision: number | undefined
  writable: boolean
  mode: 'host' | 'memory'
}
export interface ConfigForm {
  getSnapshot(): ConfigFormSnapshot
  subscribe(listener: () => void): () => void
  mutate(ops: readonly ({ op: 'set'; path: string[]; value: string | number } | { op: 'unset'; path: string[] })[], expectedRevision?: number): Promise<boolean>
}
export interface SettingsProps {
  form: ConfigForm
  t: (key: string) => string
  engines: readonly { id: string; label: string }[]
}

export const settingsLocales = {
  zh: {
    'settings.title': 'PDF',
    'settings.description': '配置扫描件文字识别、标注和阅读跳转。修改后手动保存。',
    'settings.loading': '正在加载 PDF 设置…',
    'settings.unavailable': '当前连接无法读取或保存 PDF 设置。已编辑的内容会保留在这里。',
    'settings.memory': '当前连接仅支持临时设置，无法保存到 Host。',
    'settings.readOnly': '当前设置为只读。',
    'settings.ocrEngine': 'OCR 引擎',
    'settings.ocrNone': 'NoneOCR · 关闭文字识别',
    'settings.ocrLocal': 'LocalOCR · 本地文字识别',
    'settings.ocrHelp': 'OCR 只在你请求识别时运行。选择 NoneOCR 后仍可阅读页面图像。',
    'settings.unknownEngine': '当前引擎未加载',
    'settings.ocrLanguages': '识别语言',
    'settings.languageHelp': '使用所选引擎的语言代码。LocalOCR 可用 eng、chi_sim，以 + 分隔。',
    'settings.ocrTimeoutMs': '识别超时（毫秒）',
    'settings.timeoutHelp': '单次 OCR 请求的最长等待时间。',
    'settings.defaultColor': '默认标注颜色',
    'settings.colorHelp': '仅用于之后新增的高亮、下划线等标注。',
    'settings.historyCapacity': '跳转历史容量',
    'settings.historyHelp': '每个 PDF 标签最多保留多少个可返回的位置。',
    'settings.maxFileBytes': 'PDF 大小上限（字节）',
    'settings.fileHelp': '超过此大小的文件会提示无法打开，避免占用过多内存。',
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
    'settings.invalidLanguage': '请输入识别语言。',
    'settings.invalidColor': '请输入六位十六进制颜色，例如 #ffff00。',
    'settings.invalidEngine': '请选择一个可用的 OCR 引擎。',
    'settings.validation': '请先修正标出的设置。',
  },
  en: {
    'settings.title': 'PDF',
    'settings.description': 'Configure scanned text recognition, annotations, and reading navigation. Save changes manually.',
    'settings.loading': 'Loading PDF settings…',
    'settings.unavailable': 'PDF settings are unavailable on this connection. Your edits are retained here.',
    'settings.memory': 'This connection only supports temporary settings and cannot save them to the Host.',
    'settings.readOnly': 'These settings are read-only.',
    'settings.ocrEngine': 'OCR engine',
    'settings.ocrNone': 'NoneOCR · Recognition disabled',
    'settings.ocrLocal': 'LocalOCR · On-device recognition',
    'settings.ocrHelp': 'OCR runs only when requested. With NoneOCR, page images remain readable.',
    'settings.unknownEngine': 'Current engine is not loaded',
    'settings.ocrLanguages': 'Recognition languages',
    'settings.languageHelp': 'Use the selected engine’s language codes. LocalOCR supports eng and chi_sim, separated by +.',
    'settings.ocrTimeoutMs': 'Recognition timeout (milliseconds)',
    'settings.timeoutHelp': 'Maximum waiting time for one OCR request.',
    'settings.defaultColor': 'Default annotation color',
    'settings.colorHelp': 'Applies to highlights, underlines, and other annotations created later.',
    'settings.historyCapacity': 'Navigation history capacity',
    'settings.historyHelp': 'Maximum number of return locations retained for each PDF tab.',
    'settings.maxFileBytes': 'PDF size limit (bytes)',
    'settings.fileHelp': 'Larger files are refused to limit memory use.',
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
    'settings.invalidLanguage': 'Enter a recognition language.',
    'settings.invalidColor': 'Enter a six-digit hexadecimal color, such as #ffff00.',
    'settings.invalidEngine': 'Choose an available OCR engine.',
    'settings.validation': 'Correct the highlighted settings first.',
  },
} as const

const fields = ['ocrEngine', 'ocrLanguages', 'ocrTimeoutMs', 'defaultColor', 'historyCapacity', 'maxFileBytes'] as const
type Field = typeof fields[number]
type Draft = Record<Field, string>
interface Editor { source: Draft; draft: Draft; revision: number | undefined; conflict: boolean; unsets: Field[] }
const inputStyle: CSSProperties = {
  boxSizing: 'border-box', width: '100%', minHeight: 34, padding: '6px 9px', font: 'inherit',
  border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6,
  color: 'inherit', background: 'var(--dsw-alias-bg-layer-1)',
}
const buttonStyle: CSSProperties = { ...inputStyle, width: 'auto', cursor: 'pointer', padding: '6px 12px' }
const noticeStyle: CSSProperties = { padding: 12, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, lineHeight: 1.6 }

function toDraft(settings: PdfSettings): Draft {
  return Object.fromEntries(fields.map(field => [field, String(settings[field])])) as Draft
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
export function Settings({ form, t, engines }: SettingsProps) {
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

  const disabled = saving || snapshot.status !== 'ready' || !snapshot.writable || snapshot.mode !== 'host' || snapshot.revision === undefined
  const available = [{ id: 'none', label: tr('settings.ocrNone') }, ...engines.filter(engine => engine.id !== 'none').map(engine => ({
    id: engine.id, label: engine.id === 'local' ? tr('settings.ocrLocal') : engine.label,
  }))].filter((engine, index, all) => all.findIndex(other => other.id === engine.id) === index)
  const validation: Partial<Record<Field, string>> = {}
  if (editor) {
    for (const field of ['ocrTimeoutMs', 'historyCapacity', 'maxFileBytes'] as const) {
      const value = Number(editor.draft[field])
      if (!/^\d+$/.test(editor.draft[field]) || !Number.isSafeInteger(value) || value < 1) validation[field] = tr('settings.invalidNumber')
    }
    if (!editor.draft.ocrLanguages.trim()) validation.ocrLanguages = tr('settings.invalidLanguage')
    if (!/^#[0-9a-f]{6}$/i.test(editor.draft.defaultColor)) validation.defaultColor = tr('settings.invalidColor')
    if (!available.some(engine => engine.id === editor.draft.ocrEngine)) validation.ocrEngine = tr('settings.invalidEngine')
  }

  function edit(field: Field, value: string) {
    setEditor(current => current && ({ ...current, draft: { ...current.draft, [field]: value }, unsets: current.unsets.filter(key => key !== field) }))
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
        value: field === 'ocrTimeoutMs' || field === 'historyCapacity' || field === 'maxFileBytes'
          ? Number(editor.draft[field]) : editor.draft[field].trim(),
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

  const fieldRow = (field: Field, hint: keyof typeof settingsLocales.zh, control: React.ReactNode) => <div style={{ display: 'grid', gap: 6 }}>
    <label htmlFor={`${id}-${field}`} style={{ fontWeight: 500 }}>{tr(`settings.${field}`)}</label>
    {control}
    <small id={`${id}-${field}-hint`} style={{ opacity: 0.7, lineHeight: 1.5 }}>{tr(hint)}</small>
    {submitted && validation[field] && <small id={`${id}-${field}-error`} role="alert">{validation[field]}</small>}
  </div>
  const attributes = (field: Field) => ({
    id: `${id}-${field}`, disabled,
    'aria-invalid': submitted && Boolean(validation[field]),
    'aria-describedby': `${id}-${field}-hint${submitted && validation[field] ? ` ${id}-${field}-error` : ''}`,
    style: inputStyle,
  })

  return <section aria-labelledby={`${id}-title`} style={{ display: 'grid', gap: 18, padding: 20, color: 'inherit', fontSize: 14 }}>
    <div><h2 id={`${id}-title`} style={{ margin: '0 0 8px', fontSize: 18 }}>{tr('settings.title')}</h2><p style={{ margin: 0, opacity: 0.7, lineHeight: 1.6 }}>{tr('settings.description')}</p></div>
    {snapshot.status === 'loading' && <p role="status">{tr('settings.loading')}</p>}
    {snapshot.status === 'unavailable' && <p role="status" style={noticeStyle}>{tr(snapshot.mode === 'memory' ? 'settings.memory' : 'settings.unavailable')}</p>}
    {snapshot.status === 'ready' && !snapshot.writable && <p role="status">{tr('settings.readOnly')}</p>}
    {editor && <form onSubmit={event => { event.preventDefault(); void save() }} style={{ display: 'grid', gap: 20 }}>
      {editor.conflict && <div role="alert" style={noticeStyle}>
        <p style={{ margin: '0 0 8px' }}>{tr('settings.conflict')}</p>
        {snapshot.value && <details><summary>{tr('settings.remoteChanges')}</summary><ul style={{ paddingLeft: 20 }}>
          {fields.filter(field => String(snapshot.value![field]) !== editor.source[field]).map(field => <li key={field}>{tr(`settings.${field}`)}: {editor.source[field]} → {String(snapshot.value![field])}</li>)}
        </ul></details>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}><button type="button" disabled={disabled} style={buttonStyle} onClick={loadLatest}>{tr('settings.latest')}</button><button type="button" disabled={disabled} style={buttonStyle} onClick={keepChanges}>{tr('settings.keep')}</button></div>
        <small style={{ display: 'block', marginTop: 8, opacity: 0.75 }}>{tr('settings.keepHint')}</small>
      </div>}
      {fieldRow('ocrEngine', 'settings.ocrHelp', <select {...attributes('ocrEngine')} value={editor.draft.ocrEngine} onChange={event => edit('ocrEngine', event.target.value)}>
        {!available.some(engine => engine.id === editor.draft.ocrEngine) && <option value={editor.draft.ocrEngine} disabled>{tr('settings.unknownEngine')}: {editor.draft.ocrEngine}</option>}
        {available.map(engine => <option key={engine.id} value={engine.id}>{engine.label}</option>)}
      </select>)}
      {fieldRow('ocrLanguages', 'settings.languageHelp', <input {...attributes('ocrLanguages')} value={editor.draft.ocrLanguages} spellCheck={false} onChange={event => edit('ocrLanguages', event.target.value)} />)}
      {fieldRow('ocrTimeoutMs', 'settings.timeoutHelp', <input {...attributes('ocrTimeoutMs')} type="number" min={1} step={1} value={editor.draft.ocrTimeoutMs} onChange={event => edit('ocrTimeoutMs', event.target.value)} />)}
      {fieldRow('defaultColor', 'settings.colorHelp', <div style={{ display: 'flex', gap: 8 }}>
        <input type="color" aria-label={tr('settings.defaultColor')} disabled={disabled} value={/^#[0-9a-f]{6}$/i.test(editor.draft.defaultColor) ? editor.draft.defaultColor : defaultSettings.defaultColor} onChange={event => edit('defaultColor', event.target.value)} style={{ ...inputStyle, padding: 3, width: 46 }} />
        <input {...attributes('defaultColor')} value={editor.draft.defaultColor} spellCheck={false} onChange={event => edit('defaultColor', event.target.value)} />
      </div>)}
      {fieldRow('historyCapacity', 'settings.historyHelp', <input {...attributes('historyCapacity')} type="number" min={1} step={1} value={editor.draft.historyCapacity} onChange={event => edit('historyCapacity', event.target.value)} />)}
      {fieldRow('maxFileBytes', 'settings.fileHelp', <input {...attributes('maxFileBytes')} type="number" min={1} step={1} value={editor.draft.maxFileBytes} onChange={event => edit('maxFileBytes', event.target.value)} />)}
      {error && <p role="alert" style={{ ...noticeStyle, margin: 0 }}>{error}</p>}
      <div aria-live="polite" style={{ opacity: 0.8 }}>{notice || tr(dirty ? 'settings.unsaved' : 'settings.current')}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="submit" disabled={disabled || !dirty || editor.conflict} style={{ ...buttonStyle, fontWeight: 600 }}>{tr(saving ? 'settings.saving' : 'settings.save')}</button>
        <button type="button" disabled={disabled} style={buttonStyle} onClick={restoreDefaults}>{tr('settings.reset')}</button>
        <button type="button" disabled={disabled || !dirty} style={buttonStyle} onClick={loadLatest}>{tr('settings.discard')}</button>
      </div>
    </form>}
  </section>
}

export default Settings
