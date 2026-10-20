import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { pdfEvidenceCardModel } from './pdf-evidence-model.js'
import type { PdfEvidenceNavigation } from './pdf-evidence-navigation.js'

/** The subset of DSH's `tool.call.toolview` props used here. Its session scope
 * injects `sessionId` through UiSession standard props, not ToolCallTree's owner. */
export interface PdfToolCallProps {
  phase: 'preparing' | 'start' | 'result'
  toolName: string
  sessionId: string
  block: { meta?: unknown; isError?: boolean; content?: readonly { type: string; text?: string }[] }
  inspect?: () => void
}

export interface PdfEvidenceToolCardProps extends PdfToolCallProps {
  navigation: PdfEvidenceNavigation
  t(key: string): string
}

/** A replay card displays immutable model-visible text; opening a page requires a live Reader lease. */
export function PdfEvidenceToolCard({ navigation, t, ...props }: PdfEvidenceToolCardProps) {
  useSyncExternalStore(navigation.subscribe, navigation.getRevision, navigation.getRevision)
  const [busy, setBusy] = useState<number | null>(null)
  const [notice, setNotice] = useState('')
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [])
  const result = props.phase === 'result' ? props.block : null
  const model = result && !result.isError ? pdfEvidenceCardModel(props.toolName, result.meta) : null
  const title = t(`evidence.${props.toolName}`)
  const output = result?.content?.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n').slice(0, 2_000)
  const open = async (index: number) => {
    const evidence = model?.entries[index]
    if (!evidence || !navigation.canNavigate(props.sessionId, evidence)) return
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setBusy(index)
    setNotice('')
    const status = await navigation.navigate(props.sessionId, evidence, controller.signal)
    if (controller.signal.aborted) return
    pending.current = null
    setBusy(null)
    if (status !== 'opened') setNotice(t(status === 'stale' ? 'evidence.stale' : 'evidence.unavailable'))
  }
  return <section className="pdf-evidence-card" aria-label={title}>
    <div className="pdf-evidence-card-header">
      <span className="pdf-evidence-card-icon" aria-hidden="true">▤</span>
      <strong>{title}</strong>
      <span className="pdf-evidence-card-status">{model?.status ?? (props.phase === 'result'
        ? result?.isError ? t('evidence.error') : t('evidence.unavailable') : t('evidence.running'))}</span>
    </div>
    {model ? <>
      <div className="pdf-evidence-card-subtitle">{model.entries.length} {t('evidence.passages')}</div>
      {model.entries.length > 0 && <div className="pdf-evidence-card-entries">
        {model.entries.map((entry, index) => {
          const available = navigation.canNavigate(props.sessionId, entry)
          return <div className="pdf-evidence-card-entry" key={`${entry.page}:${entry.locator.startUtf16}:${index}`}>
            <div className="pdf-evidence-card-entry-head">
              <span>{t('evidence.page')} {entry.page}</span>
              <button type="button" disabled={!available || busy !== null} onClick={() => { void open(index) }}
                title={available ? t('evidence.open') : t('evidence.unavailable')}>
                {busy === index ? t('evidence.checking') : t('evidence.open')}
              </button>
            </div>
            <p>{entry.snapshot.text || t('evidence.noText')}</p>
          </div>
        })}
      </div>}
      {model.entries.length === 0 && <p className="pdf-evidence-card-empty">{t('evidence.noMatches')}</p>}
      <div className="pdf-evidence-card-caveat">{t('evidence.replayNotice')}</div>
    </> : props.phase === 'result' ? <pre className="pdf-evidence-card-raw">{output || t('evidence.noOutput')}</pre> : null}
    {notice && <div className="pdf-evidence-card-notice" role="status">{notice}</div>}
    {props.inspect && <button className="pdf-evidence-card-inspect" type="button" onClick={props.inspect}>
      {t('evidence.inspect')}
    </button>}
  </section>
}
