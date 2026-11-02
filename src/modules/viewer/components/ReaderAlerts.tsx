import type { WorkspaceSnapshot } from '../../../shared/contracts.js'
import { SaveAsDialog, type SaveAsDialogProps } from './SaveAsDialog.js'

export interface ReaderAlertsProps {
  snapshot: WorkspaceSnapshot | null
  error: string
  positionNotice: string
  editable: boolean
  saveAs?: SaveAsDialogProps
  reloadConfirm: boolean
  setError(value: string): void
  setPositionNotice(value: string): void
  setReloadConfirm(value: boolean): void
  beginSaveAs(): void
  reload(): void
  t(key: string): string
}

/** Save As owns its modal feedback; document notices remain in the Reader. */
export function ReaderAlerts(props: ReaderAlertsProps) {
  const { snapshot, error, positionNotice, editable, saveAs, reloadConfirm, setError, setPositionNotice,
    setReloadConfirm, beginSaveAs, reload, t } = props
  return <>
    {snapshot?.document.readOnly && <div className="dsh-pdf-notice">{t(snapshot.document.readOnlyReason === 'encrypted-document'
      ? 'reader.encryptedReadOnly' : 'reader.signedReadOnly')}</div>}
    {error && !saveAs && <div className="dsh-pdf-error" role="alert"><span>{error}</span><button aria-label={t('reader.dismiss')} onClick={() => setError('')}>×</button></div>}
    {snapshot?.warning && <div className="dsh-pdf-notice" role="status">{snapshot.warning}</div>}
    {positionNotice && <div className="dsh-pdf-notice" role="status">{positionNotice}
      <button aria-label={t('reader.dismiss')} onClick={() => setPositionNotice('')}>×</button></div>}
    {snapshot?.conflict && <div className="dsh-pdf-notice" role="status">{t('reader.conflict')}<button disabled={!editable} onClick={beginSaveAs}>{t('reader.saveAs')}</button></div>}
    {saveAs && <SaveAsDialog {...saveAs} />}
    {reloadConfirm && <div className="dsh-pdf-dialog"><p>{t('reader.reloadConfirm')}</p>
      <button onClick={() => { reload(); setReloadConfirm(false) }}>{t('reader.reload')}</button>
      <button onClick={() => setReloadConfirm(false)}>{t('reader.cancel')}</button></div>}
  </>
}
