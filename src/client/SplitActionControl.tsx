import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ToolbarIcon } from './ToolbarIcon.js'

interface SplitActionControlProps {
  className?: string
  menuClassName?: string
  menuTestId?: string
  label: string
  actionLabel: string
  actionTooltip?: string
  menuLabel: string
  action: React.ReactNode
  active?: boolean
  disabled?: boolean
  onAction: () => void
  children: (close: () => void) => React.ReactNode
}

/** A single two-part control: the main action stays immediate, the chevron opens its choices. */
export function SplitActionControl({ className = '', menuClassName = '', menuTestId, label, actionLabel,
  actionTooltip = actionLabel, menuLabel, action, active = true, disabled = false, onAction, children }: SplitActionControlProps) {
  const [open, setOpen] = useState(false)
  const control = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => { if (!active || disabled) setOpen(false) }, [active, disabled])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !control.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open])
  useLayoutEffect(() => {
    if (!open) return
    const element = menu.current
    const reader = control.current?.closest<HTMLElement>('.dsh-pdf-reader')
    if (!element || !reader || !control.current) return
    const place = () => {
      const bounds = reader.getBoundingClientRect()
      const anchor = control.current!.getBoundingClientRect()
      element.style.maxWidth = `${Math.max(0, bounds.width - 16)}px`
      const left = Math.max(bounds.left + 8, Math.min(anchor.left, bounds.right - 8 - element.offsetWidth))
      element.style.left = `${Math.round(left - anchor.left)}px`
      element.dataset.position = anchor.bottom + 9 + element.offsetHeight > bounds.bottom - 8
        && anchor.top - 9 - element.offsetHeight >= bounds.top + 8 ? 'above' : 'below'
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(reader)
    observer.observe(element)
    window.addEventListener('resize', place)
    // Opening the menu from the keyboard should make its first action available immediately.
    if (trigger.current?.matches(':focus-visible')) element.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
    return () => { observer.disconnect(); window.removeEventListener('resize', place) }
  }, [open])

  const close = () => setOpen(false)
  return <div ref={control} className={`dsh-pdf-split-action ${className}`.trim()} role="group" aria-label={label}>
    <button type="button" className="dsh-pdf-split-action-main" disabled={disabled}
      aria-label={actionLabel} data-tooltip={actionTooltip} onClick={() => { close(); onAction() }}>{action}</button>
    <button ref={trigger} type="button" className="dsh-pdf-split-action-trigger" disabled={disabled}
      aria-label={menuLabel} data-tooltip={menuLabel} aria-expanded={open} aria-haspopup="dialog"
      aria-controls={open ? menuId : undefined} onClick={() => setOpen(current => !current)}>
      <ToolbarIcon name="chevronDown" />
    </button>
    {open && <div ref={menu} id={menuId} className={`dsh-pdf-split-action-menu ${menuClassName}`.trim()}
      data-testid={menuTestId} role="dialog" aria-label={menuLabel}>
      {children(close)}
    </div>}
  </div>
}
