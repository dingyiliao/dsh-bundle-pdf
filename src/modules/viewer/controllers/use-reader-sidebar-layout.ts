import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { readingSidebarSections, type ReadingSidebarSection } from '../components/ReadingSidebar.js'

export interface ReaderSidebarLayoutOptions {
  bodyRef: RefObject<HTMLDivElement | null>
  navigationLock: RefObject<boolean>
  navigating: boolean
  resourceAddress: string
  visible: boolean
}

interface SidebarLayout {
  section: ReadingSidebarSection
  expanded: boolean
  autoCollapsed: boolean
  narrow: boolean | null
}

const storageKey = (resourceAddress: string) => `dsh-pdf:sidebar-layout:v2:${resourceAddress}`

function readLayout(resourceAddress: string): SidebarLayout {
  const fallback: SidebarLayout = { section: 'annotations', expanded: true, autoCollapsed: false, narrow: null }
  try {
    const raw = window.sessionStorage.getItem(storageKey(resourceAddress))
    if (!raw) return fallback
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return fallback
    const layout = value as Partial<SidebarLayout>
    if (!readingSidebarSections.includes(layout.section as ReadingSidebarSection) || typeof layout.expanded !== 'boolean'
      || typeof layout.autoCollapsed !== 'boolean'
      || (layout.narrow !== null && typeof layout.narrow !== 'boolean')) return fallback
    return layout as SidebarLayout
  } catch {
    return fallback
  }
}

/** Auto-collapse is a layout response, separate from the user's explicit sidebar choice. */
export function useReaderSidebarLayout(options: ReaderSidebarLayoutOptions) {
  const { bodyRef, navigationLock, navigating, resourceAddress, visible } = options
  const [layout, setLayout] = useState(() => readLayout(resourceAddress))
  const layoutResource = useRef(resourceAddress)

  const changeExpanded = useCallback((next: boolean) => {
    setLayout(current => ({ ...current, expanded: next, autoCollapsed: false }))
  }, [])
  const show = useCallback((next: ReadingSidebarSection) => {
    setLayout(current => ({ ...current, section: next, expanded: true, autoCollapsed: false }))
  }, [])

  useEffect(() => {
    if (layoutResource.current !== resourceAddress) return
    try { window.sessionStorage.setItem(storageKey(resourceAddress), JSON.stringify(layout)) } catch { /* Storage may be unavailable. */ }
  }, [resourceAddress, layout])

  // DSH may keep file tabs mounted while hidden. Reapply the latest choice when
  // this tab becomes active instead of showing its stale local sidebar state.
  useEffect(() => {
    if (!visible) return
    layoutResource.current = resourceAddress
    setLayout(readLayout(resourceAddress))
  }, [resourceAddress, visible])

  useEffect(() => {
    if (!visible) return
    const body = bodyRef.current
    if (!body) return
    let focusFrame = 0
    const update = () => {
      // Observe the whole pane. Watching just the PDF column would oscillate
      // as sidebar collapse changes its width.
      const isNarrow = body.clientWidth < 760
      // Do not unmount an active page field while Enter is in flight.
      if (isNarrow && (body.querySelector('.dsh-pdf-sidebar-page-nav input:focus') || navigationLock.current)) return
      setLayout(current => {
        if (current.narrow === isNarrow) return current
        if (isNarrow && current.expanded) return { ...current, narrow: true, expanded: false, autoCollapsed: true }
        if (!isNarrow && current.autoCollapsed) return { ...current, narrow: false, expanded: true, autoCollapsed: false }
        return { ...current, narrow: isNarrow }
      })
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
  }, [bodyRef, navigating, visible])

  return { section: layout.section, expanded: layout.expanded, changeExpanded, show }
}
