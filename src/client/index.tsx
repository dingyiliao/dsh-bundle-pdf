import React, { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { Reader } from './Reader.tsx'
import { Settings, settingsLocales, type ConfigForm } from './Settings.tsx'
import { readerLocales } from './reader-locales.ts'
import { createPdfApi, createReadingContextReporter, type PdfConnection } from './api.ts'
import { createHostOcrApi } from './host-ocr-api.ts'
import { defaultSettings, effectiveTranslationEngine } from '../shared/contracts.ts'
import { sessionFile } from '../shared/address.ts'
import type { ReaderProps } from './contracts.ts'
import { createTranslationRegistry } from '../translation/index.js'
import { createHostTranslationEngine } from './translation-api.js'
import { createPdfSessionLifecycle, type PdfSessionOwner, type PdfSessionSource, type PdfSidebarNavigation } from './pdf-session-lifecycle.js'
import { sendExplanationPrompt, type CurrentSessionSource } from './explain-mode.js'
import styles from './reader.css'
import readingSidebarStyles from './reading-sidebar.css'

export const name = 'pdf-reader-client'
export const inject = ['connection', 'documentPreviews', 'slots', 'locale', 'configForms', 'uiSession', 'sidebarRight']
const NS = 'pdfReader'
const ID = '@local/dsh-pdf'
const desktopSavePicker = (globalThis as typeof globalThis & {
  __DSH_SAVE_FILE_PICKER__?: { pick(defaultPath: string): Promise<string | null> }
}).__DSH_SAVE_FILE_PICKER__

interface ClientContext {
  fiber?: { readonly uid: number | null }
  connection: PdfConnection
  uiSession: { readonly adapter: { readonly current: PdfSessionSource & CurrentSessionSource } }
  sidebarRight: PdfSidebarNavigation
  configForms: { get(namespace: string): ConfigForm }
  effect: Context['effect']
  reflect: Context['reflect']
  locale: {
    register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void
    bind(namespace: string): (key: string) => string
  }
  documentPreviews: { register(definition: {
    id: string; extensions: string[]; binaryExtensions: string[]; priority: 'extension';
    title(): string; loading: 'renderer'; wrap: false
  }): () => void }
  slots: {
    inject(name: string, register: () => () => void): () => void
    register<P extends object>(definition: Record<string, unknown>, component: ComponentType<P>): () => void
  }
}

const settingsSchema = z.object({
  ocrTimeoutMs: z.number(),
  translationEngine: z.string(), translationTargetLanguage: z.string(), translationTimeoutMs: z.number(),
  historyCapacity: z.number(), maxFileBytes: z.number(),
})

export async function apply(ctx: ClientContext): Promise<void> {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(), 'pdf: client lifetime')
  const bootstrap = z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value: z.object({ namespace: z.string(), settingsNamespace: z.string(), settings: settingsSchema,
      translationEngines: z.array(z.object({ id: z.string(), name: z.string(), version: z.string(),
        execution: z.enum(['disabled', 'local', 'remote']), maxInputCharacters: z.number().int().positive().optional() })) }) }),
    z.object({ ok: z.literal(false), error: z.object({ message: z.string() }) }),
  ]).parse(
    await ctx.connection.rpc.call('/api', 'pdf.info', {}, lifetime.signal),
  )
  if (lifetime.signal.aborted || ctx.fiber?.uid === null) return
  if (!bootstrap.ok) throw new Error(bootstrap.error.message)
  const info = bootstrap.value
  const form = ctx.configForms.get(info.settingsNamespace)
  const subscribeSettings = (listener: () => void) => form.subscribe(listener)
  const readSettings = () => form.getSnapshot()
  const hostOcr = createHostOcrApi(ctx.connection, lifetime.signal)
  const translation = createTranslationRegistry({ timeoutMs: 600000, maxInputCharacters: 8192, maxOutputCharacters: 32768 })
  for (const engine of info.translationEngines) translation.register(createHostTranslationEngine(ctx.connection, lifetime.signal, engine))
  const synchronizeTranslation = () => {
    const state = form.getSnapshot()
    const settings = state.value ?? info.settings
    const engineId = effectiveTranslationEngine(settings.translationEngine)
    translation.select({ id: `${info.namespace}/${engineId}`, engineId,
      configurationRevision: JSON.stringify([engineId, settings.translationTimeoutMs]), config: {} })
  }
  synchronizeTranslation()
  ctx.effect(() => form.subscribe(synchronizeTranslation), 'pdf: translation configuration')
  ctx.effect(() => () => translation.dispose(), 'pdf: translation lifecycle')
  ctx.effect(() => ctx.reflect.provide('pdfTranslation', translation), 'pdf: Client translation engines')
  const api = createPdfApi(ctx.connection, lifetime.signal)
  const reportReadingContext = createReadingContextReporter(ctx.connection, lifetime.signal)
  const sessionLifecycle = createPdfSessionLifecycle({
    currentSession: ctx.uiSession.adapter.current, sidebar: ctx.sidebarRight, api, signal: lifetime.signal,
    onError: error => { console.error('[pdf] Failed to discard PDFs after Session switch', error) },
  })
  ctx.effect(() => () => sessionLifecycle.dispose(), 'pdf: Session switch cleanup')
  ctx.effect(() => ctx.locale.register(NS, {
    zh: { ...readerLocales.zh, ...settingsLocales.zh, title: 'PDF 阅读与标注' },
    en: { ...readerLocales.en, ...settingsLocales.en, title: 'PDF reader & annotations' },
  }), 'pdf: language dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.dshPlugin = ID
    style.textContent = `${styles}\n${readingSidebarStyles}`
    document.head.append(style)
    return () => style.remove()
  }, 'pdf: reader stylesheet')
  type ReaderTabInfo = ReturnType<ReaderProps['useTabInfo']>
  type OwnerProps = Omit<ReaderProps, 'api' | 'hostOcr' | 'translation' | 'settings' | 'useTabInfo'
    | 'promptExplanation' | 'rememberTranslationTargetLanguage'> & {
    useTabInfo(): ReaderTabInfo & { tab: ReaderTabInfo['tab'] & {
      actions: ReaderTabInfo['tab']['actions'] & { close(): void }
    } }
  }
  function PdfSurface(props: OwnerProps) {
    const state = useSyncExternalStore(subscribeSettings, readSettings, readSettings)
    const currentSettings = state.value ?? info.settings ?? defaultSettings
    const [pendingTargetLanguage, setPendingTargetLanguage] = useState<string>()
    const targetWriteGeneration = useRef(0)
    const rememberTranslationTargetLanguage = useCallback(async (language: string) => {
      const generation = ++targetWriteGeneration.current
      setPendingTargetLanguage(language)
      let accepted = false
      try {
        accepted = await form.mutate([{ op: 'set', path: ['translationTargetLanguage'], value: language }])
      } catch (cause) {
        console.error('[pdf] Failed to save translation target language', cause)
      }
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
    return <Reader {...props} sessionId={file.sessionId} api={readerApi} hostOcr={hostOcr} translation={translation}
      allowReadingContext={props.sessionId === file.sessionId} reportReadingContext={reportReadingContext}
      promptExplanation={props.sessionId === file.sessionId
        ? (text, signal) => sendExplanationPrompt(ctx.uiSession.adapter.current, file.sessionId, text, signal) : undefined}
      pickSavePath={desktopSavePicker?.pick}
      rememberTranslationTargetLanguage={rememberTranslationTargetLanguage}
      settings={{ ...currentSettings, translationEngine: effectiveTranslationEngine(currentSettings.translationEngine),
        translationTargetLanguage: pendingTargetLanguage ?? currentSettings.translationTargetLanguage }} />
  }
  function PdfSettingsSection(props: { t: (key: string) => string }) {
    return <Settings t={props.t} form={form}
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
}
