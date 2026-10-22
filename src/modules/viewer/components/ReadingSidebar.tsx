import React, { useEffect, useId, useRef, useState } from 'react'
import type { ReaderDocument } from '../ports/reader-document.js'
import { BookmarkPanel, type OutlineAccess } from './BookmarkPanel.js'
import { PageThumbnailPanel } from './PageThumbnailPanel.js'

export const readingSidebarSections = ['pages', 'bookmarks', 'annotations', 'search', 'translation', 'ocr'] as const
export type ReadingSidebarSection = typeof readingSidebarSections[number]

export interface ReadingSidebarProps {
  activeSection: ReadingSidebarSection
  onSectionChange: (section: ReadingSidebarSection) => void
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  panels: Partial<Record<ReadingSidebarSection, React.ReactNode>>
  pdf: ReaderDocument | null
  currentPage: number
  pageInput: string
  navigating: boolean
  onPageInputChange: (value: string) => void
  onPageInputSubmit: (value: string) => void
  onPageInputReset: () => void
  onNavigatePage: (page: number) => void
  onStepPage: (page: number) => void
  onNavigateDestination: (destination: unknown) => void
  outlineAccess?: OutlineAccess
  t: (key: string) => string
}

const sections = readingSidebarSections
const railWidth = 44

function SidebarIcon({ section }: { section: ReadingSidebarSection }) {
  return <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {section === 'pages' ? <>
      <rect x="5" y="3" width="11" height="14" rx="1" /><path d="M9 7h4M9 10h4M9 13h3M8 20h11V7" />
    </> : section === 'translation' ? <>
      <path d="M3 5h12M9 3v2M6 5c.7 4.1 3 7.2 7 9M13 5c-.9 4.4-4 8.1-9 10M14 21l4-10 4 10M15.2 18h5.6" />
    </> : section === 'ocr' ? <>
      <path d="M4 5h16v14H4zM7 9h4M7 12h7M7 15h5" /><path d="m16 10 1 1 2-2" />
    </> : section === 'annotations' ? <>
      <path d="m5 15 9-10 4 4-9 10H5v-4ZM12.5 6.5l4 4M4 22h16" />
    </> : section === 'search' ? <>
      <circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" />
    </> : <path d="M6 3h12v18l-6-4-6 4V3Z" />}
  </svg>
}

function PageNavigation({ pdf, currentPage, pageInput, navigating, compact, onPageInputChange,
  onPageInputSubmit, onPageInputReset, onStepPage, t }: Pick<ReadingSidebarProps,
  'pdf' | 'currentPage' | 'pageInput' | 'navigating' | 'onPageInputChange' | 'onPageInputSubmit' | 'onPageInputReset' | 'onStepPage' | 't'> & { compact: boolean }) {
  const count = pdf?.numPages
  const skipBlur = useRef(false)
  const submittedPage = useRef<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const submit = () => {
    const raw = (inputRef.current?.value ?? pageInput).trim()
    const page = Number(raw)
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(page) || page < 1 || page > (count ?? 0)) {
      onPageInputReset()
      return
    }
    submittedPage.current = page
    onPageInputSubmit(raw)
  }
  return <div className={`dsh-pdf-sidebar-page-nav${compact ? ' is-compact' : ''}`}
    role="group" aria-label={t('reader.navigation')}>
    {/* A step stays enabled while a jump is in flight: the reader coalesces page
        requests anyway, and dimming these buttons for the length of a load reads
        as a flicker. Only the page field is locked, so a half-typed number is not
        lost when the layout changes under it. */}
    <button type="button" className="dsh-pdf-page-step" aria-label={t('reader.previous')} title={t('reader.previous')}
      disabled={!pdf || currentPage <= 1} onClick={() => onStepPage(currentPage - 1)}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={compact ? 'm5 14 7-7 7 7' : 'm14 5-7 7 7 7'} />
      </svg>
    </button>
    <form className="dsh-pdf-page-form" onSubmit={event => { event.preventDefault(); submit() }}>
      <input ref={inputRef} className="dsh-pdf-page-input" aria-label={t('reader.page')} inputMode="numeric" autoComplete="off"
        title={`${currentPage} / ${count ?? '—'}`} value={pageInput} disabled={!pdf || navigating}
        onChange={event => {
          if (!/^\d*$/.test(event.target.value)) return
          onPageInputChange(event.target.value)
        }}
        onFocus={event => { submittedPage.current = null; event.currentTarget.select() }}
        onBlur={event => {
          if (skipBlur.current) { skipBlur.current = false; return }
          if (!pdf || navigating) return
          const raw = event.currentTarget.value.trim()
          if (!/^\d+$/.test(raw)) { onPageInputReset(); return }
          if (submittedPage.current === Number(raw)) return
          const page = Math.max(1, Math.min(count ?? 1, Number(raw)))
          onPageInputChange(String(page))
          if (page !== currentPage) onStepPage(page)
        }}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            skipBlur.current = true
            onPageInputReset()
            event.currentTarget.blur()
          } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault()
            const typed = Number(event.currentTarget.value)
            const base = Number.isSafeInteger(typed) && typed >= 1 && typed <= (count ?? 0) ? typed : currentPage
            const page = Math.max(1, Math.min(count ?? 1, base + (event.key === 'ArrowUp' ? 1 : -1)))
            onPageInputChange(String(page))
            if (page !== currentPage) onStepPage(page)
          }
        }} />
      <span className="dsh-pdf-page-total" title={`${currentPage} / ${count ?? '—'}`}
        aria-label={`${t('reader.totalPages')} ${count ?? '—'}`}>
        {compact ? count ?? '—' : `/ ${count ?? '—'}`}
      </span>
    </form>
    <button type="button" className="dsh-pdf-page-step" aria-label={t('reader.next')} title={t('reader.next')}
      disabled={!pdf || currentPage >= (count ?? 0)} onClick={() => onStepPage(currentPage + 1)}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={compact ? 'm5 10 7 7 7-7' : 'm10 5 7 7-7 7'} />
      </svg>
    </button>
  </div>
}

