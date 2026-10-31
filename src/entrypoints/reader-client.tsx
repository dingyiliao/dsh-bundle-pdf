import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { z } from 'zod'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { Reader } from '../client/Reader.tsx'
import { Settings, settingsLocales } from '../client/Settings.tsx'
import { createPdfIndexingApi } from '../adapters/client/remote/indexing.js'
import { readerLocales } from '../modules/viewer/index.js'
import { createPdfApi, createPdfAgentNavigationApi, createReadingContextReporter, type PdfConnection } from '../adapters/client/remote/pdf-api.ts'
import { createPdfEvidenceRevalidator } from '../adapters/client/remote/pdf-evidence.ts'
import { createHostOcrApi } from '../adapters/client/remote/host-ocr-api.ts'
import { createImageUnderstandingApi } from '../adapters/client/remote/image-understanding-api.ts'
import { createRegionEvidenceApi } from '../adapters/client/remote/pdf-region.ts'
import { createTextSelectionEvidenceApi } from '../adapters/client/remote/pdf-selection.ts'
import { defaultSettings, effectiveTranslationEngine, type PdfSettings } from '../shared/contracts.ts'
import { sessionFile } from '../shared/address.ts'
import type { ReaderProps } from '../client/contracts.ts'
import { createTranslationRegistry } from '../translation/index.js'
import { createEngineCatalogStore } from '../adapters/client/remote/engine-catalog.js'
import { createModelOptionsStore } from '../adapters/client/remote/model-options.js'
import { createTranslationDirectoryMirror } from '../adapters/client/remote/translation-directory.js'
import { createRetrievalIndexApi } from '../adapters/client/remote/retrieval-index.js'
import { engineBinding, engineCatalogSchema, engineConfigurationsSchema, engineExecutionSchema } from '../modules/engines/index.js'
import { persistTranslationLanguage } from '../adapters/client/dsh/persist-translation-language.js'
import { PdfEvidenceToolCard, type PdfToolCallProps } from '../client/toolview/PdfEvidenceToolCard.js'
import { createPdfEvidenceNavigation } from '../client/toolview/pdf-evidence-navigation.js'
import { createPdfSessionLifecycle, type PdfSessionOwner, type PdfSessionSource, type PdfSidebarNavigation } from '../client/pdf-session-lifecycle.js'
import { sendExplanationPrompt, type CurrentSessionSource } from '../adapters/client/dsh/index.js'
import styles from '../client/reader.css'
import settingsStyles from '../client/settings.css'
import readingSidebarStyles from '../client/reading-sidebar.css'
import windowedPagesStyles from '../client/windowed-pages.css'
import annotationCommentCardStyles from '../client/annotation-comment-card.css'
import glassStyles from '../client/glass.css'

export const name = 'pdf-reader-client'
export const inject = ['connection', 'documentPreviews', 'slots', 'locale', 'configForms', 'uiSession', 'sidebarRight']
const NS = 'pdfReader'
const ID = '@dylanl1/dsh-plugin-pdf'
const desktopSavePicker = (globalThis as typeof globalThis & {
  __DSH_SAVE_FILE_PICKER__?: { pick(defaultPath: string): Promise<string | null> }
}).__DSH_SAVE_FILE_PICKER__

interface ClientContext {
  fiber?: { readonly uid: number | null }
  connection: PdfConnection
  uiSession: { readonly adapter: { readonly current: PdfSessionSource & CurrentSessionSource } }
  sidebarRight: PdfSidebarNavigation
  configForms: Pick<Context['configForms'], 'get'>
  effect: Context['effect']
  reflect: Context['reflect']
  locale: {
    register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void
    bind(namespace: string): (key: string) => string
  }
  documentPreviews: Pick<Context['documentPreviews'], 'register'>
  slots: {
    inject(name: string, register: () => () => void): () => void
    register<P extends object>(definition: Record<string, unknown>, component: ComponentType<P>): () => void
  }
}

const settingsSchema = z.object({
  ocrEngine: z.string().optional(), imageEngine: z.string().optional(),
  engineConfigurations: engineConfigurationsSchema.optional(),
  ocrTimeoutMs: z.number(),
  translationEngine: z.string(), translationTargetLanguage: z.string(), translationTimeoutMs: z.number(),
  historyCapacity: z.number(), maxFileBytes: z.number(),
  explanationGeneralInstruction: z.string().optional().default(''),
  explanationTextInstruction: z.string().optional().default(''),
  explanationImageInstruction: z.string().optional().default(''),
  explanationPromptTemplate: z.string(),
})

