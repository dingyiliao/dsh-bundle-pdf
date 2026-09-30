import { AnnotationMode, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from 'pdfjs-dist'
import { createPdfRuntime } from '../pdf-runtime.js'
import { joinSearchText } from '../reader-search.js'

type OpenPdf = (bytes: Uint8Array, signal?: AbortSignal) => Promise<{
  document: PDFDocumentProxy
  dispose(): Promise<void>
}>

export type PageWarmupState = 'waiting' | 'running' | 'paused' | 'complete' | 'cancelled' | 'failed'

export interface PageWarmupProgress {
  readonly state: PageWarmupState
  readonly total: number
  readonly processed: number
  readonly textIndexed: number
  readonly previewsRendered: number
  readonly errors: number
  readonly cachedTextPages: number
  readonly cachedPreviewPages: number
}

export interface PageWarmupOptions {
  readonly bytes: Uint8Array
  /** Test hook. Production omits this so warmup owns a separate PDF.js worker. */
  readonly openPdf?: OpenPdf
  readonly pageCount: number
  readonly signal?: AbortSignal
  /** The visible page is left until last so its foreground render can finish first. */
  readonly initialPage?: number
  /** Optional foreground-render milestone. The background pass waits for it. */
  readonly startAfter?: Promise<unknown>
  readonly startDelayMs?: number
  readonly renderPreviews?: boolean
  readonly previewWidth?: number
  readonly maxTextChars?: number
  readonly maxPreviewBytes?: number
  readonly onProgress?: (progress: PageWarmupProgress) => void
  readonly onError?: (error: unknown) => void
}

export interface PageWarmupHandle {
  readonly done: Promise<PageWarmupProgress>
  getProgress(): PageWarmupProgress
  /** A cache miss is undefined; an indexed image-only page is the empty string. */
  getText(pageNumber: number): string | undefined
  /** URL remains valid until eviction or cancel; re-read after each progress update. */
  getPreviewUrl(pageNumber: number): string | undefined
  prioritize(pageNumber: number): void
  /** Pause takes effect at the next page/stage boundary. */
  pause(): void
  resume(): void
  /** Cancels active work and releases all retained text and Blob URLs. */
  cancel(): void
}

const DEFAULT_TEXT_CHARS = 8_000_000
const DEFAULT_PREVIEW_BYTES = 32 * 1024 * 1024
const DEFAULT_PREVIEW_WIDTH = 320
const PROGRESS_INTERVAL_MS = 500

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.min(maximum, Math.floor(value)))
}

function pageOrder(count: number, visiblePage: number | undefined): number[] {
  const pages = Array.from({ length: count }, (_, index) => index + 1)
  if (visiblePage && visiblePage >= 1 && visiblePage <= count) {
    pages.splice(visiblePage - 1, 1)
    pages.push(visiblePage)
  }
  return pages
}

/**
 * Experimental all-page preparation. The separate PDF.js document keeps its
 * page proxies and render resources away from the visible document. Work is
 * sequential, idle-scheduled, and the document is destroyed after the pass.
 * PDF.js still retains one proxy per visited page inside this temporary
 * document until that destruction; only text and small preview URLs survive.
 */