/** A persistent panel keeps in-flight translation and results alive across section changes. */
export function ReadingSidebar({ activeSection, onSectionChange, expanded, onExpandedChange, panels,
  pdf, currentPage, pageInput, navigating, onPageInputChange, onPageInputSubmit, onPageInputReset,
  onNavigatePage, onStepPage, onNavigateDestination, outlineAccess, t }: ReadingSidebarProps) {
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
  const expandedWidth = Math.max(minimumWidth, Math.min(width, maximumWidth))
  const currentWidth = expanded ? expandedWidth : railWidth

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
    root.current?.removeAttribute('data-resizing')
  }, [expanded])

  useEffect(() => {
    // React clears host refs before passive unmount cleanup. Keep the actual
    // divider so a resize capture is released even when this sidebar unmounts.
    const element = divider.current
    return () => {
      cancelAnimationFrame(frame.current)
      if (drag.current && element?.hasPointerCapture(drag.current.pointerId)) {
        element.releasePointerCapture(drag.current.pointerId)
      }
      root.current?.removeAttribute('data-resizing')
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
    onSectionChange(section)
    onExpandedChange(true)
  }

  return <aside ref={root} className={`dsh-pdf-sidebar dsh-pdf-glass${expanded ? '' : ' is-collapsed'}`}
    style={{ '--pdf-sidebar-width': `${currentWidth}px`, '--pdf-sidebar-expanded-width': `${expandedWidth}px` } as React.CSSProperties}
    aria-label={t('reader.sidebar.title')}>
    <div className="dsh-pdf-sidebar-shell">
    <div ref={divider} className="dsh-pdf-sidebar-divider" role="separator" aria-orientation="vertical"
      aria-label={t('reader.sidebar.resize')} aria-valuemin={minimumWidth} aria-valuemax={maximumWidth}
      aria-valuenow={currentWidth} tabIndex={expanded ? 0 : -1} hidden={!expanded}
      onPointerDown={event => {
        if (event.button !== 0) return
        event.preventDefault()
        drag.current = { pointerId: event.pointerId, x: event.clientX, width: currentWidth }
        root.current?.setAttribute('data-resizing', '')
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => {
        const current = drag.current
        if (current?.pointerId === event.pointerId) resize(current.width + current.x - event.clientX)
      }}
      onPointerUp={event => {
        if (drag.current?.pointerId !== event.pointerId) return
        drag.current = undefined
        root.current?.removeAttribute('data-resizing')
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={() => { drag.current = undefined; root.current?.removeAttribute('data-resizing') }}
      onLostPointerCapture={() => { drag.current = undefined; root.current?.removeAttribute('data-resizing') }}
      onKeyDown={event => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          resize(currentWidth + (event.key === 'ArrowLeft' ? 16 : -16))
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          resize(event.key === 'Home' ? minimumWidth : maximumWidth)
        }
      }} />
    <div className="dsh-pdf-sidebar-main" aria-hidden={!expanded}
      ref={element => { if (element) element.inert = !expanded }}>
      <div className="dsh-pdf-sidebar-panels" id={panelId}>
        {sections.map(section => <div key={section} className="dsh-pdf-sidebar-panel"
          id={`${panelId}-${section}`} role="tabpanel" aria-labelledby={`${panelId}-tab-${section}`}
          hidden={activeSection !== section}>
          {section === 'pages' ? <PageThumbnailPanel pdf={pdf} active={expanded && activeSection === section}
            currentPage={currentPage} onNavigatePage={onNavigatePage} t={t} />
            : section === 'bookmarks' ? <BookmarkPanel pdf={pdf} active={expanded && activeSection === section}
              currentPage={currentPage} outlineAccess={outlineAccess} onNavigateDestination={onNavigateDestination} t={t} /> : panels[section]}
        </div>)}
      </div>
      <div className="dsh-pdf-sidebar-footer">
        <PageNavigation pdf={pdf} currentPage={currentPage} pageInput={pageInput} navigating={navigating}
          compact={false} onPageInputChange={onPageInputChange} onPageInputSubmit={onPageInputSubmit}
          onPageInputReset={onPageInputReset} onStepPage={onStepPage} t={t} />
      </div>
    </div>
    <div className="dsh-pdf-sidebar-rail">
      <button type="button" className="dsh-pdf-sidebar-toggle" aria-controls={panelId} aria-expanded={expanded}
        aria-label={t(expanded ? 'reader.sidebar.collapse' : 'reader.sidebar.expand')}
        title={t(expanded ? 'reader.sidebar.collapse' : 'reader.sidebar.expand')} onClick={() => {
          onExpandedChange(!expanded)
        }}>
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor"
          strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m9 5 7 7-7 7" />
        </svg>
      </button>
      <div className="dsh-pdf-sidebar-tabs" role="tablist" aria-orientation="vertical" aria-label={t('reader.sidebar.title')}>
        {sections.map(section => <button key={section} type="button" role="tab" id={`${panelId}-tab-${section}`}
          ref={element => { if (element) tabs.current.set(section, element); else tabs.current.delete(section) }}
          className={`dsh-pdf-sidebar-tab${activeSection === section && expanded ? ' is-active' : ''}`}
          aria-label={t(`reader.sidebar.${section}`)} aria-selected={activeSection === section}
          aria-controls={`${panelId}-${section}`} tabIndex={activeSection === section ? 0 : -1}
          title={t(`reader.sidebar.${section}`)}
          onClick={() => select(section)} onKeyDown={event => {
            const current = sections.indexOf(section)
            let next = current
            if (event.key === 'ArrowDown') next = (current + 1) % sections.length
            else if (event.key === 'ArrowUp') next = (current + sections.length - 1) % sections.length
            else if (event.key === 'Home') next = 0
            else if (event.key === 'End') next = sections.length - 1
            else return
            event.preventDefault()
            const target = sections[next]
            select(target)
            tabs.current.get(target)?.focus()
          }}>
          <SidebarIcon section={section} />
          <span className="dsh-pdf-visually-hidden">{t(`reader.sidebar.${section}`)}</span>
        </button>)}
      </div>
      <div className="dsh-pdf-sidebar-compact-nav" aria-hidden={expanded}
        ref={element => { if (element) element.inert = expanded }}>
        <PageNavigation pdf={pdf} currentPage={currentPage} pageInput={pageInput} navigating={navigating}
          compact onPageInputChange={onPageInputChange} onPageInputSubmit={onPageInputSubmit}
          onPageInputReset={onPageInputReset} onStepPage={onStepPage} t={t} />
      </div>
    </div>
    </div>
  </aside>
}
