import React from 'react'
import type { NavigationHistorySnapshot } from '../../../navigation/index.js'
import { SplitActionControl } from './SplitActionControl.js'
import { ToolbarIcon } from './ToolbarIcon.js'

interface BackHistoryControlProps {
  history: NavigationHistorySnapshot
  disabled: boolean
  t: (key: string) => string
  onBack: () => void
  onBackTo: (depth: number, revision: number) => void
}

/** The latest stop is the immediate action; the dropdown can return to any earlier stop. */
export function BackHistoryControl({ history, disabled, t, onBack, onBackTo }: BackHistoryControlProps) {
  const unavailable = disabled || history.positions.length === 0
  return <SplitActionControl className="dsh-pdf-toolbar-back-split" menuClassName="dsh-pdf-history-menu"
    menuTestId="pdf-back-history" label={t('reader.history.menu')}
    actionLabel={t('reader.back')} actionTooltip={`${t('reader.back')} ${history.positions[0]?.page ?? ''}`.trim()}
    menuLabel={t('reader.history.menu')}
    action={<ToolbarIcon name="back" />} disabled={unavailable} onAction={onBack}>
    {close => <>
      <span className="dsh-pdf-history-menu-title">{t('reader.history.menu')}</span>
      <div className="dsh-pdf-history-list">
        {history.positions.map((position, depth) => {
          const step = `${depth + 1} ${t(depth === 0 ? 'reader.history.step' : 'reader.history.steps')}`
          return <button key={depth} type="button" className="dsh-pdf-history-item"
            aria-label={`${t('reader.history.returnTo')} ${t('reader.page')} ${position.page}, ${step}`}
            onClick={() => { close(); onBackTo(depth, history.revision) }}>
            <span>{t('reader.page')} {position.page}</span>
            <small>{step}</small>
          </button>
        })}
      </div>
    </>}
  </SplitActionControl>
}
