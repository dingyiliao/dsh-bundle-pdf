import { useState, type FormEvent } from 'react'
import type { WorkspaceSnapshot } from '../../../shared/contracts.js'
import { SaveAsDialog, type SaveAsDialogProps } from './SaveAsDialog.js'

export interface ReaderPasswordPromptProps {
  identity: string
  status: 'required' | 'incorrect' | 'cancelled'
  busy: boolean
  unlock(password: string): void
  cancel(): void
  retry(): void
}

interface ReaderEditPasswordProps {
  begin(): void
  prompt?: Omit<ReaderPasswordPromptProps, 'retry' | 'status'> & { status: 'required' | 'incorrect' }
}

export interface ReaderAlertsProps {
  snapshot: WorkspaceSnapshot | null
  error: string
  positionNotice: string
  editable: boolean
  saveAs?: SaveAsDialogProps
  password?: ReaderPasswordPromptProps
  editPassword?: ReaderEditPasswordProps
  reloadConfirm: boolean
  setError(value: string): void
  setPositionNotice(value: string): void
  setReloadConfirm(value: boolean): void
  beginSaveAs(): void
  reload(): void
  t(key: string): string
}

function ReaderPasswordPrompt({ status, busy, unlock, cancel, retry, edit = false, t }: Omit<ReaderPasswordPromptProps, 'retry'> & {
  retry?(): void
  edit?: boolean
  t(key: string): string
}) {
  const [password, setPassword] = useState('')
  if (status === 'cancelled') return <div className="dsh-pdf-password-prompt" role="status">
    <span>{t('reader.unlockCancelled')}</span>
    <button type="button" onClick={() => { setPassword(''); retry?.() }}>{t('reader.unlock')}</button>
  </div>
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!password || password.includes('\0') || busy) return
    const submitted = password
    setPassword('')
    unlock(submitted)
  }
  const title = t(edit ? 'reader.unlockEditing' : 'reader.unlockTitle')
  return <form className="dsh-pdf-password-prompt" onSubmit={submit} aria-label={title}>
    <strong>{title}</strong>
    <p>{t(edit ? 'reader.ownerPasswordRequired' : 'reader.passwordRequired')}</p>
    <label>{t(edit ? 'reader.ownerPasswordLabel' : 'reader.passwordLabel')}
      <input autoFocus type="password" value={password} maxLength={1024} autoComplete="off"
        spellCheck={false} disabled={busy} onChange={event => setPassword(event.target.value)} />
    </label>
    {status === 'incorrect' && <p className="dsh-pdf-password-error" role="alert">
      {t(edit ? 'reader.ownerPasswordIncorrect' : 'reader.passwordIncorrect')}</p>}
    <div className="dsh-pdf-password-actions">
      <button type="submit" disabled={!password || password.includes('\0') || busy}>
        {t(busy ? 'reader.unlocking' : edit ? 'reader.unlockEditing' : 'reader.unlock')}</button>
      <button type="button" onClick={() => { setPassword(''); cancel() }}>{t('reader.cancel')}</button>
    </div>
  </form>
}

/** Save As owns its modal feedback; document notices remain in the Reader. */
export function ReaderAlerts(props: ReaderAlertsProps) {
  const { snapshot, error, positionNotice, editable, saveAs, password, editPassword, reloadConfirm, setError, setPositionNotice,
    setReloadConfirm, beginSaveAs, reload, t } = props
  const document = snapshot?.document
  return <>
    {password && <ReaderPasswordPrompt key={password.identity} {...password} t={t} />}
    {document?.readOnly && <div className="dsh-pdf-notice">
      <span>{t(document.readOnlyReason === 'encrypted-document'
        ? editPassword ? 'reader.encryptedAnnotationLocked' : 'reader.encryptedReadOnly'
        : 'reader.signedReadOnly')}</span>
      {editPassword && !editPassword.prompt && <button type="button" onClick={editPassword.begin}>{t('reader.unlockEditing')}</button>}
    </div>}
    {editPassword?.prompt && <ReaderPasswordPrompt key={editPassword.prompt.identity} {...editPassword.prompt} edit t={t} />}
    {document?.annotationEditing === 'allowed' && <div className="dsh-pdf-notice">
      {t('reader.encryptedAnnotationEditable')}</div>}
    {error && !saveAs && <div className="dsh-pdf-error" role="alert"><span>{error}</span><button aria-label={t('reader.dismiss')} onClick={() => setError('')}>×</button></div>}
    {snapshot?.warning && <div className="dsh-pdf-notice" role="status">{snapshot.warning}</div>}
    {positionNotice && <div className="dsh-pdf-notice" role="status">{positionNotice}
      <button aria-label={t('reader.dismiss')} onClick={() => setPositionNotice('')}>×</button></div>}
    {snapshot?.conflict && <div className="dsh-pdf-notice" role="status">
      {t(snapshot.document.encrypted ? 'reader.protectedSourceChanged' : 'reader.conflict')}
      {(!snapshot.document.encrypted || snapshot.document.annotationEditing === 'allowed')
        && <button disabled={!editable} onClick={beginSaveAs}>{t('reader.saveAs')}</button>}
    </div>}
    {saveAs && <SaveAsDialog {...saveAs} />}
    {reloadConfirm && <div className="dsh-pdf-dialog"><p>{t('reader.reloadConfirm')}</p>
      <button onClick={() => { reload(); setReloadConfirm(false) }}>{t('reader.reload')}</button>
      <button onClick={() => setReloadConfirm(false)}>{t('reader.cancel')}</button></div>}
  </>
}
