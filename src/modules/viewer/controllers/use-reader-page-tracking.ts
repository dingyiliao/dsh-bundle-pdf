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
  const [currentPage, setCurrentPage] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const views = useRef(new Map<number, PageView>())
  const scrollFrame = useRef<number | undefined>(undefined)
  const latest = useRef({ snapshot, scrollRoot, currentPage, readerElement })
  latest.current = { snapshot, scrollRoot, currentPage, readerElement }

  const registerView = useCallback((number: number, view: PageView | null) => {
    if (view) views.current.set(number, view)
    else views.current.delete(number)
    latest.current.scrollRoot?.dispatchEvent(new Event('pdfviewchange'))
  }, [])
  const scrollRef = useCallback((node: HTMLDivElement | null) => {
    setScrollRoot(node)
    scrollportRef(node)
  }, [scrollportRef])
  const updateScrolledPage = useCallback(() => {
    if (scrollFrame.current !== undefined) return
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = undefined
      const { snapshot: current, scrollRoot: root, currentPage: previousPage, readerElement: reader } = latest.current
      if (!root || !current) return
      const numeric = windowLayout(root)
      if (!numeric?.length) return
      const number = numeric[pageIndexAtOffset(numeric, root.scrollTop + readingPageProbe(root.clientHeight))].page
      if (number === previousPage) return
      setCurrentPage(number)
      // A late layout frame must not overwrite a page number the user is typing.
      if (!reader.current?.querySelector('.dsh-pdf-page-input:focus')) {
        setPageInput(draft => draft === String(previousPage) ? String(number) : draft)
      }
    })
  }, [])
  useEffect(() => () => {
    if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current)
  }, [])

  return { scrollRoot, currentPage, setCurrentPage, pageInput, setPageInput,
    views, registerView, scrollRef, updateScrolledPage }
}
