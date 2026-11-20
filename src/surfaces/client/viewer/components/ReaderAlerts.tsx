import { useState, type FormEvent } from 'react'
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
  prompt?: Omit<ReaderPasswordPromptProps, 'retry' | 'status'> & { status: 'required' | 'incorrect' }
}

export interface ReaderAlertsProps {
  saveAs?: SaveAsDialogProps
  password?: ReaderPasswordPromptProps
  editPassword?: ReaderEditPasswordProps
  reloadConfirm: boolean
  setReloadConfirm(value: boolean): void
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

/** Blocking prompts stay here; non-blocking document feedback is in the status rail. */
export function ReaderAlerts(props: ReaderAlertsProps) {
  const { saveAs, password, editPassword, reloadConfirm, setReloadConfirm, reload, t } = props
  return <>
    {password && <ReaderPasswordPrompt key={password.identity} {...password} t={t} />}

    {editPassword?.prompt && <ReaderPasswordPrompt key={editPassword.prompt.identity} {...editPassword.prompt} edit t={t} />}
    {saveAs && <SaveAsDialog {...saveAs} />}
    {reloadConfirm && <div className="dsh-pdf-dialog"><p>{t('reader.reloadConfirm')}</p>
      <button onClick={() => { reload(); setReloadConfirm(false) }}>{t('reader.reload')}</button>
      <button onClick={() => setReloadConfirm(false)}>{t('reader.cancel')}</button></div>}
  </>
}
