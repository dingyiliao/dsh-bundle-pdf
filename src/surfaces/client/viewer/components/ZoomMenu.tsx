import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ToolbarDisclosure } from './ToolbarDisclosure.js'
import { ToolbarIcon } from './ToolbarIcon.js'

type Fit = 'custom' | 'width' | 'page'
const presets = [0.5, 0.75, 1, 1.25, 1.5, 2, 3]

interface ZoomMenuProps {
  fit: Fit
  zoom: number
  /** The reader keeps this enabled during a page jump; the prop stays for hosts that must lock it. */
  disabled?: boolean
  t: (key: string) => string
  onSelect: (value: number | 'width' | 'page') => void
}

/** Share the Tools menu's material while keeping zoom choices compact. */
export function ZoomMenu({ fit, zoom, disabled = false, t, onSelect }: ZoomMenuProps) {
  const [open, setOpen] = useState(false)
  const details = useRef<HTMLDetailsElement>(null)
  const trigger = useRef<HTMLElement>(null)
  const current = fit === 'width' ? t('reader.fitWidth') : fit === 'page' ? t('reader.fitPage') : `${Math.round(zoom * 100)}%`
  const choices = [
    { id: 'width', label: t('reader.fitWidth') },
    { id: 'page', label: t('reader.fitPage') },
    ...presets.map(value => ({ id: String(value), label: `${Math.round(value * 100)}%` })),
    ...(fit === 'custom' && !presets.includes(zoom) ? [{ id: String(zoom), label: current }] : []),
  ]
  const selectedId = fit === 'custom' ? String(zoom) : fit

  useEffect(() => {
    if (disabled && details.current) details.current.open = false
  }, [disabled])
  useLayoutEffect(() => {
    if (!open) return
    if (details.current?.closest('[data-pdf-tool-rail]')) return
    const menu = details.current?.querySelector<HTMLElement>('.dsh-pdf-zoom-menu')
    const reader = trigger.current?.closest<HTMLElement>('.dsh-pdf-reader')
    if (!menu || !reader) return
    const fitMenu = () => {
      const available = reader.getBoundingClientRect().bottom - menu.getBoundingClientRect().top - 12
      menu.style.maxHeight = `${Math.max(0, Math.floor(available))}px`
    }
    fitMenu()
    window.addEventListener('resize', fitMenu)
    const observer = new ResizeObserver(fitMenu)
    observer.observe(reader)
    return () => {
      window.removeEventListener('resize', fitMenu)
      observer.disconnect()
    }
  }, [open])

  return <ToolbarDisclosure detailsRef={details} triggerRef={trigger} className="dsh-pdf-toolbar-zoom"
    menuClassName="dsh-pdf-zoom-menu" label={`${t('reader.zoom')}: ${current}`}
    menuLabel={t('reader.zoom')} disabled={disabled} onOpenChange={setOpen}
    trigger={<ToolbarIcon name="zoom" />}>
      {choices.map(choice => <button key={choice.id} type="button" aria-pressed={choice.id === selectedId}
        onClick={() => {
          onSelect(choice.id === 'width' || choice.id === 'page' ? choice.id : Number(choice.id))
          if (details.current) details.current.open = false
          trigger.current?.focus()
        }}><span>{choice.label}</span></button>)}
  </ToolbarDisclosure>
}
