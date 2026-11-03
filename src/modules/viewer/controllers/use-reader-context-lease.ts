import { useCallback, useEffect, useRef } from 'react'
import type { WorkspaceSnapshot } from '../../../shared/contracts.js'
import type { PdfReadingContextUpdate, ReaderContextReporter, PdfAgentNavigationApi } from '../ports/reader.js'
import type { AgentNavigationRequest } from '../../../contracts/navigation.js'

export interface ReaderContextLeaseOptions {
  sessionId: string
  tabId: string
  visible: boolean
  tabSignal: AbortSignal
  snapshot: WorkspaceSnapshot | null
  currentPage: number
  documentReady: boolean
  enabled: boolean
  report?: ReaderContextReporter
  agentNavigation?: PdfAgentNavigationApi
  onAgentNavigate?: (request: AgentNavigationRequest, signal: AbortSignal) => Promise<'opened' | 'stale' | 'unavailable'>
}

/** Publish only a short-lived page hint, never file authorization or PDF content. */
export function useReaderContextLease(options: ReaderContextLeaseOptions): void {
  const { sessionId, tabId, visible, tabSignal, snapshot, currentPage, documentReady, enabled } = options
  const published = useRef<{ tabId: string; documentId: string; contentVersion: string;
    page: number; leaseId: string } | null>(null)
  const reporter = useRef(options.report)
  reporter.current = options.report
  const latest = useRef(options)
  latest.current = options
  const reportSequence = useRef(0)
  const failures = useRef(0)
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null)

  const report = useCallback(function publish(update: PdfReadingContextUpdate) {
    const sequence = ++reportSequence.current
    if (retry.current !== null) { clearTimeout(retry.current); retry.current = null }
    const send = reporter.current
    if (!send) return
    if (update.action === 'clear') failures.current = 0
    void Promise.resolve().then(() => send(update)).then(() => {
      if (sequence === reportSequence.current) failures.current = 0
    }).catch((failure) => {
      if (sequence !== reportSequence.current || failure instanceof Error && failure.name === 'AbortError') return
      console.warn('[pdf] Could not synchronize the active reading page', failure)
      const current = published.current, state = latest.current
      if (update.action !== 'set' || !current || current.leaseId !== update.leaseId
        || state.sessionId !== update.sessionId || !state.enabled || !state.visible || state.tabSignal.aborted) return
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(failures.current++, 5))
      retry.current = setTimeout(() => {
        retry.current = null
        if (sequence !== reportSequence.current || !published.current) return
        publish({ action: 'set', sessionId: latest.current.sessionId, ...published.current })
      }, delay)
    })
  }, [])
  const clear = useCallback(() => {
    const previous = published.current
    if (!previous) return
    published.current = null
    report({ action: 'clear', sessionId, tabId: previous.tabId, leaseId: previous.leaseId })
  }, [report, sessionId])

  useEffect(() => {
    const ready = enabled && reporter.current && visible && !tabSignal.aborted && snapshot && documentReady
      && currentPage >= 1 && currentPage <= snapshot.document.pageCount
    if (!ready) { clear(); return }
    const previous = published.current
    if (previous && previous.tabId === tabId && previous.documentId === snapshot.id
      && previous.contentVersion === snapshot.contentVersion) {
      previous.page = currentPage
      report({ action: 'set', sessionId, tabId, leaseId: previous.leaseId,
        documentId: snapshot.id, contentVersion: snapshot.contentVersion, page: currentPage })
      return
    }
    clear()
    const next = { tabId, documentId: snapshot.id, contentVersion: snapshot.contentVersion,
      page: currentPage, leaseId: crypto.randomUUID() }
    published.current = next
    report({ action: 'set', sessionId, ...next })
  }, [enabled, options.report, tabId, visible, tabSignal, snapshot?.id, snapshot?.contentVersion,
    snapshot?.reader.bytesHash, snapshot?.reader.generation, snapshot?.document.pageCount,
    documentReady, currentPage, sessionId, clear, report])

  useEffect(() => {
    if (!visible) return
    // An unchanged page still has to refresh the Host's deliberately short TTL.
    const renew = () => {
      const current = published.current
      if (current) report({ action: 'set', sessionId, ...current })
    }
    const visibleAgain = () => { if (document.visibilityState === 'visible') renew() }
    const timer = setInterval(renew, 30_000)
    window.addEventListener('focus', renew)
    window.addEventListener('online', renew)
    document.addEventListener('visibilitychange', visibleAgain)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', renew)
      window.removeEventListener('online', renew)
      document.removeEventListener('visibilitychange', visibleAgain)
    }
  }, [visible, report, sessionId])

  useEffect(() => {
    if (!visible || !enabled || !snapshot || !documentReady || !options.agentNavigation || !options.onAgentNavigate) return
    const controller = new AbortController()
    const signal = AbortSignal.any([tabSignal, controller.signal])
    void (async () => {
      while (!signal.aborted) {
        const lease = published.current
        const navigation = latest.current.agentNavigation
        if (!lease || lease.documentId !== snapshot.id || lease.contentVersion !== snapshot.contentVersion || !navigation) {
          await new Promise(resolve => setTimeout(resolve, 250))
          continue
        }
        const context = { sessionId, tabId: lease.tabId, leaseId: lease.leaseId,
          documentId: lease.documentId, contentVersion: lease.contentVersion }
        try {
          const request = await navigation.wait(context, signal)
          if (!request || signal.aborted) continue
          const active = published.current
          const current = latest.current.snapshot
          const valid = latest.current.visible && active?.leaseId === lease.leaseId
            && active.documentId === request.documentId && active.contentVersion === request.contentVersion
            && current?.id === request.documentId && current.contentVersion === request.contentVersion
          let status: 'opened' | 'stale' | 'unavailable' = valid ? 'unavailable' : 'stale'
          if (valid) {
            const execution = new AbortController(), watching = new AbortController()
            const operationSignal = AbortSignal.any([signal, execution.signal])
            const watchSignal = AbortSignal.any([signal, watching.signal])
            let finished = false
            // The tool may be cancelled after delivery. A tab lifetime alone
            // must not let that obsolete request move the user's reading view.
            void (async () => {
              try {
                while (!watchSignal.aborted && !finished) {
                  const result = await navigation.watchRequest({ ...context, requestId: request.requestId }, watchSignal)
                  if (!result.active && !finished) { execution.abort(); break }
                }
              } catch {
                if (!watchSignal.aborted && !finished) execution.abort()
              }
            })()
            try { status = await latest.current.onAgentNavigate?.(request, operationSignal) ?? 'unavailable' }
            catch { status = 'unavailable' }
            finally { finished = true; watching.abort() }
            if (operationSignal.aborted) status = 'unavailable'
          }
          if (!signal.aborted) await navigation.complete({ ...context, requestId: request.requestId, status,
            ...(request.target ? { targetRevision: request.target.revision, sourceDigest: request.target.sourceDigest } : {}) }, signal)
        } catch (failure) {
          if (signal.aborted) break
          console.warn('[pdf] Could not handle an agent navigation request', failure)
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }
    })()
    return () => controller.abort()
  }, [visible, enabled, tabSignal, snapshot?.id, snapshot?.contentVersion, documentReady,
    options.agentNavigation, sessionId])

  useEffect(() => {
    tabSignal.addEventListener('abort', clear, { once: true })
    return () => { tabSignal.removeEventListener('abort', clear); clear() }
  }, [tabSignal, clear])
}
