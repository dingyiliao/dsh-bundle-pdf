import { useCallback, useEffect, useRef, useState, type RefCallback, type RefObject } from 'react'
import type { WorkspaceSnapshot } from '../../../shared/contracts.js'
import type { PageView } from '../model/reader-selection.js'
import { readingPageProbe } from '../rendering/page-layout.js'
import { pageIndexAtOffset, windowLayout } from '../rendering/window-layout.js'

export interface ReaderPageTrackingOptions {
  snapshot: WorkspaceSnapshot | null
  readerElement: RefObject<HTMLDivElement>
  scrollportRef: RefCallback<HTMLElement>
}

/** Owns visible-page and editable page-number state without waiting for raster tiles. */
export function useReaderPageTracking({ snapshot, readerElement, scrollportRef }: ReaderPageTrackingOptions) {
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null)
  const [currentPage, setCurrentPageState] = useState(1)
  const [pageInput, setPageInputState] = useState('1')
  const hasUnsubmittedPageInput = useRef(false)
  const views = useRef(new Map<number, PageView>())
  const scrollFrame = useRef<number | undefined>(undefined)
  const committedPosition = useRef<{ root: HTMLDivElement; top: number; page: number; documentId: string;
    contentVersion: string; layout: ReturnType<typeof windowLayout> } | null>(null)
  const latest = useRef({ snapshot, scrollRoot, currentPage, readerElement })
  latest.current = { snapshot, scrollRoot, currentPage, readerElement }

  const setCurrentPage = useCallback((page: number) => {
    const { snapshot: current, scrollRoot: root } = latest.current
    // A short document can clamp a jump to its end while the leading edge still
    // intersects the preceding page. Its delayed scroll events must not replace
    // that explicit destination with the preceding visible page.
    committedPosition.current = current && root ? { root, top: root.scrollTop, page, documentId: current.id,
      contentVersion: current.contentVersion, layout: windowLayout(root) } : null
    setCurrentPageState(page)
  }, [])

  const registerView = useCallback((number: number, view: PageView | null) => {
    if (view) views.current.set(number, view)
    else views.current.delete(number)
    latest.current.scrollRoot?.dispatchEvent(new Event('pdfviewchange'))
  }, [])
  const scrollRef = useCallback((node: HTMLDivElement | null) => {
    setScrollRoot(node)
    scrollportRef(node)
  }, [scrollportRef])
  const setPageInput = useCallback((value: string) => {
    hasUnsubmittedPageInput.current = false
    setPageInputState(value)
  }, [])
  const editPageInput = useCallback((value: string) => {
    hasUnsubmittedPageInput.current = true
    setPageInputState(value)
  }, [])
  const updateScrolledPage = useCallback(() => {
    if (scrollFrame.current !== undefined) return
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = undefined
      const { snapshot: current, scrollRoot: root, currentPage: previousPage, readerElement: reader } = latest.current
      if (!root || !current) return
      const numeric = windowLayout(root)
      if (!numeric?.length) return
      const committed = committedPosition.current
      if (committed?.root === root && committed.documentId === current.id && committed.contentVersion === current.contentVersion) {
        const target = numeric[committed.page - 1]
        // Sidebar animation can finish after navigation, replacing an otherwise
        // valid numeric layout and reflowing its scroll anchor. Keep the chosen
        // page when it remains visible; subsequent movement in that settled
        // layout resumes ordinary tracking.
        if (committed.layout !== numeric && target?.page === committed.page
          && target.top + target.height > root.scrollTop + readingPageProbe(root.clientHeight)
          && target.top < root.scrollTop + root.clientHeight) {
          committedPosition.current = { ...committed, layout: numeric, top: root.scrollTop }
          return
        }
        if (committed.layout === numeric && Math.abs(committed.top - root.scrollTop) < 1) return
      }
      committedPosition.current = null
      const number = numeric[pageIndexAtOffset(numeric, root.scrollTop + readingPageProbe(root.clientHeight))].page
      if (number !== previousPage) setCurrentPageState(number)
      // Focus alone is not an edit: Enter leaves the page field focused after
      // committing a jump, so subsequent scrolling must still update it.
      if (hasUnsubmittedPageInput.current && reader.current?.querySelector('.dsh-pdf-page-input:focus')) return
      hasUnsubmittedPageInput.current = false
      setPageInputState(String(number))
    })
  }, [])
  useEffect(() => () => {
    if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current)
  }, [])

  return { scrollRoot, currentPage, setCurrentPage, pageInput, setPageInput, editPageInput,
    views, registerView, scrollRef, updateScrolledPage }
}
