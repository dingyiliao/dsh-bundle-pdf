import React, { forwardRef, useCallback, useState } from 'react'
import { OverlayScrollbars } from './OverlayScrollbar.js'

interface ScrollablePanelProps {
  className: string
  title: React.ReactNode
  titleId?: string
  headingClassName?: string
  actions?: React.ReactNode
  notice?: React.ReactNode
  children: React.ReactNode
  scrollProps?: React.HTMLAttributes<HTMLDivElement>
  onKeyDown?: React.KeyboardEventHandler<HTMLElement>
  verticalLabel: string
  horizontalLabel: string
}

/** One fixed heading and one scroll viewport, including virtualized feature lists. */
export const ScrollablePanel = forwardRef<HTMLDivElement, ScrollablePanelProps>(function ScrollablePanel({
  className, title, titleId, headingClassName, actions, notice, children, scrollProps, onKeyDown,
  verticalLabel, horizontalLabel,
}, forwardedRef) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null)
  const attach = useCallback((element: HTMLDivElement | null) => {
    setTarget(element)
    if (typeof forwardedRef === 'function') forwardedRef(element)
    else if (forwardedRef) forwardedRef.current = element
  }, [forwardedRef])
  return <aside className={`dsh-pdf-panel ${className}`} onKeyDown={onKeyDown}>
    <div className={`dsh-pdf-panel-heading${headingClassName ? ` ${headingClassName}` : ''}`}>
      <h3 id={titleId}>{title}</h3>
      {actions}
    </div>
    {notice}
    <div tabIndex={0} {...scrollProps} className={`dsh-pdf-panel-scroll${scrollProps?.className ? ` ${scrollProps.className}` : ''}`}
      ref={attach}>{children}</div>
    <OverlayScrollbars target={target} verticalLabel={verticalLabel} horizontalLabel={horizontalLabel} />
  </aside>
})