export function startExperimentalPageWarmup(options: PageWarmupOptions): PageWarmupHandle {
  if (!Number.isSafeInteger(options.pageCount) || options.pageCount < 0) {
    throw new RangeError('pageCount must be a nonnegative integer')
  }
  const controller = new AbortController()
  const pending = pageOrder(options.pageCount, options.initialPage)
  const prioritized: number[] = []
  const inPriority = new Set<number>()
  const started = new Uint8Array(options.pageCount + 1)
  let nextPending = 0
  const textCache = new Map<number, string>()
  const previewCache = new Map<number, { url: string; bytes: number }>()
  const maxTextChars = bounded(options.maxTextChars, DEFAULT_TEXT_CHARS, 100_000_000)
  const maxPreviewBytes = bounded(options.maxPreviewBytes, DEFAULT_PREVIEW_BYTES, 512 * 1024 * 1024)
  const previewWidth = bounded(options.previewWidth, DEFAULT_PREVIEW_WIDTH, 640)
  const renderPreviews = options.renderPreviews !== false && previewWidth > 0 && maxPreviewBytes > 0 &&
    typeof document !== 'undefined' && typeof URL.createObjectURL === 'function'
  let textChars = 0
  let previewBytes = 0
  let state: PageWarmupState = 'waiting'
  let processed = 0
  let textIndexed = 0
  let previewsRendered = 0
  let errors = 0
  let opened: Awaited<ReturnType<OpenPdf>> | undefined
  let runtime: ReturnType<typeof createPdfRuntime> | undefined
  let closedDocument: Awaited<ReturnType<OpenPdf>> | undefined
  let documentClosing: Promise<void> | undefined
  let runtimeClosing: Promise<void> | undefined
  let activeRender: RenderTask | undefined
  let progressTimer: ReturnType<typeof setTimeout> | undefined
  const resumeWaiters = new Set<() => void>()

  const snapshot = (): PageWarmupProgress => ({
    state, total: options.pageCount, processed, textIndexed, previewsRendered, errors,
    cachedTextPages: textCache.size, cachedPreviewPages: previewCache.size,
  })
  const reportError = (error: unknown): void => {
    errors++
    try { options.onError?.(error) } catch { /* Observer callbacks cannot stop warmup. */ }
  }
  const notify = (): void => {
    progressTimer = undefined
    try { options.onProgress?.(snapshot()) } catch { /* Observer callbacks cannot stop warmup. */ }
  }
  const report = (immediate = false): void => {
    if (!options.onProgress) return
    if (immediate) {
      if (progressTimer) clearTimeout(progressTimer)
      notify()
    } else if (!progressTimer) progressTimer = setTimeout(notify, PROGRESS_INTERVAL_MS)
  }
  const releaseCache = (): void => {
    textCache.clear()
    textChars = 0
    for (const { url } of previewCache.values()) URL.revokeObjectURL(url)
    previewCache.clear()
    previewBytes = 0
  }
  const retainText = (pageNumber: number, value: string): void => {
    if (maxTextChars === 0) return
    if (value.length > maxTextChars) return
    while (textChars + value.length > maxTextChars && textCache.size) {
      const oldest = textCache.keys().next().value as number
      textChars -= textCache.get(oldest)!.length
      textCache.delete(oldest)
    }
    textCache.set(pageNumber, value)
    textChars += value.length
  }
  const retainPreview = (pageNumber: number, blob: Blob): void => {
    if (blob.size > maxPreviewBytes) return
    while (previewBytes + blob.size > maxPreviewBytes && previewCache.size) {
      const oldest = previewCache.keys().next().value as number
      const discarded = previewCache.get(oldest)!
      previewBytes -= discarded.bytes
      URL.revokeObjectURL(discarded.url)
      previewCache.delete(oldest)
    }
    const url = URL.createObjectURL(blob)
    previewCache.set(pageNumber, { url, bytes: blob.size })
    previewBytes += blob.size
  }
  const releaseWaiters = (): void => {
    for (const resolve of resumeWaiters) resolve()
    resumeWaiters.clear()
  }
  const cancelled = (): boolean => controller.signal.aborted
  const waitWhilePaused = async (): Promise<void> => {
    while (state === 'paused' && !cancelled()) {
      await new Promise<void>((resolve) => { resumeWaiters.add(() => resolve()) })
    }
    controller.signal.throwIfAborted()
  }
  const waitTimer = (delayMs: number): Promise<void> => new Promise((resolve) => {
    if (cancelled()) { resolve(); return }
    const timer = setTimeout(finish, delayMs)
    function finish(): void {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', finish)
      resolve()
    }
    controller.signal.addEventListener('abort', finish, { once: true })
  })
  const waitIdle = (): Promise<void> => new Promise((resolve) => {
    if (cancelled()) { resolve(); return }
    let idleId: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    function finish(): void {
      if (idleId !== undefined && typeof cancelIdleCallback === 'function') cancelIdleCallback(idleId)
      if (timer) clearTimeout(timer)
      controller.signal.removeEventListener('abort', finish)
      resolve()
    }
    if (typeof requestIdleCallback === 'function') idleId = requestIdleCallback(finish, { timeout: 750 })
    else timer = setTimeout(finish, 0)
    controller.signal.addEventListener('abort', finish, { once: true })
  })
  const waitForStart = async (): Promise<void> => {
    if (options.startAfter) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { controller.signal.removeEventListener('abort', abort); resolve() }
        controller.signal.addEventListener('abort', abort, { once: true })
        void options.startAfter!.then(
          () => { controller.signal.removeEventListener('abort', abort); resolve() },
          error => { controller.signal.removeEventListener('abort', abort); reject(error) },
        )
      })
    }
    await waitTimer(bounded(options.startDelayMs, 300, 10_000))
    await waitIdle()
    controller.signal.throwIfAborted()
  }
  const makePreview = async (page: PDFPageProxy): Promise<Blob> => {
    const base = page.getViewport({ scale: 1 })
    const scale = Math.min(1, previewWidth / Math.max(1, base.width), 480 / Math.max(1, base.height))
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.ceil(viewport.width))
    canvas.height = Math.max(1, Math.ceil(viewport.height))
    try {
      activeRender = page.render({ canvas, viewport, annotationMode: AnnotationMode.ENABLE })
      const task = activeRender
      // PDF.js executes the canvas operator list in chunks. Let foreground
      // frames run between chunks, and honor a pause during a long page.
      task.onContinue = (continueRender: () => void) => {
        void waitWhilePaused().then(waitIdle).then(() => {
          controller.signal.throwIfAborted()
          continueRender()
        }).catch(() => task.cancel())
      }
      await activeRender.promise
      controller.signal.throwIfAborted()
      return await new Promise<Blob>((resolve, reject) => canvas.toBlob(
        value => value ? resolve(value) : reject(new Error(`Could not encode preview for page ${page.pageNumber}`)),
        'image/webp', 0.7,
      ))
    } finally {
      activeRender = undefined
      canvas.width = 0
      canvas.height = 0
    }
  }
  const closeDocument = (): Promise<void> => {
    if (!opened) return Promise.resolve()
    if (closedDocument !== opened) {
      const target = opened
      closedDocument = target
      documentClosing = Promise.resolve().then(() => target.dispose()).finally(() => {
        if (opened === target) opened = undefined
      })
    }
    return documentClosing!
  }
  const closeRuntime = (): Promise<void> => {
    if (!runtime) return Promise.resolve()
    if (!runtimeClosing) {
      const target = runtime
      runtimeClosing = Promise.resolve().then(() => target.dispose()).finally(() => {
        if (runtime === target) runtime = undefined
      })
    }
    return runtimeClosing
  }
  const cancel = (): void => {
    if (!cancelled()) controller.abort(new DOMException('Page warmup cancelled', 'AbortError'))
    activeRender?.cancel()
    releaseWaiters()
    releaseCache()
    if (state !== 'complete' && state !== 'failed') state = 'cancelled'
    report(true)
    options.signal?.removeEventListener('abort', externalAbort)
    void closeDocument().catch(() => undefined)
    void closeRuntime().catch(() => undefined)
  }
  const externalAbort = (): void => cancel()
  options.signal?.addEventListener('abort', externalAbort, { once: true })
  if (options.signal?.aborted) cancel()

  const nextPage = (): number | undefined => {
    while (prioritized.length) {
      const pageNumber = prioritized.pop()!
      inPriority.delete(pageNumber)
      if (started[pageNumber] === 0) { started[pageNumber] = 1; return pageNumber }
    }
    while (nextPending < pending.length) {
      const pageNumber = pending[nextPending++]!
      if (started[pageNumber] === 0) { started[pageNumber] = 1; return pageNumber }
    }
    return undefined
  }

  const done = (async (): Promise<PageWarmupProgress> => {
    try {
      controller.signal.throwIfAborted()
      if (options.pageCount === 0) {
        state = 'complete'
        return snapshot()
      }
      await waitForStart()
      await waitWhilePaused()
      state = 'running'
      report(true)
      // The foreground runtime's openPdf shares its worker. A private runtime
      // prevents full-document text extraction from blocking visible painting.
      runtime = options.openPdf ? undefined : createPdfRuntime(controller.signal)
      opened = await (options.openPdf ?? runtime!.openPdf)(options.bytes, controller.signal)
      if (opened.document.numPages !== options.pageCount) {
        throw new Error(`Page count changed during warmup (${options.pageCount} to ${opened.document.numPages})`)
      }
      while (processed < options.pageCount) {
        await waitWhilePaused()
        await waitIdle()
        controller.signal.throwIfAborted()
        const pageNumber = nextPage()
        if (pageNumber === undefined) break
        let page: PDFPageProxy | undefined
        try {
          page = await opened.document.getPage(pageNumber)
          controller.signal.throwIfAborted()
          const content = await page.getTextContent()
          controller.signal.throwIfAborted()
          const items = content.items.filter((item): item is Extract<typeof item, { str: string }> => 'str' in item)
          retainText(pageNumber, joinSearchText(items).text)
          textIndexed++
          if (renderPreviews) {
            await waitWhilePaused()
            await waitIdle()
            controller.signal.throwIfAborted()
            const blob = await makePreview(page)
            controller.signal.throwIfAborted()
            retainPreview(pageNumber, blob)
            previewsRendered++
          }
        } catch (error) {
          if (cancelled()) throw error
          reportError(error)
        } finally {
          // This drops render operator lists; PDF.js itself keeps page proxies
          // until the temporary document is destroyed at the end of the pass.
          try {
            if (page && !page.cleanup() && !cancelled()) {
              reportError(new Error(`Could not clean up page ${pageNumber} after warmup`))
            }
          } catch (error) {
            if (!cancelled()) reportError(error)
          }
          if (!cancelled()) processed++
          report()
        }
      }
      state = 'complete'
    } catch (error) {
      if (cancelled()) state = 'cancelled'
      else { state = 'failed'; reportError(error) }
    } finally {
      if (progressTimer) clearTimeout(progressTimer)
      try { await closeDocument() } catch (error) { if (!cancelled()) reportError(error) }
      try { await closeRuntime() } catch (error) { if (!cancelled()) reportError(error) }
      report(true)
    }
    return snapshot()
  })()

  return {
    done,
    getProgress: snapshot,
    getText(pageNumber) {
      const value = textCache.get(pageNumber)
      if (value !== undefined) { textCache.delete(pageNumber); textCache.set(pageNumber, value) }
      return value
    },
    getPreviewUrl(pageNumber) {
      const value = previewCache.get(pageNumber)
      if (value) { previewCache.delete(pageNumber); previewCache.set(pageNumber, value) }
      return value?.url
    },
    prioritize(pageNumber) {
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > options.pageCount ||
        started[pageNumber] !== 0 || inPriority.has(pageNumber)) return
      inPriority.add(pageNumber)
      prioritized.push(pageNumber)
    },
    pause() {
      if (state !== 'waiting' && state !== 'running') return
      state = 'paused'
      report(true)
    },
    resume() {
      if (state !== 'paused') return
      state = 'running'
      releaseWaiters()
      report(true)
    },
    cancel,
  }
}
