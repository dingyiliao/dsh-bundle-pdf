import type { NavigationHistorySnapshot } from '../../../shared/navigation-history.js'
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
  const pageLabel = (key: string, page: number) => t(key).replace('{page}', String(page))
  return <SplitActionControl className="dsh-pdf-toolbar-back-split" menuClassName="dsh-pdf-history-menu"
    menuTestId="pdf-back-history" label={t('reader.history.menu')}
    actionLabel={t('reader.back')} actionTooltip={history.positions[0]
      ? pageLabel('reader.history.returnTo', history.positions[0].page) : t('reader.back')}
    menuLabel={t('reader.history.menu')}
    action={<ToolbarIcon name="back" />} disabled={unavailable} onAction={onBack}>
    {close => <>
      <span className="dsh-pdf-history-menu-title">{t('reader.history.menu')}</span>
      <div className="dsh-pdf-history-list">
        {history.positions.map((position, depth) =>
          <button key={depth} type="button" className="dsh-pdf-history-item"
            aria-label={pageLabel('reader.history.returnTo', position.page)}
            onClick={() => { close(); onBackTo(depth, history.revision) }}>
            <span>{pageLabel('reader.history.page', position.page)}</span>
            {depth === 0 && <small>{t('reader.history.recent')}</small>}
          </button>)}
      </div>
    </>}
  </SplitActionControl>
}
