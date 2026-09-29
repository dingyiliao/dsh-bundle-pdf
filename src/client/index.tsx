import React, { useCallback, useEffect, useRef, useSyncExternalStore, type ComponentType } from 'react'
import { z } from 'zod'
import { Reader } from './Reader.tsx'
import { Settings, settingsLocales, type ConfigForm } from './Settings.tsx'
import { readerLocales } from './reader-locales.ts'
import { createPdfApi, type PdfConnection } from './api.ts'
import { createPdfRuntime } from './pdf-runtime.ts'
import { createOcrRegistry } from '../ocr/index.ts'
import { defaultSettings } from '../shared/contracts.ts'
import { sessionFile } from '../shared/address.ts'
import type { ReaderProps } from './contracts.ts'
import { createTranslationRegistry } from '../translation/index.js'
import { createHostTranslationEngine } from './translation-api.js'
import { createNativeDictionary } from './native-dictionary.js'
import styles from './reader.css'

export const name = 'pdf-reader-client'
export const inject = ['connection', 'documentPreviews', 'slots', 'locale', 'configForms']
const NS = 'pdfReader'
const ID = '@local/dsh-pdf'

interface ClientContext {
  fiber?: { readonly uid: number | null }
  connection: PdfConnection
  configForms: { get(namespace: string): ConfigForm }
  effect(callback: () => (() => void | Promise<void>), label?: string): unknown
  reflect: { provide(key: string, value: unknown): () => void }
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
  ocrEngine: z.string(), ocrLanguages: z.string(), ocrTimeoutMs: z.number(),
  translationEngine: z.string(), translationSourceLanguage: z.string(), translationTargetLanguage: z.string(), translationTimeoutMs: z.number(),
  defaultColor: z.string(), historyCapacity: z.number(), maxFileBytes: z.number(),
})

export async function apply(ctx: ClientContext): Promise<void> {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(), 'pdf: client lifetime')
  const bootstrap = z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value: z.object({ namespace: z.string(), settings: settingsSchema,
      translationEngines: z.array(z.object({ id: z.string(), name: z.string(), version: z.string(),
        execution: z.enum(['disabled', 'local', 'remote']), maxInputCharacters: z.number().int().positive().optional() })) }) }),
    z.object({ ok: z.literal(false), error: z.object({ message: z.string() }) }),
  ]).parse(
    await ctx.connection.rpc.call('/api', 'pdf.info', {}, lifetime.signal),
  )
  if (lifetime.signal.aborted || ctx.fiber?.uid === null) return
  if (!bootstrap.ok) throw new Error(bootstrap.error.message)
  const info = bootstrap.value
  const form = ctx.configForms.get(info.namespace)
  const subscribeSettings = (listener: () => void) => form.subscribe(listener)
  const readSettings = () => form.getSnapshot()
  const ocr = createOcrRegistry({
    bridgePath: '/api/pdf-assets/ocr/bridge.js', workerPath: '/api/pdf-assets/ocr/worker.min.js',
    corePath: '/api/pdf-assets/ocr/core', langPath: '/api/pdf-assets/ocr/lang', availableLanguages: ['eng', 'chi_sim'],
  })
  const synchronizeOcr = () => {
    const state = form.getSnapshot()
    const settings = state.value ?? info.settings
    ocr.select({ id: `${info.namespace}/${settings.ocrEngine}`, engineId: settings.ocrEngine,
      configurationRevision: String(state.revision ?? 'initial'), config: {} })
  }
  synchronizeOcr()
  ctx.effect(() => form.subscribe(synchronizeOcr), 'pdf: OCR configuration')
  ctx.effect(() => () => ocr.dispose(), 'pdf: OCR lifecycle')
  ctx.effect(() => ctx.reflect.provide('pdfOcr', ocr), 'pdf: OCR engine registry')
  const translation = createTranslationRegistry({ timeoutMs: 600000, maxInputCharacters: 8192, maxOutputCharacters: 32768 })
  for (const engine of info.translationEngines) if (engine.id !== 'none') translation.register(createHostTranslationEngine(ctx.connection, lifetime.signal, engine))
  const synchronizeTranslation = () => {
    const state = form.getSnapshot()
    const settings = state.value ?? info.settings
    translation.select({ id: `${info.namespace}/${settings.translationEngine}`, engineId: settings.translationEngine,
      configurationRevision: JSON.stringify([settings.translationEngine, settings.translationSourceLanguage,
        settings.translationTargetLanguage, settings.translationTimeoutMs]), config: {} })
  }
  synchronizeTranslation()
  ctx.effect(() => form.subscribe(synchronizeTranslation), 'pdf: translation configuration')
  ctx.effect(() => () => translation.dispose(), 'pdf: translation lifecycle')
  ctx.effect(() => ctx.reflect.provide('pdfTranslation', translation), 'pdf: Client translation engines')
  const dictionary = createNativeDictionary()
  ctx.effect(() => () => dictionary.dispose(), 'pdf: native dictionary lifecycle')
  ctx.effect(() => ctx.reflect.provide('pdfDictionary', dictionary), 'pdf: native dictionary capability')
  const api = createPdfApi(ctx.connection, lifetime.signal)
  ctx.effect(() => ctx.locale.register(NS, {
    zh: { ...readerLocales.zh, ...settingsLocales.zh, title: 'PDF 阅读与标注' },
    en: { ...readerLocales.en, ...settingsLocales.en, title: 'PDF reader & annotations' },
  }), 'pdf: language dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.dshPlugin = ID
    style.textContent = styles
    document.head.append(style)
    return () => style.remove()
  }, 'pdf: reader stylesheet')
  type OwnerProps = Omit<ReaderProps, 'api' | 'ocr' | 'translation' | 'dictionary' | 'settings' | 'openPdf'>
  function PdfSurface(props: OwnerProps) {
    const state = useSyncExternalStore(subscribeSettings, readSettings, readSettings)
    const pdfRuntime = useRef<ReturnType<typeof createPdfRuntime> | null>(null)
    const openDocument = useCallback((bytes: Uint8Array, signal?: AbortSignal) => {
      pdfRuntime.current ??= createPdfRuntime(lifetime.signal)
      return pdfRuntime.current.openPdf(bytes, signal)
    }, [])
    useEffect(() => () => {
      const current = pdfRuntime.current
      pdfRuntime.current = null
      void current?.dispose()
    }, [])
    // Resource addresses carry their own session. The active chat may be different.
    const file = sessionFile(props.resourceAddress)
    return <Reader {...props} sessionId={file.sessionId} api={api} ocr={ocr} translation={translation} dictionary={dictionary} openPdf={openDocument}
      settings={state.value ?? info.settings ?? defaultSettings} />
  }
  function PdfSettingsSection(props: { t: (key: string) => string }) {
    return <Settings t={props.t} form={form} engines={ocr.list().map(engine => ({ id: engine.id, label: engine.name }))}
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
