import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { ReadingSidebarSection } from '../components/ReadingSidebar.js'

export interface ReaderSidebarLayoutOptions {
  bodyRef: RefObject<HTMLDivElement | null>
  navigationLock: RefObject<boolean>
  navigating: boolean
}

/** Auto-collapse is a layout response, separate from the user's explicit sidebar choice. */
export function useReaderSidebarLayout(options: ReaderSidebarLayoutOptions) {
  const { bodyRef, navigationLock, navigating } = options
  const [section, setSection] = useState<ReadingSidebarSection>('annotations')
  const [expanded, setExpanded] = useState(true)
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const autoCollapsed = useRef(false)
  const narrow = useRef<boolean | null>(null)

  const changeExpanded = useCallback((next: boolean) => {
    autoCollapsed.current = false
    expandedRef.current = next
    setExpanded(next)
  }, [])
  const show = useCallback((next: ReadingSidebarSection) => {
    setSection(next)
    changeExpanded(true)
  }, [changeExpanded])

  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    let focusFrame = 0
    const update = () => {
      // Observe the whole pane. Watching just the PDF column would oscillate
      // as sidebar collapse changes its width.
      const isNarrow = body.clientWidth < 760
      if (narrow.current === isNarrow) return
      // Do not unmount an active page field while Enter is in flight.
      if (isNarrow && (body.querySelector('.dsh-pdf-sidebar-page-nav input:focus') || navigationLock.current)) return
      narrow.current = isNarrow
      if (isNarrow && expandedRef.current) {
        autoCollapsed.current = true
        expandedRef.current = false
        setExpanded(false)
      } else if (!isNarrow && autoCollapsed.current) {
        autoCollapsed.current = false
        expandedRef.current = true
        setExpanded(true)
      }
    }
    const afterFocusOut = () => {
      cancelAnimationFrame(focusFrame)
      focusFrame = requestAnimationFrame(update)
    }
    const observer = new ResizeObserver(update)
    observer.observe(body)
    body.addEventListener('focusout', afterFocusOut)
    update()
    return () => {
      observer.disconnect()
      body.removeEventListener('focusout', afterFocusOut)
      cancelAnimationFrame(focusFrame)
    }
  }, [bodyRef, navigating])

  return { section, expanded, changeExpanded, show }
}
