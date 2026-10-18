import React, { useState } from 'react'
import { OverlayScrollbars } from './OverlayScrollbar.js'

export function ScrollablePanel({ className, children, header, verticalLabel, horizontalLabel }: {
  className: string
  children: React.ReactNode
  header?: React.ReactNode
  verticalLabel: string
  horizontalLabel: string
}) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null)
  return <aside className={className}>
    {header}
    <div className="dsh-pdf-panel-scroll" ref={setTarget} tabIndex={0}>{children}</div>
    <OverlayScrollbars target={target} verticalLabel={verticalLabel} horizontalLabel={horizontalLabel} />
  </aside>
}
