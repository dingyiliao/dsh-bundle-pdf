import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { FloatingStatusRail, type FloatingStatus } from '../../../src/modules/viewer/components/FloatingStatusRail.js'

interface StatusInput { id: string; label: string; actionLabel?: string; durationMs?: number; occurrence?: number; tone?: FloatingStatus['tone'] }
let presses = 0
let update: (items: StatusInput[]) => void = () => {}

function Fixture() {
  const [statuses, setStatuses] = useState<FloatingStatus[]>([])
  update = items => setStatuses(items.map(item => ({
    id: item.id, content: item.label, durationMs: item.durationMs, occurrence: item.occurrence,
    tone: item.tone,
    activity: item.id === 'ocr' || item.id === 'screenshot' ? 'progress' : item.tone ? 'dot' : undefined,
    actions: [{ label: item.actionLabel ?? `Cancel ${item.id}`, onClick: () => { presses++; setStatuses(current => current.filter(status => status.id !== item.id)) } }],
    onExpire: () => setStatuses(current => current.filter(status => status.id !== item.id)),
  })))
  return <div className="dsh-pdf-toolbar dsh-pdf-main-toolbar" style={{ width: 250, height: 44, justifyContent: 'flex-end' }}>
    <FloatingStatusRail statuses={statuses} t={key => key} />
  </div>
}

createRoot(document.getElementById('rail-root')!).render(<Fixture />)
Object.assign(window, { __pdfFloatingStatusFixture: { set: (items: StatusInput[]) => update(items), presses: () => presses } })
