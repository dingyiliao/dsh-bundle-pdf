import { useCallback, useEffect, useRef } from 'react'
import type { WorkspaceSnapshot } from '../../../shared/contracts.js'
import type { PdfReadingContextUpdate, ReaderContextReporter } from '../ports/reader.js'

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
}

/** Publish only a short-lived page hint, never file authorization or PDF content. */
export function useReaderContextLease(options: ReaderContextLeaseOptions): void {
  const { sessionId, tabId, visible, tabSignal, snapshot, currentPage, documentReady, enabled } = options
  const published = useRef<{ tabId: string; documentId: string; contentVersion: string;
    page: number; leaseId: string } | null>(null)
  const reporter = useRef(options.report)
  reporter.current = options.report

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
    tabSignal.addEventListener('abort', clear, { once: true })
    return () => { tabSignal.removeEventListener('abort', clear); clear() }
  }, [tabSignal, clear])
}
