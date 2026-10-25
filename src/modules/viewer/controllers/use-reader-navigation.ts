import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PdfPageInfo } from '../../../core/pdf-types.js'
import type { NavigationPosition } from '../../../navigation/index.js'
import type { PdfClientApi, WorkspaceSnapshot } from '../../../shared/contracts.js'
import type { NativeDocument } from '../rendering/document.js'
import type { PageView } from '../model/reader-selection.js'
import type { ReaderLifetime } from './reader-lifetime.js'
import { windowLayout } from '../rendering/window-layout.js'
import { readingSafeTop } from '../rendering/page-layout.js'
import { waitForReaderState } from './wait-for-reader-state.js'
import { applyIfNoNewerNavigation } from './reading-resume.js'
import { captureReaderPosition, readerPageScale, resolvePdfDestination, type ReaderViewportState } from './navigation-position.js'
import type { ReaderNavigationGuard } from './agent-text-navigation.js'

export interface ReaderNavigationOptions {
  api: PdfClientApi
  sessionId: string
  tabSignal: AbortSignal
  contentRevision: number
  pdf: NativeDocument | null
  snapshot: WorkspaceSnapshot | null
  scrollRoot: HTMLDivElement | null
  currentPage: number
  historyCapacity: number
  lifetime: ReaderLifetime
  state: React.MutableRefObject<ReaderViewportState>
  views: React.MutableRefObject<Map<number, PageView>>
  setCurrentPage(page: number): void
  setPageInput(page: string): void
  setZoom(zoom: number): void
  setFit(fit: ReaderViewportState['fit']): void
  setPositionNotice(notice: string): void
  onError(error: unknown): void
  t(key: string): string
}

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
const navigationTimeoutMs = 45_000
const positionWriteDelayMs = 1_000
const isAbortError = (value: unknown) => value instanceof Error && value.name === 'AbortError'

