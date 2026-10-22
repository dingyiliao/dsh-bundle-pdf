import React, { useEffect } from 'react'

/** Shared toolbar dropdown shell; callers own the choices and selected state. */
export function ToolbarDisclosure({ detailsRef, triggerRef, className, menuClassName, label, menuLabel,
  disabled, onOpen, onOpenChange, children, trigger }: {
  detailsRef: React.RefObject<HTMLDetailsElement>
  triggerRef?: React.Ref<HTMLElement>
  className: string
  menuClassName?: string
  label: string
  menuLabel: string
  disabled?: boolean
  onOpen?: () => void
  onOpenChange?: (open: boolean) => void
  trigger: React.ReactNode
  children: React.ReactNode
}) {
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && detailsRef.current && !detailsRef.current.contains(event.target)) {
        detailsRef.current.open = false
      }
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [detailsRef])

  return <details ref={detailsRef} className={`dsh-pdf-toolbar-disclosure ${className}`} aria-label={label}
    onToggle={event => {
      const open = event.currentTarget.open
      onOpenChange?.(open)
      if (open) onOpen?.()
    }} onBlur={event => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) {
        event.currentTarget.open = false
      }
    }}>
    <summary ref={triggerRef} aria-label={label} data-tooltip={label}
      aria-disabled={disabled === undefined ? undefined : disabled} tabIndex={disabled ? -1 : 0}
      onClick={event => { if (disabled) event.preventDefault() }}>
      {trigger}<span className="dsh-pdf-toolbar-chevron" aria-hidden="true">▾</span>
    </summary>
    <div className={`dsh-pdf-tools-menu dsh-pdf-glass${menuClassName ? ` ${menuClassName}` : ''}`}
      role="group" aria-label={menuLabel}>{children}</div>
  </details>
}
