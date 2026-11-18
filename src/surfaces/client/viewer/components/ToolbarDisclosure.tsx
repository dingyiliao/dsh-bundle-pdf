import React, { useEffect, useRef, useState } from 'react'
import { ReaderPopover } from './ReaderPopover.js'

/** Inline menus share dismissal and focus rules; portaled menus use ReaderPopover. */
export function useInlineDisclosure(details: React.RefObject<HTMLDetailsElement>,
  trigger: React.RefObject<HTMLElement | null>, enabled = true) {
  const close = (restoreFocus = false) => {
    if (details.current) details.current.open = false
    if (restoreFocus) trigger.current?.focus()
  }
  useEffect(() => {
    if (!enabled) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && details.current && !details.current.contains(event.target)) close()
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [details, enabled])
  return {
    close,
    onBlur(event: React.FocusEvent<HTMLDetailsElement>) {
      if (enabled && event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) close()
    },
    onKeyDown(event: React.KeyboardEvent<HTMLDetailsElement>) {
      if (!enabled || event.key !== 'Escape' || !event.currentTarget.open) return
      event.preventDefault(); event.stopPropagation(); close(true)
    },
  }
}

/** Shared toolbar dropdown shell; callers own the choices and selected state. */
export function ToolbarDisclosure({ detailsRef, triggerRef, className, menuClassName, menuStyleProperties, label, menuLabel,
  disabled, onOpen, onOpenChange, children, trigger }: {
  detailsRef: React.RefObject<HTMLDetailsElement>
  triggerRef?: React.Ref<HTMLElement>
  className: string
  menuClassName?: string
  menuStyleProperties?: readonly string[]
  label: string
  menuLabel: string
  disabled?: boolean
  onOpen?: () => void
  onOpenChange?: (open: boolean) => void
  trigger: React.ReactNode
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLElement | null>(null)
  const [rail, setRail] = useState(false)
  useEffect(() => { setRail(!!detailsRef.current?.closest('[data-pdf-tool-rail]')) }, [detailsRef])
  const dismissal = useInlineDisclosure(detailsRef, anchor, !rail)

  const menu = <div className={`dsh-pdf-tools-menu dsh-pdf-glass${menuClassName ? ` ${menuClassName}` : ''}`}
    role="group" aria-label={menuLabel}>{children}</div>

  return <details ref={detailsRef} className={`dsh-pdf-toolbar-disclosure ${className}`} aria-label={label}
    onToggle={event => {
      const open = event.currentTarget.open
      setOpen(open)
      onOpenChange?.(open)
      if (open) onOpen?.()
    }} onBlur={dismissal.onBlur} onKeyDown={dismissal.onKeyDown}>
    <summary ref={node => {
      anchor.current = node
      if (typeof triggerRef === 'function') triggerRef(node)
      else if (triggerRef) (triggerRef as React.MutableRefObject<HTMLElement | null>).current = node
    }} aria-label={label} data-tooltip={label} aria-expanded={open}
      aria-disabled={disabled === undefined ? undefined : disabled} tabIndex={disabled ? -1 : 0}
      onClick={event => { if (disabled) event.preventDefault() }}>
      {trigger}<span className="dsh-pdf-toolbar-chevron" aria-hidden="true">▾</span>
    </summary>
    {rail ? <ReaderPopover anchor={anchor} open={open} anchorStyleProperties={menuStyleProperties} onClose={() => {
      if (detailsRef.current) detailsRef.current.open = false
    }} className="dsh-pdf-disclosure-popover">{menu}</ReaderPopover> : menu}
  </details>
}