/** Owns navigation lock, history, resume and position writes for one tab occurrence. */
export function useReaderNavigation(options: ReaderNavigationOptions) {
  const { api, sessionId, tabSignal, pdf, snapshot, scrollRoot, currentPage, lifetime, state, views } = options
  const latest = useRef(options)
  latest.current = options
  const history = useRef(lifetime.history)
  const [historyRevision, setHistoryRevision] = useState(0)
  const [navigating, setNavigating] = useState(false)
  const [navigationTarget, setNavigationTarget] = useState<{ page: number } | null>(null)
  const restored = useRef(false)
  const positionReady = useRef(false)
  const navigationIntent = useRef(0)
  const resumeFailed = useRef(false)
  const navigationCompleted = useRef(0)
  const navigationLock = useRef(false)
  const activeNavigation = useRef<AbortController | null>(null)
  const pendingJump = useRef<{ page: number; options: Partial<NavigationPosition>; remember: boolean } | null>(null)
  const documentNavigation = useRef(new AbortController())
  const historySnapshot = useMemo(() => history.current.snapshot(), [historyRevision])

  const pageScale = useCallback((page: PdfPageInfo, fit = state.current.fit, zoom = state.current.zoom) =>
    readerPageScale(page, state.current, fit, zoom), [state])
  const capture = useCallback((): NavigationPosition => captureReaderPosition(state.current, views.current,
    latest.current.t('reader.notReady')), [state, views])

  const applyPosition = useCallback(async (position: NavigationPosition, signal: AbortSignal, validate?: () => void) => {
    validate?.()
    const current = state.current
    if (!pdf || !current.snapshot || position.documentVersion !== current.snapshot.contentVersion
      || !current.snapshot.document.pages[position.page - 1]) throw new Error(latest.current.t('reader.invalidDestination'))
    const originDocument = current.snapshot
    const documentSignal = documentNavigation.current.signal
    const operationSignal = AbortSignal.any([signal, documentSignal])
    const origin = { zoom: current.zoom, fit: current.fit, page: current.currentPage,
      left: current.scrollRoot?.scrollLeft ?? 0, top: current.scrollRoot?.scrollTop ?? 0 }
    const target = { page: position.page }
    setNavigationTarget(target)
    try {
      // Fit modes derive scale from the viewport; only custom fit owns zoom.
      if (position.fit === 'custom') latest.current.setZoom(position.scale)
      latest.current.setFit(position.fit)
      await nextFrame(); await nextFrame()
      operationSignal.throwIfAborted()
      validate?.()
      const root = state.current.scrollRoot
      if (!root) throw new Error(latest.current.t('reader.invalidDestination'))
      const geometry = originDocument.document.pages[position.page - 1]!
      const deadline = performance.now() + navigationTimeoutMs
      const remaining = () => Math.max(0, deadline - performance.now())
      const numericPage = await waitForReaderState(root, 'pdflayoutchange', () => {
        validate?.()
        const page = windowLayout(root)?.[position.page - 1]
        return page?.page === position.page && Math.abs(page.scale - pageScale(geometry, position.fit, position.scale)) < 0.001
          ? page : undefined
      }, operationSignal, remaining())
      operationSignal.throwIfAborted()
      validate?.()
      // Reveal a distant narrow page before waiting for its windowed PageView.
      const targetLeft = (root.scrollWidth - numericPage.width) / 2
      if (targetLeft + numericPage.width <= root.scrollLeft || targetLeft >= root.scrollLeft + root.clientWidth) {
        root.scrollLeft = Math.max(0, (root.scrollWidth - root.clientWidth) / 2)
      }
      root.scrollTop = numericPage.top
      const view = await waitForReaderState(root, 'pdfviewchange', () => {
        validate?.()
        const candidate = views.current.get(position.page)
        const expected = pageScale(geometry, position.fit, position.scale)
        return candidate && Math.abs(candidate.viewport.scale - expected) < 0.001
          && candidate.viewport.rotation === ((geometry.rotation % 360) + 360) % 360 ? candidate : undefined
      }, operationSignal, remaining())
      operationSignal.throwIfAborted()
      validate?.()
      const [x, y] = view.viewport.convertToViewportPoint(position.x, position.y)
      const bounds = root.getBoundingClientRect(), pageBounds = view.element.getBoundingClientRect()
      root.scrollLeft += pageBounds.left + x - bounds.left - (position.viewportAnchor?.x ?? 0) * bounds.width
      root.scrollTop += pageBounds.top + y - bounds.top - (position.viewportAnchor?.y ?? 0) * bounds.height
      latest.current.setCurrentPage(position.page)
      latest.current.setPageInput(String(position.page))
      await nextFrame()
      operationSignal.throwIfAborted()
      validate?.()
      return { ...position, scale: view.viewport.scale }
    } catch (failure) {
      // A superseded request cannot restore the scroll of a newer document.
      const canRestore = () => !tabSignal.aborted && !documentSignal.aborted
        && originDocument.id === state.current.snapshot?.id
        && originDocument.contentVersion === state.current.snapshot?.contentVersion
      if (canRestore()) {
        latest.current.setZoom(origin.zoom); latest.current.setFit(origin.fit)
        await nextFrame(); await nextFrame()
        if (canRestore() && state.current.scrollRoot) {
          state.current.scrollRoot.scrollLeft = origin.left
          state.current.scrollRoot.scrollTop = origin.top
          latest.current.setCurrentPage(origin.page)
          latest.current.setPageInput(String(origin.page))
        }
      }
      operationSignal.throwIfAborted()
      if (failure instanceof Error && failure.name === 'TimeoutError') throw new Error(latest.current.t('reader.pageLoadTimeout'), { cause: failure })
      throw failure
    } finally {
      setNavigationTarget(active => active === target ? null : active)
    }
  }, [pageScale, pdf, tabSignal, state, views])

  const writePosition = useCallback((position: NavigationPosition, signal?: AbortSignal) => {
    const documentId = state.current.snapshot?.id
    if (!documentId || !positionReady.current || navigationLock.current) return
    const { documentVersion: _documentVersion, ...stored } = position
    const current = latest.current
    void current.api.positions.set(current.sessionId, documentId, stored, signal).catch((failure: unknown) => {
      if (!isAbortError(failure)) console.warn('[pdf] Could not remember the reading position', failure)
    })
  }, [state])
  const rememberPosition = useCallback(() => {
    if (!positionReady.current || navigationLock.current || !state.current.scrollRoot) return
    let position: NavigationPosition
    try { position = capture() } catch { return }
    writePosition(position, tabSignal)
  }, [capture, writePosition, state, tabSignal])

  const jump = useCallback(async (page: number, jumpOptions: Partial<NavigationPosition> = {}, remember = true,
    guard?: ReaderNavigationGuard): Promise<boolean> => {
    if (guard?.signal.aborted) return false
    // A model request must not enqueue a delayed, unvalidated jump or cancel
    // an in-progress user navigation. It can retry against the settled view.
    if (navigationLock.current && guard) return false
    navigationIntent.current++
    if (navigationLock.current) {
      pendingJump.current = { page, options: jumpOptions, remember }
      activeNavigation.current?.abort()
      return false
    }
    const controller = new AbortController()
    activeNavigation.current = controller
    navigationLock.current = true
    setNavigating(true)
    let completed = false
    try {
      guard?.validate()
      const current = state.current
      const geometry = current.snapshot?.document.pages[page - 1]
      if (!geometry) throw new Error(latest.current.t('reader.invalidDestination'))
      const safeTop = current.scrollRoot ? readingSafeTop(current.scrollRoot.clientHeight) : 0
      const target: NavigationPosition = { ...capture(), page, x: geometry.cropBox[0], y: geometry.cropBox[3],
        viewportAnchor: { x: 0, y: current.scrollRoot ? safeTop / current.scrollRoot.clientHeight : 0 }, ...jumpOptions }
      const signal = AbortSignal.any([tabSignal, controller.signal, ...(guard ? [guard.signal] : [])])
      const apply = (position: NavigationPosition, operationSignal: AbortSignal) => applyPosition(position, operationSignal, guard?.validate)
      if (remember) {
        const result = await history.current.jump(target, { capture, apply }, signal)
        completed = (result.status === 'changed' || result.status === 'noop') && !signal.aborted
      } else {
        await apply(target, signal)
        completed = !signal.aborted
      }
      if (completed) { navigationCompleted.current++; setHistoryRevision(n => n + 1) }
    } catch (failure) {
      if (!tabSignal.aborted && !isAbortError(failure)) latest.current.onError(failure)
    } finally {
      if (activeNavigation.current === controller) activeNavigation.current = null
      navigationLock.current = false
      const next = pendingJump.current
      pendingJump.current = null
      if (next && !tabSignal.aborted) void jump(next.page, next.options, next.remember)
      else {
        setNavigating(false)
        if (completed && resumeFailed.current) { resumeFailed.current = false; positionReady.current = true }
        rememberPosition()
      }
    }
    return completed
  }, [capture, applyPosition, rememberPosition, tabSignal, state])

  useEffect(() => {
    pendingJump.current = null
    activeNavigation.current?.abort()
    documentNavigation.current.abort()
    const controller = new AbortController()
    documentNavigation.current = controller
    return () => controller.abort()
  }, [snapshot?.id, snapshot?.contentVersion, options.contentRevision, pdf])

  useEffect(() => { history.current.setCapacity(options.historyCapacity); setHistoryRevision(n => n + 1) }, [options.historyCapacity])

  useEffect(() => {
    if (!pdf || !snapshot || !scrollRoot || restored.current) return
    restored.current = true
    const saved = lifetime.position
    if (saved && saved.documentVersion === snapshot.contentVersion) {
      const completedBeforeRestore = navigationCompleted.current
      void jump(saved.page, saved, false).then(completed => {
        if (!completed && navigationCompleted.current === completedBeforeRestore) { resumeFailed.current = true; return }
        positionReady.current = true
        rememberPosition()
      })
      return
    }
    const controller = new AbortController()
    const documentId = snapshot.id
    const completedBeforeRestore = navigationCompleted.current
    let restoreFailed = false
    void applyIfNoNewerNavigation(
      () => api.positions.get(sessionId, documentId, controller.signal),
      () => navigationIntent.current, controller.signal,
      async stored => {
        if (stored === null || stored.stale !== 'none') {
          if (stored) latest.current.setPositionNotice(latest.current.t(stored.stale === 'page-missing'
            ? 'reader.resumePageMissing' : 'reader.resumeContentChanged'))
          return
        }
        if (stored.position.page > snapshot.document.pageCount) { restoreFailed = true; return }
        restoreFailed = !await jump(stored.position.page, { ...stored.position, documentVersion: snapshot.contentVersion }, false)
      },
    ).then(applied => { if (!applied) restoreFailed = true }).catch((failure: unknown) => {
      restoreFailed = true
      if (!isAbortError(failure)) console.warn('[pdf] Could not read the remembered reading position', failure)
    }).finally(() => {
      if (controller.signal.aborted) return
      if (restoreFailed && navigationCompleted.current === completedBeforeRestore) { resumeFailed.current = true; return }
      positionReady.current = true
      rememberPosition()
    })
    return () => controller.abort()
  }, [pdf, snapshot?.id, scrollRoot, jump, lifetime, api, sessionId, rememberPosition])

  useEffect(() => {
    if (!pdf || !snapshot || !scrollRoot) return
    let timer: number | null = null
    const schedule = () => {
      if (timer !== null) return
      timer = window.setTimeout(() => { timer = null; rememberPosition() }, positionWriteDelayMs)
    }
    scrollRoot.addEventListener('scroll', schedule, { passive: true })
    return () => {
      scrollRoot.removeEventListener('scroll', schedule)
      if (timer !== null) { clearTimeout(timer); timer = null }
    }
  }, [pdf, snapshot?.id, scrollRoot, rememberPosition])

  useEffect(() => { if (pdf && snapshot) rememberPosition() }, [currentPage, pdf, snapshot?.id, rememberPosition])

  const destination = useCallback(async (value: unknown) => {
    try {
      if (!pdf) return
      const current = state.current.snapshot
      if (!current) throw new Error(latest.current.t('reader.invalidDestination'))
      const resolved = await resolvePdfDestination(pdf, current, state.current.size, value, latest.current.t('reader.invalidDestination'))
      await jump(resolved.page, resolved.options)
    } catch (failure) { latest.current.onError(failure) }
  }, [pdf, jump, state])

  const navigateHistory = (depth?: number, revision?: number) => {
    navigationIntent.current++
    if (navigationLock.current) return
    const controller = new AbortController()
    activeNavigation.current = controller
    navigationLock.current = true
    setNavigating(true)
    const signal = AbortSignal.any([tabSignal, controller.signal])
    const operation = depth === undefined ? history.current.back({ apply: applyPosition }, signal)
      : history.current.backTo(depth, revision!, { apply: applyPosition }, signal)
    let completed = false
    void operation.then(result => {
      if (result.status !== 'changed') return
      completed = true
      navigationCompleted.current++
      setHistoryRevision(n => n + 1)
    }).catch(failure => {
      if (!tabSignal.aborted && !isAbortError(failure)) latest.current.onError(failure)
    }).finally(() => {
      if (activeNavigation.current === controller) activeNavigation.current = null
      navigationLock.current = false
      const next = pendingJump.current
      pendingJump.current = null
      if (next && !tabSignal.aborted) void jump(next.page, next.options, next.remember)
      else {
        setNavigating(false)
        if (completed && resumeFailed.current) { resumeFailed.current = false; positionReady.current = true }
        rememberPosition()
      }
    })
  }

  const resetForDocument = (version: string): boolean => {
    const reset = history.current.resetForDocument(version)
    setHistoryRevision(n => n + 1)
    return reset
  }
  const persistOnUnmount = () => {
    try {
      const position = capture()
      lifetime.position = position
      writePosition(position)
    } catch { /* No page loaded yet. */ }
  }

  return { pageScale, capture, jump, destination, navigateHistory, resetForDocument, persistOnUnmount,
    navigationLock, navigationTarget, navigating, historySnapshot, canGoBack: history.current.canGoBack }
}
