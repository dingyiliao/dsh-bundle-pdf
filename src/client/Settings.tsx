import React, { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { ConfigForm as DshConfigForm, ConfigFormSnapshot as DshConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { defaultSettings, effectiveTranslationEngine, type PdfSettings } from '../shared/contracts.js'
import { migrateEngineConfigurations, migrateImageEngine } from '../shared/engine-configuration-migration.js'
import { defaultExplanationPromptTemplate, explanationTemplateIssue,
  MAX_EXPLANATION_INSTRUCTION_LENGTH } from '../shared/explanation-template.js'
import { engineBinding, validateEngineConfiguration, type EngineCatalogSnapshot, type EngineConfigurations,
  type EngineKind, type EngineDescriptor, type EngineJson } from '../modules/engines/index.js'
import { EngineConfigurationFields } from './EngineConfigurationFields.js'
import { DshVisionModelSettings, type VisionModelMode } from './DshVisionModelSettings.js'
import type { ModelOptionsStore } from '../adapters/client/remote/model-options.js'

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
  modelOptions?: ModelOptionsStore
  rebuildRetrievalIndex?: (signal: AbortSignal) => Promise<void>
}

export const settingsLocales = {
  zh: {
    'settings.title': 'PDF',
    'settings.loading': '正在加载 PDF 设置…',
    'settings.unavailable': '当前连接无法读取或保存 PDF 设置。已编辑的内容会保留在这里。',
    'settings.readOnly': '当前设置为只读。',
    'settings.enginesHelp': '按需调用所选引擎；模型或远程引擎会接收待处理的文字或图片。',
    'settings.ocrEngine': 'OCR 引擎',
    'settings.imageEngine': '图像理解引擎',
    'settings.embeddingEngine': '语义检索引擎',
    'settings.embeddingHelp': '启用后，打开 PDF 会在后台建立文字索引；第三方服务会收到抽取的文字。关键词搜索不受影响。',
    'settings.indexScanPages': '文字识别索引',
    'settings.indexScanPagesHelp': '原生文字缺失或编码损坏时，使用上方 OCR 引擎识别文字并加入索引。可与视觉描述索引同时开启；启用语义检索后自动处理。',
    'settings.indexImageDescriptions': '视觉描述索引',
    'settings.indexImageDescriptionsHelp': '使用上方图像理解引擎生成整页视觉描述，再将描述文字加入索引，并非直接嵌入原始图片。可与文字识别索引同时开启；会增加模型调用、等待时间和费用，暂不单独检测图表区域。',
    'settings.rebuildIndex': '重建索引',
    'settings.rebuildingIndex': '正在清除索引缓存…',
    'settings.rebuildIndexHelp': '清除当前 profile 的检索索引。启用语义检索时，已打开的文档会在后台重建；其他文档按需处理，不会修改 PDF 或草稿。请先保存或撤销设置。',
    'settings.indexRebuilt': '索引缓存已清除，将在后台或下次检索时重建。',
    'settings.rebuildIndexFailed': '无法重建索引：',
    'settings.imageHelp': '用于图像理解和视觉描述索引。默认跟随当前会话，也可单独指定视觉模型；解释的最终回答仍由当前会话模型完成。',
    'settings.visionModelSource': '模型来源',
    'settings.visionFollow': '跟随当前会话',
    'settings.visionSpecified': '指定模型',
    'settings.visionModel': '视觉模型',
    'settings.visionChooseModel': '请选择视觉模型',
    'settings.visionUnavailableModel': '已保存的模型当前不可用',
    'settings.visionEffort': '推理强度',
    'settings.visionDefaultEffort': '模型默认值',
    'settings.visionUnavailableEffort': '已保存的推理强度当前不可用',
    'settings.visionLoading': '正在加载视觉模型…',
    'settings.visionCatalogError': '无法加载视觉模型，请重试。',
    'settings.visionPartialCatalog': '部分供应商暂时无法加载，可选择已加载的模型。',
    'settings.visionEmptyCatalog': '当前没有已声明支持图像输入的模型，请先在 DSH 模型设置中配置。',
    'settings.visionRefresh': '刷新模型',
    'settings.visionFollowHelp': '使用当前会话选择的模型和推理强度；该模型需要支持图像输入。',
    'settings.visionSelectionRequired': '请选择当前可用的视觉模型。',
    'settings.visionEffortInvalid': '请选择该模型支持的推理强度。',
    'settings.engineConfigurations': '引擎配置',
    'settings.engineConfigInvalid': '请检查所选引擎的配置。',
    'settings.engineReference': '填写此引擎插件管理的凭据引用，不要输入 API key 或其他密钥。',
    'settings.engineLocal': '本地',
    'settings.engineRemote': '模型 / 远程',
    'settings.engineService': '服务',
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
    'settings.enginesHelp': 'Engines run on demand. Model or remote engines receive the text or images being processed.',
    'settings.ocrEngine': 'OCR engine',
    'settings.imageEngine': 'Image understanding engine',
    'settings.embeddingEngine': 'Semantic search engine',
    'settings.embeddingHelp': 'When enabled, opening a PDF builds its text index in the background. Third-party services receive extracted text. Keyword search remains available.',
    'settings.indexScanPages': 'Text recognition indexing',
    'settings.indexScanPagesHelp': 'Uses the OCR engine above when native text is missing or damaged, then indexes the recognized text. Can run alongside visual description indexing. Automatic preparation requires semantic search.',
    'settings.indexImageDescriptions': 'Visual description indexing',
    'settings.indexImageDescriptionsHelp': 'Generates whole-page visual descriptions with the image understanding engine above and indexes that text, rather than embedding raw images. Can run alongside text recognition indexing. Adds model calls, waiting time and cost. Individual chart regions are not detected yet.',
    'settings.rebuildIndex': 'Rebuild index',
    'settings.rebuildingIndex': 'Clearing index cache…',
    'settings.rebuildIndexHelp': 'Clears this profile’s retrieval indexes. Open documents rebuild in the background when semantic search is enabled; others rebuild on demand. PDFs and drafts are unchanged. Save or discard settings first.',
    'settings.indexRebuilt': 'Index cache cleared. Indexes rebuild in the background or when searched.',
    'settings.rebuildIndexFailed': 'Could not rebuild the index: ',
    'settings.imageHelp': 'Used for image understanding and visual description indexing. Follows the current session by default, or uses a specified visual model. The current chat model still provides the final explanation.',
    'settings.visionModelSource': 'Model source',
    'settings.visionFollow': 'Follow current session',
    'settings.visionSpecified': 'Specify model',
    'settings.visionModel': 'Visual model',
    'settings.visionChooseModel': 'Choose a visual model',
    'settings.visionUnavailableModel': 'Saved model is currently unavailable',
    'settings.visionEffort': 'Reasoning effort',
    'settings.visionDefaultEffort': 'Model default',
    'settings.visionUnavailableEffort': 'Saved effort is currently unavailable',
    'settings.visionLoading': 'Loading visual models…',
    'settings.visionCatalogError': 'Visual models could not be loaded. Please retry.',
    'settings.visionPartialCatalog': 'Some providers could not be loaded. Available models remain selectable.',
    'settings.visionEmptyCatalog': 'No model currently declares image input. Configure one in DSH model settings first.',
    'settings.visionRefresh': 'Refresh models',
    'settings.visionFollowHelp': 'Uses the current session’s model and reasoning effort. That model must support image input.',
    'settings.visionSelectionRequired': 'Choose a currently available visual model.',
    'settings.visionEffortInvalid': 'Choose a reasoning effort supported by this model.',
    'settings.engineConfigurations': 'Engine configuration',
    'settings.engineConfigInvalid': 'Check the selected engine configuration.',
    'settings.engineReference': 'Enter a credential reference managed by this engine plugin, not an API key or another secret.',
    'settings.engineLocal': 'Local',
    'settings.engineRemote': 'Model / remote',
    'settings.engineService': 'Service',
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
const booleanFields = ['indexScanPages', 'indexImageDescriptions'] as const
type BooleanField = typeof booleanFields[number]
const fields = ['ocrEngine', 'imageEngine', 'embeddingEngine', ...booleanFields, 'engineConfigurations', 'translationEngine', 'translationTimeoutMs', 'historyCapacity', ...promptFields,
  'explanationPromptTemplate'] as const
type Field = typeof fields[number]
const fieldHints: Partial<Record<Field, keyof typeof settingsLocales.zh>> = {
  ocrEngine: 'settings.ocrHelp', imageEngine: 'settings.imageHelp', translationEngine: 'settings.translationHelp',
  embeddingEngine: 'settings.embeddingHelp',
  indexScanPages: 'settings.indexScanPagesHelp', indexImageDescriptions: 'settings.indexImageDescriptionsHelp',
  translationTimeoutMs: 'settings.translationTimeoutHelp', historyCapacity: 'settings.historyHelp',
}
type Draft = Record<Exclude<Field, BooleanField>, string> & Record<BooleanField, boolean>
function isBooleanField(field: Field): field is BooleanField {
  return booleanFields.some(option => option === field)
}
interface Editor {
  source: Draft; draft: Draft; revision: number | undefined; conflict: boolean; unsets: Field[]
  sourceVisionModelMode: VisionModelMode
  visionModelMode: VisionModelMode
}
function visionModelMode(draft: Draft): VisionModelMode {
  const config: EngineConfigurations = JSON.parse(draft.engineConfigurations)
  const image = config.image?.['dsh-vision']
  return [image?.provider, image?.model].some(value => typeof value === 'string' && value.trim()) ? 'specified' : 'follow'
}
const unavailableModelOptions: ReturnType<ModelOptionsStore['getSnapshot']> = { status: 'idle' }

function toDraft(settings: PdfSettings): Draft {
  const complete = { ...defaultSettings, ...settings }
  complete.translationEngine = effectiveTranslationEngine(complete.translationEngine)
  complete.indexScanPages = settings.indexScanPages ?? true
  complete.indexImageDescriptions = settings.indexImageDescriptions ?? false
  complete.imageEngine = migrateImageEngine(complete.imageEngine!, complete.engineConfigurations)
  return Object.fromEntries(fields.map(field => [field, isBooleanField(field) ? complete[field] : field === 'engineConfigurations'
    ? JSON.stringify(migrateEngineConfigurations(complete.engineConfigurations, settings.imageEngine)) : String(complete[field])])) as Draft
}
function isDirty(editor: Editor | null): boolean {
  return editor !== null && (editor.unsets.length > 0 || fields.some(field => editor.source[field] !== editor.draft[field])
    || editor.draft.imageEngine === 'dsh-vision' && editor.visionModelMode !== editor.sourceVisionModelMode)
}
function acceptedEditor(snapshot: ConfigFormSnapshot): Editor | null {
  if (snapshot.value === undefined) return null
  const draft = toDraft(snapshot.value)
  return { source: draft, draft: { ...draft }, revision: snapshot.revision, conflict: false, unsets: [],
    sourceVisionModelMode: visionModelMode(draft), visionModelMode: visionModelMode(draft) }
}

/** Settings card with an explicit save boundary and revision-fenced local edits. */
export function Settings({ form, t, translationEngines, engineCatalog, modelOptions, rebuildRetrievalIndex }: SettingsProps) {
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
  const activeModelOptions = editor?.draft.imageEngine === 'dsh-vision' && editor.visionModelMode === 'specified'
    ? modelOptions : undefined
  const modelDirectory = useSyncExternalStore(
    useCallback(listener => activeModelOptions?.subscribe(listener) ?? (() => {}), [activeModelOptions]),
    useCallback(() => activeModelOptions?.getSnapshot() ?? unavailableModelOptions, [activeModelOptions]),
    useCallback(() => activeModelOptions?.getSnapshot() ?? unavailableModelOptions, [activeModelOptions]),
  )
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [rebuildingIndex, setRebuildingIndex] = useState(false)
  const [indexNotice, setIndexNotice] = useState('')
  const [indexError, setIndexError] = useState('')
  const indexRequest = useRef<AbortController | undefined>(undefined)
  const formIdentity = useRef(form)
  const mounted = useRef(true)
  const id = useId()

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    setRebuildingIndex(false); setIndexNotice(''); setIndexError('')
    return () => { indexRequest.current?.abort(); indexRequest.current = undefined }
  }, [form, rebuildRetrievalIndex])
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

  const disabled = saving || rebuildingIndex || snapshot.status !== 'ready' || !snapshot.writable || snapshot.revision === undefined
  const validation: Partial<Record<Field, string>> = {}
  const configurations: EngineConfigurations = editor ? JSON.parse(editor.draft.engineConfigurations) : {}
  let visionModelError: string | undefined
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
    if (editor.draft.indexImageDescriptions && !editor.source.indexImageDescriptions
      && !descriptors('image').some(engine => engine.id === editor.draft.imageEngine && engine.execution !== 'disabled')) {
      validation.imageEngine = tr('settings.invalidEngine')
    }
    if (editor.draft.imageEngine === 'dsh-vision' && editor.visionModelMode === 'specified') {
      const config = configurations.image?.['dsh-vision'] ?? {}
      const source = sourceConfigurations.image?.['dsh-vision'] ?? {}
      const touched = editor.visionModelMode !== editor.sourceVisionModelMode
        || editor.draft.imageEngine !== editor.source.imageEngine
        || ['provider', 'model', 'reasoningEffort'].some(key => config[key] !== source[key])
      if (touched) {
        const model = modelDirectory.catalog?.groups.find(group => group.id === config.provider)?.models.find(item => item.id === config.model)
        if (!model || modelDirectory.status !== 'ready') visionModelError = tr('settings.visionSelectionRequired')
        else if (config.reasoningEffort && !model.reasoning?.efforts.some(effort => effort.id === config.reasoningEffort)) {
          visionModelError = tr('settings.visionEffortInvalid')
        }
        if (visionModelError) validation.engineConfigurations = visionModelError
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
  const remoteDraft = snapshot.value === undefined ? undefined : toDraft(snapshot.value)

  async function rebuildIndex() {
    if (!rebuildRetrievalIndex || disabled || dirty || !editor || editor.conflict || indexRequest.current) return
    const controller = new AbortController(), owner = form
    indexRequest.current = controller
    setRebuildingIndex(true); setIndexNotice(''); setIndexError('')
    try {
      await rebuildRetrievalIndex(controller.signal)
      if (mounted.current && !controller.signal.aborted && formIdentity.current === owner
          && indexRequest.current === controller) setIndexNotice(tr('settings.indexRebuilt'))
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted && formIdentity.current === owner
          && indexRequest.current === controller) {
        setIndexError(`${tr('settings.rebuildIndexFailed')}${failure instanceof Error ? failure.message : String(failure)}`)
      }
    } finally {
      if (indexRequest.current === controller) {
        indexRequest.current = undefined
        if (mounted.current) setRebuildingIndex(false)
      }
    }
  }

  function edit<F extends Field>(field: F, value: Draft[F]) {
    const splitPromptEdited = promptFields.some(prompt => prompt === field)
    setEditor(current => current && ({ ...current,
      draft: { ...current.draft, [field]: value,
        ...(splitPromptEdited && current.source.explanationPromptTemplate !== defaultExplanationPromptTemplate
          ? { explanationPromptTemplate: defaultExplanationPromptTemplate } : {}) },
      unsets: current.unsets.filter(key => key !== field
        && (!splitPromptEdited || key !== 'explanationPromptTemplate')) }))
    setNotice(''); setError('')
  }
  function changeVisionMode(mode: VisionModelMode) {
    setEditor(current => {
      if (!current) return current
      const next: EngineConfigurations = JSON.parse(current.draft.engineConfigurations)
      const saved = next.image?.['dsh-vision']
      if (mode === 'follow' && saved && ['provider', 'model', 'reasoningEffort'].some(key => Object.hasOwn(saved, key))) {
        const config = { ...saved }, image = { ...next.image }
        delete config.provider; delete config.model; delete config.reasoningEffort
        if (Object.keys(config).length) image['dsh-vision'] = config
        else delete image['dsh-vision']
        if (Object.keys(image).length) next.image = image
        else delete next.image
      }
      return { ...current, visionModelMode: mode,
        draft: { ...current.draft, engineConfigurations: JSON.stringify(next) },
        unsets: current.unsets.filter(field => field !== 'engineConfigurations') }
    })
    setNotice(''); setError('')
  }
  function changeVisionConfiguration(config: import('../modules/engines/index.js').EngineConfiguration) {
    const next = { ...configurations, image: { ...configurations.image, 'dsh-vision': config } }
    edit('engineConfigurations', JSON.stringify(next))
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
    setEditor(current => {
      if (!current) return current
      const draft = Object.fromEntries(fields.map(field => [field, current.unsets.includes(field) ? defaults[field]
        : current.draft[field] !== current.source[field] ? current.draft[field] : source[field]])) as Draft
      return { source, revision: latest.revision, conflict: false, unsets: current.unsets, draft,
        sourceVisionModelMode: visionModelMode(source),
        visionModelMode: current.visionModelMode !== current.sourceVisionModelMode ? current.visionModelMode : visionModelMode(draft) }
    })
    setError(''); setNotice(tr('settings.keepHint'))
  }
  function restoreDefaults() {
    const base = snapshot.base && typeof snapshot.base === 'object' ? snapshot.base as Partial<PdfSettings> : {}
    const defaults = toDraft({ ...defaultSettings, ...base })
    setEditor(current => current && ({ ...current, draft: defaults, unsets: [...fields], visionModelMode: visionModelMode(defaults) }))
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
        value: isBooleanField(field) ? editor.draft[field] : field === 'translationTimeoutMs' || field === 'historyCapacity'
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
  const indexOption = (field: BooleanField) => editor && <div key={field} className="dsh-pdf-settings-field">
    <label htmlFor={`${id}-${field}`} className="dsh-pdf-settings-label">
      <input {...attributes(field)} className={undefined} type="checkbox" checked={editor.draft[field]}
        style={{ margin: '0 8px 0 0', verticalAlign: 'middle' }}
        onChange={event => edit(field, event.target.checked)} />
      {tr(`settings.${field}`)}
    </label>
    <small id={`${id}-${field}-hint`} className="dsh-pdf-settings-hint">{tr(fieldHints[field]!)}</small>
  </div>

  const engineFields = (kind: EngineKind, field: 'ocrEngine' | 'imageEngine' | 'translationEngine' | 'embeddingEngine') => {
    if (!editor) return null
    const engineId = editor.draft[field]
    const engines = descriptors(kind).filter(engine => kind === 'embedding' || engine.execution !== 'disabled')
    const selected = engines.find(engine => engine.id === engineId)
    return <div className="dsh-pdf-settings-engine">
      {fieldRow(field, <select {...attributes(field)} value={engineId}
        onChange={event => edit(field, event.target.value)}>
        {!selected && <option value={engineId} disabled>{tr('settings.unknownEngine')}: {engineId}</option>}
        {engines.map(engine => <option key={engine.id} value={engine.id}>{engine.id === 'dsh-model'
          ? tr('settings.translationDshModel') : engine.name}</option>)}
      </select>, selected && selected.execution !== 'disabled' && <small className="dsh-pdf-settings-engine-kind">{tr(selected.execution === 'local'
        ? 'settings.engineLocal' : selected.execution === 'service' ? 'settings.engineService' : 'settings.engineRemote')}</small>)}
      {!selected ? <p className="dsh-pdf-settings-hint" role="status">{tr('settings.engineMissing')}</p>
        : <div className="dsh-pdf-settings-engine-options">
          {kind === 'image' && selected.id === 'dsh-vision' && <DshVisionModelSettings
            mode={editor.visionModelMode} config={configurations.image?.['dsh-vision'] ?? {}}
            options={modelOptions} prefix={`${id}-vision`} disabled={disabled} t={tr}
            error={submitted ? visionModelError : undefined}
            changeMode={changeVisionMode} changeConfig={changeVisionConfiguration} />}
          <EngineConfigurationFields descriptor={kind === 'image' && selected.id === 'dsh-vision'
            ? { ...selected, configurationFields: selected.configurationFields?.filter(field => !['provider', 'model', 'reasoningEffort'].includes(field.key)) }
            : selected} config={configurations[kind]?.[selected.id] ?? {}}
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
        {remoteDraft && <details><summary>{tr('settings.remoteChanges')}</summary><ul>
          {fields.filter(field => remoteDraft[field] !== editor.source[field]).map(field => <li key={field}>{tr(`settings.${field}`)}: {String(editor.source[field])} → {String(remoteDraft[field])}</li>)}
        </ul></details>}
        <div className="dsh-pdf-settings-notice-actions"><button type="button" disabled={disabled} className="dsh-pdf-settings-secondary" onClick={loadLatest}>{tr('settings.latest')}</button><button type="button" disabled={disabled} className="dsh-pdf-settings-secondary" onClick={keepChanges}>{tr('settings.keep')}</button></div>
        <small className="dsh-pdf-settings-hint">{tr('settings.keepHint')}</small>
      </div>}
      <div className="dsh-pdf-settings-group">
        <p className="dsh-pdf-settings-hint">{tr('settings.enginesHelp')}</p>
        {engineFields('ocr', 'ocrEngine')}
        {engineFields('image', 'imageEngine')}
        {engineFields('translation', 'translationEngine')}
        {engineFields('embedding', 'embeddingEngine')}
        {booleanFields.map(indexOption)}
        {rebuildRetrievalIndex && <div className="dsh-pdf-settings-field">
          <div className="dsh-pdf-settings-field-heading">
            <button type="button" className="dsh-pdf-settings-secondary" disabled={disabled || dirty || editor.conflict}
              aria-describedby={`${id}-rebuild-index-help`} onClick={() => { void rebuildIndex() }}>
              {tr(rebuildingIndex ? 'settings.rebuildingIndex' : 'settings.rebuildIndex')}
            </button>
          </div>
          <small id={`${id}-rebuild-index-help`} className="dsh-pdf-settings-hint">{tr('settings.rebuildIndexHelp')}</small>
          {indexNotice && <p role="status" className="dsh-pdf-settings-status">{indexNotice}</p>}
          {indexError && <p role="alert" className="dsh-pdf-settings-error">{indexError}</p>}
        </div>}
        {submitted && validation.engineConfigurations && !visionModelError && <p role="alert" className="dsh-pdf-settings-error">{validation.engineConfigurations}</p>}
        {fieldRow('translationTimeoutMs', <input {...attributes('translationTimeoutMs')} type="number" min={1000} max={600000} step={1} value={editor.draft.translationTimeoutMs} onChange={event => edit('translationTimeoutMs', event.target.value)} />)}
      </div>
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