export async function apply(ctx: ClientContext): Promise<void> {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(), 'pdf: client lifetime')
  const bootstrap = z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value: z.object({ namespace: z.string(), settingsNamespace: z.string(), settings: settingsSchema,
      engineCatalog: engineCatalogSchema,
      translationEngines: z.array(z.object({ id: z.string(), name: z.string(), version: z.string(),
        execution: engineExecutionSchema, maxInputCharacters: z.number().int().positive().optional() })) }) }),
    z.object({ ok: z.literal(false), error: z.object({ message: z.string() }) }),
  ]).parse(
    await ctx.connection.rpc.call('/api', 'pdf.info', {}, lifetime.signal),
  )
  if (lifetime.signal.aborted || ctx.fiber?.uid === null) return
  if (!bootstrap.ok) throw new Error(bootstrap.error.message)
  const info = bootstrap.value
  const form = ctx.configForms.get<PdfSettings>(info.settingsNamespace)
  const retrievalIndex = createRetrievalIndexApi(ctx.connection, lifetime.signal)
  const indexingApi = createPdfIndexingApi(ctx.connection, lifetime.signal)
  ctx.effect(() => () => indexingApi.dispose(), 'pdf: indexing task subscriptions')
  const subscribeSettings = (listener: () => void) => form.subscribe(listener)
  const readSettings = () => form.getSnapshot()
  const hostOcr = createHostOcrApi(ctx.connection, lifetime.signal)
  const imageUnderstanding = createImageUnderstandingApi(ctx.connection, lifetime.signal)
  const regionEvidence = createRegionEvidenceApi(ctx.connection, lifetime.signal)
  const textSelectionEvidence = createTextSelectionEvidenceApi(ctx.connection, lifetime.signal)
  const translation = createTranslationRegistry({ timeoutMs: 600000, maxInputCharacters: 8192, maxOutputCharacters: 32768 })
  const catalog = createEngineCatalogStore(ctx.connection, lifetime.signal, info.engineCatalog)
  const modelOptions = createModelOptionsStore(ctx.connection, lifetime.signal)
  ctx.effect(() => () => modelOptions.dispose(), 'pdf: read-only model choices')
  const translationMirror = createTranslationDirectoryMirror(translation, ctx.connection, lifetime.signal)
  const synchronizeDirectory = () => translationMirror.update(catalog.getSnapshot().engines.translation)
  synchronizeDirectory()
  ctx.effect(() => catalog.subscribe(synchronizeDirectory), 'pdf: dynamic engine directory')
  ctx.effect(() => () => { translationMirror.dispose(); catalog.dispose() }, 'pdf: engine directory lifecycle')
  const synchronizeTranslation = () => {
    const state = form.getSnapshot()
    const settings = state.value ?? info.settings
    const engineId = effectiveTranslationEngine(settings.translationEngine)
    const binding = engineBinding('translation', engineId, settings.engineConfigurations as PdfSettings['engineConfigurations'])
    translation.select({ id: `${info.namespace}/${engineId}`, engineId,
      configurationRevision: JSON.stringify([engineId, settings.translationTimeoutMs, binding.config]), config: binding.config ?? {} })
  }
  synchronizeTranslation()
  ctx.effect(() => form.subscribe(synchronizeTranslation), 'pdf: translation configuration')
  ctx.effect(() => () => translation.dispose(), 'pdf: translation lifecycle')
  ctx.effect(() => ctx.reflect.provide('pdfTranslation', translation), 'pdf: Client translation engines')
  const api = createPdfApi(ctx.connection, lifetime.signal)
  const reportReadingContext = createReadingContextReporter(ctx.connection, lifetime.signal)
  const agentNavigation = createPdfAgentNavigationApi(ctx.connection, lifetime.signal)
  const sessionLifecycle = createPdfSessionLifecycle({
    currentSession: ctx.uiSession.adapter.current, sidebar: ctx.sidebarRight, api, signal: lifetime.signal,
    onError: error => { console.error('[pdf] Failed to release closed PDF views', error) },
  })
  ctx.effect(() => () => sessionLifecycle.dispose(), 'pdf: view reference lifecycle')
  ctx.effect(() => ctx.locale.register(NS, {
    zh: { ...readerLocales.zh, ...settingsLocales.zh, title: 'PDF 阅读与标注' },
    en: { ...readerLocales.en, ...settingsLocales.en, title: 'PDF reader & annotations' },
  }), 'pdf: language dictionaries')
  const t = ctx.locale.bind(NS)
  const evidenceNavigation = createPdfEvidenceNavigation(createPdfEvidenceRevalidator(ctx.connection, lifetime.signal))
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.dshPlugin = ID
    style.textContent = `${styles}\n${settingsStyles}\n${readingSidebarStyles}\n${windowedPagesStyles}\n${annotationCommentCardStyles}\n${glassStyles}`
    document.head.append(style)
    return () => style.remove()
  }, 'pdf: reader stylesheet')
  type ReaderTabInfo = ReturnType<ReaderProps['useTabInfo']>
  type OwnerProps = Omit<ReaderProps, 'api' | 'hostOcr' | 'imageUnderstanding' | 'translation' | 'settings' | 'useTabInfo'
    | 'promptExplanation' | 'rememberTranslationTargetLanguage'> & {
    useTabInfo(): ReaderTabInfo & { tab: ReaderTabInfo['tab'] & {
      actions: ReaderTabInfo['tab']['actions'] & { close(): void }
    } }
  }
  function PdfSurface(props: OwnerProps) {
    const state = useSyncExternalStore(subscribeSettings, readSettings, readSettings)
    const currentSettings = state.value ?? info.settings ?? defaultSettings
    const engines = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot, catalog.getSnapshot)
    const configuredOcr = useMemo(() => ({ ...hostOcr }),
      [engines.revision, currentSettings.ocrEngine, currentSettings.engineConfigurations])
    const configuredImages = useMemo(() => ({ ...imageUnderstanding }),
      [engines.revision, currentSettings.imageEngine, currentSettings.ocrEngine, currentSettings.engineConfigurations])
    const [pendingTargetLanguage, setPendingTargetLanguage] = useState<string>()
    const targetWriteGeneration = useRef(0)
    const rememberTranslationTargetLanguage = useCallback(async (language: string) => {
      const generation = ++targetWriteGeneration.current
      setPendingTargetLanguage(language)
      const accepted = await persistTranslationLanguage(() => form.mutate([
        { op: 'set', path: ['translationTargetLanguage'], value: language },
      ]))
      if (generation === targetWriteGeneration.current) setPendingTargetLanguage(undefined)
      return accepted
    }, [])
    const { tab } = props.useTabInfo()
    // Resource addresses carry their own session. The active chat may be different.
    const file = sessionFile(props.resourceAddress)
    const owner = useMemo<PdfSessionOwner>(() => ({
      containerSessionId: props.sessionId, resourceSessionId: file.sessionId,
      tabId: tab.id, resourceAddress: props.resourceAddress,
      signal: tab.signal, close: () => tab.actions.close(),
    }), [props.sessionId, file.sessionId, tab.id, props.resourceAddress, tab.signal, tab.actions])
    useLayoutEffect(() => {
      if (!owner.signal.aborted) sessionLifecycle.register(owner)
      // The occurrence owns this registration; hiding/unmounting a body must
      // preserve it so a later Session switch can still close the tab.
    }, [owner])
    const readerApi = useMemo<ReaderProps['api']>(() => ({
      ...api,
      open: (sessionId, address, signal) => sessionLifecycle.open(owner, sessionId, address, signal),
    }), [owner])
    return <Reader {...props} sessionId={file.sessionId} api={readerApi} hostOcr={configuredOcr}
      indexingApi={indexingApi} engineCatalog={engines}
      imageUnderstanding={configuredImages} regionEvidence={regionEvidence}
      textSelectionEvidence={textSelectionEvidence} translation={translation}
      allowReadingContext={props.sessionId === file.sessionId} reportReadingContext={reportReadingContext}
      agentNavigation={agentNavigation}
      promptExplanation={props.sessionId === file.sessionId
        ? (content, signal) => sendExplanationPrompt(ctx.uiSession.adapter.current, file.sessionId, content, signal) : undefined}
      pickSavePath={desktopSavePicker?.pick}
      addressForPath={sessionFileAddress}
      evidenceNavigation={evidenceNavigation}
      rememberTranslationTargetLanguage={rememberTranslationTargetLanguage}
      settings={{ ...currentSettings, translationEngine: effectiveTranslationEngine(currentSettings.translationEngine),
        translationTargetLanguage: pendingTargetLanguage ?? currentSettings.translationTargetLanguage }} />
  }
  function PdfSettingsSection(props: { t: (key: string) => string }) {
    const engines = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot, catalog.getSnapshot)
    return <Settings t={props.t} form={form}
      engineCatalog={engines}
      modelOptions={modelOptions}
      rebuildRetrievalIndex={retrievalIndex.rebuild}
      translationEngines={translation.list().map(engine => ({ id: engine.id, label: engine.name }))} />
  }
  ctx.effect(() => ctx.documentPreviews.register({ id: ID, extensions: ['pdf'], binaryExtensions: ['pdf'],
    priority: 'extension', title: () => t('title'), loading: 'renderer', wrap: false }), 'pdf: default renderer')
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
    name: 'sidebar.right.tab.document', key: ID, locale: NS,
  }, PdfSurface)), 'pdf: sidebar document')
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'pdf-reader', order: 40, label: () => t('settings.title'), locale: NS,
  }, PdfSettingsSection)), 'pdf: settings card')
  function PdfToolCard(props: PdfToolCallProps) {
    return <PdfEvidenceToolCard {...props} navigation={evidenceNavigation} t={key => t(`reader.${key}`)} />
  }
  for (const key of ['pdf_page_read', 'pdf_keyword_search', 'pdf_evidence_read',
    'pdf_read_page', 'pdf_locate', 'pdf_context']) {
    ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview', key, locale: NS,
    }, PdfToolCard)), `pdf: ${key} evidence card`)
  }
}
