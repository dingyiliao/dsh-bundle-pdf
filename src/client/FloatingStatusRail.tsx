import React, { useEffect, useRef, useState, type ReactNode } from 'react'

export interface FloatingStatusAction {
  label: string
  onClick: () => void
  disabled?: boolean
}

export interface FloatingStatus {
  id: string
  content: ReactNode
  actions?: readonly FloatingStatusAction[]
  activity?: 'progress' | 'dot'
  className?: string
  kind?: string
  title?: string
  /** Omit or set to zero to keep the status until its owner dismisses it. */
  durationMs?: number
  /** Change this when a new occurrence of the same status should restart its timer. */
  occurrence?: number
  onExpire?: () => void
}

/** Existing statuses keep their places; newly visible ones join at the right. */
export function floatingStatusOrder(previous: readonly string[], active: readonly string[]): string[] {
  const activeSet = new Set(active)
  const ordered = previous.filter(id => activeSet.has(id))
  const known = new Set(ordered)
  for (const id of active) if (!known.has(id)) { ordered.push(id); known.add(id) }
  return ordered
}

function FloatingStatusCard({ status }: { status: FloatingStatus }) {
  const onExpire = useRef(status.onExpire)
  const occurrence = useRef(status.occurrence)
  onExpire.current = status.onExpire
  occurrence.current = status.occurrence
  useEffect(() => {
    if (!status.durationMs || status.durationMs <= 0) return
    const current = status.occurrence
    const timer = setTimeout(() => {
      if (occurrence.current === current) onExpire.current?.()
    }, status.durationMs)
    return () => clearTimeout(timer)
  }, [status.id, status.durationMs, status.occurrence])

  return <div className={`dsh-pdf-floating-status${status.className ? ` ${status.className}` : ''}`}
    data-status-id={status.id} data-kind={status.kind} title={status.title}>
    {status.activity === 'progress' && <span className="dsh-pdf-floating-status-spinner" aria-hidden="true" />}
    {status.activity === 'dot' && <span className="dsh-pdf-floating-status-dot" aria-hidden="true" />}
    <span className="dsh-pdf-floating-status-content" role="status" aria-live="polite" aria-atomic="true">{status.content}</span>
    {status.actions?.map((action, index) => <button key={`${action.label}:${index}`} type="button" disabled={action.disabled}
      onClick={action.onClick}>{action.label}</button>)}
  </div>
}

/** Layout and lifetime for temporary reader feedback, independent of the page layout. */
export function FloatingStatusRail({ statuses, children }: { statuses: readonly FloatingStatus[]; children?: ReactNode }) {
  const [order, setOrder] = useState<string[]>([])
  const activeIds = statuses.map(status => status.id)
  const activeKey = JSON.stringify(activeIds)
  const ordered = floatingStatusOrder(order, activeIds)
  useEffect(() => {
    setOrder(previous => {
      const next = floatingStatusOrder(previous, activeIds)
      return next.length === previous.length && next.every((id, index) => id === previous[index]) ? previous : next
    })
  }, [activeKey])
  const byId = new Map(statuses.map(status => [status.id, status]))
  return <div className="dsh-pdf-floating-status-rail">
    {children}
    {ordered.map(id => byId.get(id)).filter((status): status is FloatingStatus => !!status)
      .map(status => <FloatingStatusCard key={status.id} status={status} />)}
  </div>
}
