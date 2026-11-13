import { useEffect, useRef, useState } from 'react'
import type { PdfRect } from '../../../core/pdf-types.js'
import type { WorkspaceSnapshot } from '../../../shared/contracts.js'
import type { ReaderLifetime, OcrPage, OcrTranscript } from './reader-lifetime.js'
import type { HostOcrApi, HostOcrAvailability } from '../ports/ocr.js'

export interface ReaderOcrOptions {
  api: HostOcrApi
  sessionId: string
  visible: boolean
  tabSignal: AbortSignal
  snapshot: WorkspaceSnapshot | null
  currentPage: number
  lifetime: ReaderLifetime
  screenshot: unknown | null
  t(key: string): string
  currentSnapshot(): WorkspaceSnapshot | null
  onError(error: unknown): void
  onRecognized(): void
}

/** OCR state belongs to the tab occurrence; a hidden React mount only cancels work. */
export function useReaderOcr(options: ReaderOcrOptions) {
  const { api, sessionId, visible, tabSignal, lifetime, screenshot, t } = options
  const [ocrPages, setOcrPages] = useState<Map<number, OcrPage>>(() => lifetime.ocrPages)
  const [ocrAvailability, setOcrAvailability] = useState<HostOcrAvailability | null>(null)
  const [ocrTranscript, setOcrTranscript] = useState<OcrTranscript | null>(() => lifetime.ocrTranscript ?? null)
  const [ocrProgress, setOcrProgress] = useState<'preparing' | 'recognizing' | 'cancelling' | null>(null)
  const controller = useRef<AbortController | null>(null)
  const refreshAvailability = useRef<(() => void) | null>(null)
  const callbacks = useRef(options)
  callbacks.current = options

  useEffect(() => {
    if (!visible) {
      controller.current?.abort()
      setOcrAvailability(null)
      return
    }
    let active = true
    let request: AbortController | null = null
    const refresh = async () => {
      request?.abort()
      const next = new AbortController()
      request = next
      try {
        const value = await api.availability(sessionId, AbortSignal.any([next.signal, tabSignal]))
        if (active && !next.signal.aborted) setOcrAvailability(value)
      } catch (cause) {
        if (active && !next.signal.aborted && !tabSignal.aborted) {
          setOcrAvailability({ status: 'unavailable',
            reason: cause instanceof Error ? cause.message : t('reader.ocrConnectionUnavailable') })
        }
      }
    }
    refreshAvailability.current = () => { void refresh() }
    void refresh()
    // The Host is the capability authority. Model changes need no reader remount.
    const timer = setInterval(() => { void refresh() }, 15_000)
    window.addEventListener('focus', refresh)
    return () => {
      active = false
      refreshAvailability.current = null
      request?.abort()
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [api, sessionId, visible, tabSignal, t])

  useEffect(() => { if (screenshot) refreshAvailability.current?.() }, [screenshot])
  useEffect(() => { lifetime.ocrPages = ocrPages }, [ocrPages, lifetime])
  useEffect(() => { lifetime.ocrTranscript = ocrTranscript }, [ocrTranscript, lifetime])
  useEffect(() => () => { controller.current?.abort() }, [])
  useEffect(() => { controller.current?.abort() }, [options.snapshot?.id, options.snapshot?.contentVersion])

  const resetContent = () => {
    controller.current?.abort()
    setOcrPages(new Map())
    setOcrTranscript(null)
  }

  const recognize = async (requestedRegion?: { page: number; rect: PdfRect }) => {
    const { snapshot, currentPage, onError, onRecognized, currentSnapshot } = callbacks.current
    if (!snapshot || controller.current) return
    const task = new AbortController()
    controller.current = task
    const version = snapshot.contentVersion
    const region = requestedRegion
    const page = region?.page ?? currentPage
    setOcrProgress('preparing')
    const stop = () => task.abort()
    tabSignal.addEventListener('abort', stop, { once: true })
    try {
      const availability = await api.availability(sessionId, task.signal)
      task.signal.throwIfAborted()
      setOcrAvailability(availability)
      if (availability.status !== 'available') {
        onError(new Error(availability.reason ?? t('reader.ocrUnavailable')))
        return
      }
      setOcrProgress('recognizing')
      const result = await api.recognize({ sessionId, documentId: snapshot.id, page,
        ...(region ? { region: region.rect } : {}) }, task.signal)
      task.signal.throwIfAborted()
      const current = currentSnapshot()
      if (!current || current.id !== result.documentId || current.contentVersion !== version
        || result.contentVersion !== version || current.revision !== result.revision) {
        onError(new Error(t('reader.ocrStale')))
        return
      }
      // A transcript without word boxes must not be presented as a PDF text layer.
      setOcrTranscript({ result, ...(region ? { region: region.rect } : {}) })
      if (!region) setOcrPages(previous => {
        const next = new Map(previous)
        next.delete(page)
        next.set(page, { words: [], text: result.text, engine: result.source.backendId, warnings: result.warnings })
        while (next.size > 64) next.delete(next.keys().next().value!)
        return next
      })
      onRecognized()
    } catch (failure) {
      if (!task.signal.aborted) onError(failure)
    } finally {
      tabSignal.removeEventListener('abort', stop)
      if (controller.current === task) {
        controller.current = null
        setOcrProgress(null)
      }
    }
  }

  const cancel = () => {
    if (!controller.current || controller.current.signal.aborted) return
    controller.current.abort()
    setOcrProgress('cancelling')
  }

  return { ocrPages, ocrAvailability, ocrTranscript, ocrProgress, recognize, cancel, resetContent,
    refreshAvailability: () => refreshAvailability.current?.() }
}
