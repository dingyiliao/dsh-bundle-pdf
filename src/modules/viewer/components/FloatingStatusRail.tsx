import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ToolbarIcon } from './ToolbarIcon.js'
import { ReaderPopover } from './ReaderPopover.js'

export interface FloatingStatusAction {
  label: string
  ariaLabel?: string
  onClick: () => void
  disabled?: boolean
}

export interface FloatingStatus {
  id: string
  content: ReactNode
  /** Compact text for the task trigger; rich progress stays inside the popover. */
  summary?: ReactNode
  actions?: readonly FloatingStatusAction[]
  activity?: 'progress' | 'dot'
  /** Outcome semantics are independent of the task's kind and animation. */
  tone?: 'progress' | 'success' | 'error' | 'neutral'
  className?: string
  kind?: string
  title?: string
  /** Omit or set to zero to keep the status until its owner dismisses it. */
  durationMs?: number
  /** Change this when a new occurrence of the same status should restart its timer. */
  occurrence?: number
  onExpire?: () => void
}

const statusTone = (status: FloatingStatus) => status.tone
  ?? (status.kind === 'error' ? 'error' : status.activity === 'progress' ? 'progress' : 'neutral')

/** Existing tasks keep their places while work starts and finishes independently. */
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

  return <div className={`dsh-pdf-floating-status dsh-pdf-glass${status.className ? ` ${status.className}` : ''}`}
    data-status-id={status.id} data-kind={status.kind} data-tone={statusTone(status)} title={status.title}>
    {status.activity === 'progress' && <span className="dsh-pdf-floating-status-spinner" aria-hidden="true" />}
    {status.activity === 'dot' && <span className="dsh-pdf-floating-status-dot" aria-hidden="true" />}
    <span className="dsh-pdf-floating-status-content">{status.content}</span>
    {status.actions?.map((action, index) => <button key={`${action.label}:${index}`} type="button" disabled={action.disabled} aria-label={action.ariaLabel}
      onClick={action.onClick}>{action.label}</button>)}
  </div>
}

/** One fixed activity anchor; task timers run even when its popover is closed. */
export function FloatingStatusRail({ statuses, t }: { statuses: readonly FloatingStatus[]; t(key: string): string }) {
  const [order, setOrder] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const [rail, setRail] = useState(false)
  useLayoutEffect(() => { setRail(!!root.current?.closest('[data-pdf-tool-rail]')) }, [])
  const popoverId = useId()
  const activeIds = statuses.map(status => status.id)
  const activeKey = JSON.stringify(activeIds)
  const ordered = floatingStatusOrder(order, activeIds)
  useEffect(() => {
    setOrder(previous => {
      const next = floatingStatusOrder(previous, activeIds)
      return next.length === previous.length && next.every((id, index) => id === previous[index]) ? previous : next
    })
  }, [activeKey])
  useEffect(() => {
    if (!open || rail) return
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open, rail])
  const byId = new Map(statuses.map(status => [status.id, status]))
  const visible = ordered.map(id => byId.get(id)).filter((status): status is FloatingStatus => !!status)
  const primary = visible.find(status => status.kind === 'error')
    ?? visible.find(status => status.activity === 'progress') ?? visible.at(-1)
  const running = visible.filter(status => status.activity === 'progress' || status.kind === 'saving').length
  const content = visible.length ? visible.map(status => <FloatingStatusCard key={status.id} status={status} />)
    : <p className="dsh-pdf-activity-empty">{t('reader.activityEmpty')}</p>
  return <div className="dsh-pdf-floating-status-rail" ref={root} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); root.current?.querySelector('button')?.focus() }
  }}>
    <button ref={trigger} type="button" className={`dsh-pdf-activity-trigger${primary?.id === 'save' ? ' dsh-pdf-save-feedback' : ''}`}
      data-kind={primary?.kind} data-tone={primary ? statusTone(primary) : undefined}
      aria-label={`${t('reader.activity')}${visible.length ? `: ${visible.length}` : ''}`}
      aria-expanded={open} aria-controls={popoverId} data-tooltip={t('reader.activity')}
      onClick={() => setOpen(value => !value)}>
      {primary?.activity === 'progress' ? <span className="dsh-pdf-floating-status-spinner" aria-hidden="true" />
        : <ToolbarIcon name="activity" />}
      <span className="dsh-pdf-activity-summary" role="status" aria-live="polite" aria-atomic="true">
        {primary?.summary ?? primary?.content ?? t('reader.activity')}
      </span>
      {running > 0 && <span className="dsh-pdf-activity-count" aria-hidden="true">{running}</span>}
    </button>
    {rail ? <ReaderPopover anchor={trigger} open={open} onClose={() => setOpen(false)} id={popoverId}
      className="dsh-pdf-activity-popover dsh-pdf-glass" role="group" aria-label={t('reader.activity')}>{content}</ReaderPopover>
      : <div id={popoverId} className="dsh-pdf-activity-popover dsh-pdf-glass" role="group" aria-label={t('reader.activity')} hidden={!open}>{content}</div>}
  </div>
}
