import React from 'react'
import type { WorkspaceSnapshot } from '../../../shared/contracts.js'

export interface ReaderAlertsProps {
  snapshot: WorkspaceSnapshot | null
  error: string
  positionNotice: string
  editable: boolean
  saveAsOpen: boolean
  savePath: string
  target: { path: string; version: string | null } | null
  targetChecking: boolean
  overwrite: boolean
  busy: boolean
  reloadConfirm: boolean
  setError(value: string): void
  setPositionNotice(value: string): void
  setSavePath(value: string): void
  setOverwrite(value: boolean): void
  setSaveAsOpen(value: boolean): void
  setReloadConfirm(value: boolean): void
  save(path: string): void
  beginSaveAs(): void
  reload(): void
  t(key: string): string
}

/** Document feedback and the browser Save As fallback share one announcement region. */
export function ReaderAlerts(props: ReaderAlertsProps) {
  const { snapshot, error, positionNotice, editable, saveAsOpen, savePath, target,
    targetChecking, overwrite, busy, reloadConfirm, setError, setPositionNotice,
    setSavePath, setOverwrite, setSaveAsOpen, setReloadConfirm, save, beginSaveAs, reload, t } = props
  return <>
    {snapshot?.document.readOnly && <div className="dsh-pdf-notice">{t(snapshot.document.readOnlyReason === 'encrypted-document' ? 'reader.encryptedReadOnly' : 'reader.signedReadOnly')}</div>}
    {error && <div className="dsh-pdf-error" role="alert"><span>{error}</span><button aria-label={t('reader.dismiss')} onClick={() => setError('')}>×</button></div>}
    {snapshot?.warning && <div className="dsh-pdf-notice" role="status">{snapshot.warning}</div>}
    {positionNotice && <div className="dsh-pdf-notice" role="status">{positionNotice}
      <button aria-label={t('reader.dismiss')} onClick={() => setPositionNotice('')}>×</button></div>}
    {snapshot?.conflict && <div className="dsh-pdf-notice" role="status">{t('reader.conflict')}<button disabled={!editable} onClick={beginSaveAs}>{t('reader.saveAs')}</button></div>}
    {saveAsOpen && <form className="dsh-pdf-dialog" onSubmit={event => { event.preventDefault(); save(savePath) }}>
      <label>{t('reader.savePath')}<input value={savePath} required onChange={event => setSavePath(event.target.value)} /></label>
      <p>{targetChecking ? t('reader.targetChecking') : target?.version ? t('reader.targetExists') : target ? t('reader.targetNew') : t('reader.targetUnchecked')}</p>
      {target?.version && <label><input type="checkbox" checked={overwrite} onChange={event => setOverwrite(event.target.checked)} />{t('reader.overwrite')}</label>}
      <button type="submit" disabled={busy || !target || target.path !== savePath || (!!target.version && !overwrite)}>{t('reader.save')}</button><button type="button" onClick={() => setSaveAsOpen(false)}>{t('reader.cancel')}</button>
    </form>}
    {reloadConfirm && <div className="dsh-pdf-dialog"><p>{t('reader.reloadConfirm')}</p>
      <button onClick={() => { reload(); setReloadConfirm(false) }}>{t('reader.reload')}</button>
      <button onClick={() => setReloadConfirm(false)}>{t('reader.cancel')}</button></div>}
  </>
}
