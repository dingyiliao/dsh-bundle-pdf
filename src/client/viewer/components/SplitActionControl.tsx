import React, { useEffect, useId, useRef, useState } from 'react'
import { ToolbarIcon } from './ToolbarIcon.js'
import { ReaderPopover } from './ReaderPopover.js'

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
  const trigger = useRef<HTMLButtonElement>(null)
  const menuId = useId()

  useEffect(() => { if (!active || disabled) setOpen(false) }, [active, disabled])

  const close = () => setOpen(false)
  return <div className={`dsh-pdf-split-action ${className}`.trim()} role="group" aria-label={label}>
    <button type="button" className="dsh-pdf-split-action-main" disabled={disabled}
      aria-label={actionLabel} data-tooltip={actionTooltip} onClick={() => { close(); onAction() }}>{action}</button>
    <button ref={trigger} type="button" className="dsh-pdf-split-action-trigger" disabled={disabled}
      aria-label={menuLabel} data-tooltip={menuLabel} aria-expanded={open} aria-haspopup="dialog"
      aria-controls={open ? menuId : undefined} onClick={() => setOpen(current => !current)}>
      <ToolbarIcon name="chevronDown" />
    </button>
    {open && <ReaderPopover anchor={trigger} open={open} onClose={close} id={menuId}
      className={`dsh-pdf-split-action-menu dsh-pdf-glass ${menuClassName}`.trim()}
      data-testid={menuTestId} role="dialog" aria-label={menuLabel}>{children(close)}</ReaderPopover>}
  </div>
}
