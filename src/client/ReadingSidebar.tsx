import React, { useEffect, useId, useRef, useState } from 'react'

export type ReadingSidebarSection = 'translation' | 'annotations' | 'notes' | 'search' | 'bookmarks'

export interface ReadingSidebarProps {
  activeSection: ReadingSidebarSection
  onSectionChange: (section: ReadingSidebarSection) => void
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  panels: Partial<Record<ReadingSidebarSection, React.ReactNode>>
  t: (key: string) => string
}

const sections: readonly ReadingSidebarSection[] = ['translation', 'annotations', 'notes', 'search', 'bookmarks']
const availableSections = sections.filter(section => section !== 'bookmarks')
const railWidth = 44

function SidebarIcon({ section }: { section: ReadingSidebarSection }) {
  return <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {section === 'translation' ? <>
      <path d="M3 5h12M9 3v2M6 5c.7 4.1 3 7.2 7 9M13 5c-.9 4.4-4 8.1-9 10M14 21l4-10 4 10M15.2 18h5.6" />
    </> : section === 'annotations' ? <>
      <path d="m5 15 9-10 4 4-9 10H5v-4ZM12.5 6.5l4 4M4 22h16" />
    </> : section === 'notes' ? <>
      <path d="M5 3h14v12l-6 6H5V3ZM13 21v-6h6M8 7h8M8 11h8" />
    </> : section === 'search' ? <>
      <circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" />
    </> : <path d="M6 3h12v18l-6-4-6 4V3Z" />}
  </svg>
}

/** A persistent panel keeps in-flight translation and results alive across section changes. */
export function ReadingSidebar({ activeSection, onSectionChange, expanded, onExpandedChange, panels, t }: ReadingSidebarProps) {
  const root = useRef<HTMLElement>(null)
  const divider = useRef<HTMLDivElement>(null)
  const tabs = useRef(new Map<ReadingSidebarSection, HTMLButtonElement>())
  const drag = useRef<{ pointerId: number; x: number; width: number }>()
  const frame = useRef(0)
  const requestedWidth = useRef(320)
  const [width, setWidth] = useState(320)
  const [maximumWidth, setMaximumWidth] = useState(420)
  const panelId = useId()
  const minimumWidth = Math.min(220, maximumWidth)
  const currentWidth = expanded ? Math.max(minimumWidth, Math.min(width, maximumWidth)) : railWidth

  useEffect(() => {
    const parent = root.current?.parentElement
    if (!parent) return
    const updateLimits = () => {
      const available = parent.clientWidth
      // Small hosts keep a useful reading column. CSS applies the same bound before this effect runs.
      setMaximumWidth(Math.max(railWidth, Math.min(420, Math.floor(available * .45), available - 180)))
    }
    const observer = new ResizeObserver(updateLimits)
    observer.observe(parent)
    updateLimits()
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (expanded || !drag.current) return
    if (divider.current?.hasPointerCapture(drag.current.pointerId)) divider.current.releasePointerCapture(drag.current.pointerId)
    drag.current = undefined
  }, [expanded])

  useEffect(() => () => {
    cancelAnimationFrame(frame.current)
    if (drag.current && divider.current?.hasPointerCapture(drag.current.pointerId)) {
      divider.current.releasePointerCapture(drag.current.pointerId)
    }
  }, [])

  const resize = (nextWidth: number) => {
    requestedWidth.current = Math.max(minimumWidth, Math.min(maximumWidth, nextWidth))
    if (!frame.current) frame.current = requestAnimationFrame(() => {
      frame.current = 0
      setWidth(requestedWidth.current)
    })
  }

  const select = (section: ReadingSidebarSection) => {
    if (section === 'bookmarks') return
    onSectionChange(section)
    onExpandedChange(true)
  }

  return <aside ref={root} className={`dsh-pdf-sidebar${expanded ? '' : ' is-collapsed'}`}
    style={{ '--pdf-sidebar-width': `${currentWidth}px` } as React.CSSProperties}
    aria-label={t('reader.sidebar.title')}>
    <div ref={divider} className="dsh-pdf-sidebar-divider" role="separator" aria-orientation="vertical"
      aria-label={t('reader.sidebar.resize')} aria-valuemin={minimumWidth} aria-valuemax={maximumWidth}
      aria-valuenow={currentWidth} tabIndex={expanded ? 0 : -1} hidden={!expanded}
      onPointerDown={event => {
        if (event.button !== 0) return
        event.preventDefault()
        drag.current = { pointerId: event.pointerId, x: event.clientX, width: currentWidth }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => {
        const current = drag.current
        if (current?.pointerId === event.pointerId) resize(current.width + current.x - event.clientX)
      }}
      onPointerUp={event => {
        if (drag.current?.pointerId !== event.pointerId) return
        drag.current = undefined
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={() => { drag.current = undefined }}
      onLostPointerCapture={() => { drag.current = undefined }}
      onKeyDown={event => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          resize(currentWidth + (event.key === 'ArrowLeft' ? 16 : -16))
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          resize(event.key === 'Home' ? minimumWidth : maximumWidth)
        }
      }} />
    <div className="dsh-pdf-sidebar-panels" id={panelId} hidden={!expanded}>
      {sections.map(section => <div key={section} className="dsh-pdf-sidebar-panel"
        id={`${panelId}-${section}`} role="tabpanel" aria-labelledby={`${panelId}-tab-${section}`}
        hidden={activeSection !== section}>
        {panels[section]}
      </div>)}
    </div>
    <div className="dsh-pdf-sidebar-rail">
      <button type="button" className="dsh-pdf-sidebar-toggle" aria-controls={panelId} aria-expanded={expanded}
        aria-label={t(expanded ? 'reader.sidebar.collapse' : 'reader.sidebar.expand')}
        title={t(expanded ? 'reader.sidebar.collapse' : 'reader.sidebar.expand')} onClick={() => onExpandedChange(!expanded)}>
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor"
          strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={expanded ? 'm9 5 7 7-7 7' : 'm15 5-7 7 7 7'} />
        </svg>
      </button>
      <div className="dsh-pdf-sidebar-tabs" role="tablist" aria-orientation="vertical" aria-label={t('reader.sidebar.title')}>
        {sections.map(section => <button key={section} type="button" role="tab" id={`${panelId}-tab-${section}`}
          ref={element => { if (element) tabs.current.set(section, element); else tabs.current.delete(section) }}
          className={`dsh-pdf-sidebar-tab${activeSection === section && expanded ? ' is-active' : ''}`}
          aria-label={t(`reader.sidebar.${section}`)} aria-selected={activeSection === section}
          aria-controls={`${panelId}-${section}`} tabIndex={activeSection === section ? 0 : -1}
          title={t(section === 'bookmarks' ? 'reader.sidebar.bookmarksLater' : `reader.sidebar.${section}`)}
          disabled={section === 'bookmarks'} onClick={() => select(section)} onKeyDown={event => {
            if (section === 'bookmarks') return
            const current = availableSections.indexOf(section)
            let next = current
            if (event.key === 'ArrowDown') next = (current + 1) % availableSections.length
            else if (event.key === 'ArrowUp') next = (current + availableSections.length - 1) % availableSections.length
            else if (event.key === 'Home') next = 0
            else if (event.key === 'End') next = availableSections.length - 1
            else return
            event.preventDefault()
            const target = availableSections[next]
            select(target)
            tabs.current.get(target)?.focus()
          }}>
          <SidebarIcon section={section} />
          <span className="dsh-pdf-visually-hidden">{t(`reader.sidebar.${section}`)}</span>
        </button>)}
      </div>
    </div>
  </aside>
}
