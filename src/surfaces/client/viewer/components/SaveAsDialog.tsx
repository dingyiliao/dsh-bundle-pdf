import { useId, useLayoutEffect, useRef, useState } from 'react'
import { ToolbarIcon } from './ToolbarIcon.js'

export interface SaveAsDialogProps {
  name: string
  directory: string
  pickerAvailable: boolean
  picking: boolean
  busy: boolean
  targetChecking: boolean
  target: { path: string; version: string | null } | null
  replaceConfirm: boolean
  error: string
  nameError?: string
  directoryError?: string
  onNameChange(value: string): void
  onDirectoryChange(value: string): void
  onChooseDirectory(): void
  onSubmit(): void
  onCancel(): void
  onBack(): void
  t(key: string): string
}

/** Presentation only: the save controller owns target versions and replacement consent. */
export function SaveAsDialog(props: SaveAsDialogProps) {
  const { name, directory, pickerAvailable, picking, busy, targetChecking, target, replaceConfirm,
    error, nameError, directoryError, onNameChange, onDirectoryChange, onChooseDirectory,
    onSubmit, onCancel, onBack, t } = props
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const directoryInput = useRef<HTMLInputElement>(null)
  const confirmButton = useRef<HTMLButtonElement>(null)
  const [editingDirectory, setEditingDirectory] = useState(false)
  const blocked = busy || picking
  const invalid = !!nameError || !!directoryError || !name.trim() || !directory
  const canSubmit = !blocked && !targetChecking && !!target && !invalid

  useLayoutEffect(() => {
    const element = dialog.current!
    const doc = element.ownerDocument
    const previous = doc.activeElement as HTMLElement | null
    // Native modal behavior provides a top layer and makes the rest of the app
    // inert. The open-attribute fallback also lets DOM-only tests mount it.
    if (typeof element.showModal === 'function') element.showModal()
    else element.setAttribute('open', '')
    const input = nameInput.current
    input?.focus({ preventScroll: true })
    if (input) {
      const extension = input.value.lastIndexOf('.')
      input.setSelectionRange(0, extension > 0 ? extension : input.value.length)
    }
    return () => {
      const ownsFocus = element.contains(doc.activeElement) || doc.activeElement === doc.body
      if (typeof element.close === 'function' && element.open) element.close()
      else element.removeAttribute('open')
      if (ownsFocus && previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  useLayoutEffect(() => {
    if (editingDirectory) {
      directoryInput.current?.focus({ preventScroll: true })
      directoryInput.current?.select()
    }
  }, [editingDirectory])

  useLayoutEffect(() => {
    if (replaceConfirm) confirmButton.current?.focus({ preventScroll: true })
    else nameInput.current?.focus({ preventScroll: true })
  }, [replaceConfirm])

  return <dialog ref={dialog} className="dsh-pdf-save-as dsh-pdf-glass" role="dialog" aria-modal="true"
    aria-labelledby={`${id}-title`} aria-busy={busy || picking || undefined}
    onCancel={event => { event.preventDefault(); if (!busy) onCancel() }}
    onKeyDown={event => {
      event.stopPropagation()
      if (event.key === 'Escape') { event.preventDefault(); if (!busy) onCancel() }
      // Keep a focus loop in the DOM-only fallback as well as the native modal.
      if (event.key === 'Tab') {
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')]
        const first = controls[0], last = controls[controls.length - 1]
        if (event.shiftKey && event.currentTarget.ownerDocument.activeElement === first) {
          event.preventDefault(); last?.focus()
        } else if (!event.shiftKey && event.currentTarget.ownerDocument.activeElement === last) {
          event.preventDefault(); first?.focus()
        }
      }
    }}>
    <form className="dsh-pdf-save-as-form" onSubmit={event => {
      event.preventDefault(); event.stopPropagation(); if (canSubmit) onSubmit()
    }}>
      <h2 id={`${id}-title`} className="dsh-pdf-save-as-title"><ToolbarIcon name="saveAs" />
        {t(replaceConfirm ? 'reader.replaceTitle' : 'reader.saveAsTitle')}
      </h2>
      {replaceConfirm ? <div className="dsh-pdf-save-as-replacement">
        <p>{t('reader.replaceDescription')}</p>
        <strong>{name}</strong><span title={directory}>{directory}</span>
      </div> : <>
        <label className="dsh-pdf-save-as-field" htmlFor={`${id}-name`}>
          <span>{t('reader.saveName')}</span>
          <input ref={nameInput} id={`${id}-name`} value={name} required disabled={blocked}
            spellCheck={false} autoComplete="off" aria-invalid={!!nameError || undefined}
            aria-describedby={nameError ? `${id}-name-error` : undefined}
            onChange={event => onNameChange(event.target.value)} />
        </label>
        {nameError && <p id={`${id}-name-error`} className="dsh-pdf-save-as-field-error">{nameError}</p>}
        <div className="dsh-pdf-save-as-field">
          <label htmlFor={editingDirectory ? `${id}-directory` : undefined}>{t('reader.saveLocation')}</label>
          <div className="dsh-pdf-save-as-location">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7V5h6l2 2h10v13H3V7Z" /></svg>
            {editingDirectory && !pickerAvailable ? <input ref={directoryInput} id={`${id}-directory`} value={directory}
              disabled={blocked} spellCheck={false} autoComplete="off" aria-invalid={!!directoryError || undefined}
              aria-describedby={directoryError ? `${id}-directory-error` : undefined}
              onChange={event => onDirectoryChange(event.target.value)} /> : <>
              <span className="dsh-pdf-save-as-directory" title={directory}>{directory}</span>
              <button type="button" disabled={blocked} onClick={() => {
                if (pickerAvailable) onChooseDirectory(); else setEditingDirectory(true)
              }}>{t(picking ? 'reader.pickingLocation' : 'reader.changeSaveLocation')}</button>
            </>}
          </div>
        </div>
        {directoryError && <p id={`${id}-directory-error`} className="dsh-pdf-save-as-field-error">{directoryError}</p>}
        <p className="dsh-pdf-save-as-target" role="status" aria-live="polite">
          {targetChecking ? t('reader.targetChecking') : target ? t(target.version === null ? 'reader.targetNew' : 'reader.targetExists') : ''}
        </p>
      </>}
      {error && <p className="dsh-pdf-save-as-error" role="alert">{error}</p>}
      <div className="dsh-pdf-save-as-actions">
        <button type="button" disabled={busy} onClick={replaceConfirm ? onBack : onCancel}>
          {t(replaceConfirm ? 'reader.saveBack' : 'reader.cancel')}
        </button>
        <button ref={confirmButton} type="submit" className="dsh-pdf-save-as-primary" disabled={!canSubmit}>
          {t(busy ? 'reader.saving' : replaceConfirm ? 'reader.replaceAndSave' : 'reader.saveCopy')}
        </button>
      </div>
    </form>
  </dialog>
}
