import { useCallback, useEffect, useRef } from 'react'
import type { WorkspaceSnapshot } from '../../../shared/contracts.js'
import type { PdfReadingContextUpdate, ReaderContextReporter, PdfAgentNavigationApi } from '../ports/reader.js'

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
  onAgentNavigate?: (page: number) => Promise<boolean>
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

  const report = useCallback((update: PdfReadingContextUpdate) => {
    const send = reporter.current
    if (!send) return
    void send(update).catch((failure) => {
      if (!(failure instanceof Error && failure.name === 'AbortError')) {
        console.warn('[pdf] Could not synchronize the active reading page', failure)
      }
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
      if (previous.page !== currentPage) {
        previous.page = currentPage
        report({ action: 'set', sessionId, tabId, leaseId: previous.leaseId,
          documentId: snapshot.id, contentVersion: snapshot.contentVersion, page: currentPage })
      }
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
    const timer = setInterval(() => {
      const current = published.current
      if (current) report({ action: 'set', sessionId, ...current })
    }, 30_000)
    return () => clearInterval(timer)
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
          const valid = latest.current.visible && active?.leaseId === lease.leaseId
            && active.documentId === request.documentId && active.contentVersion === request.contentVersion
          let status: 'opened' | 'stale' | 'unavailable' = valid ? 'unavailable' : 'stale'
          if (valid) {
            try { status = await latest.current.onAgentNavigate?.(request.page) ? 'opened' : 'unavailable' }
            catch { status = 'unavailable' }
          }
          if (!signal.aborted) await navigation.complete({ ...context, requestId: request.requestId, status }, signal)
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
