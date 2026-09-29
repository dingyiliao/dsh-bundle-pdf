import React, { useCallback, useEffect, useId, useRef, useState } from 'react'

export interface ScreenshotPreviewProps {
  image: { blob: Blob; width: number; height: number; page: number }
  t: (key: string) => string
  onClose: () => void
  onError: (error: unknown) => void
  onOcr?: () => void
}

export function ScreenshotPreview({ image, t, onClose, onError, onOcr }: ScreenshotPreviewProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const callbacks = useRef({ onClose, onError, onOcr, t })
  callbacks.current = { onClose, onError, onOcr, t }
  const alive = useRef(false)
  const closeRequested = useRef(false)
  const imageGeneration = useRef(0)
  const titleId = useId()
  const descriptionId = useId()
  const [url, setUrl] = useState<string>()
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied'>('idle')
  const [error, setError] = useState<string>()

  const requestClose = useCallback(() => {
    if (closeRequested.current) return
    closeRequested.current = true
    if (dialogRef.current?.open) dialogRef.current.close()
    callbacks.current.onClose()
  }, [])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    alive.current = true
    closeRequested.current = false
    const onCancel = (event: Event) => {
      event.preventDefault()
      requestClose()
    }
    // A StrictMode cleanup can queue a close event before the dialog reopens.
    const onNativeClose = () => { if (!dialog.open) requestClose() }
    dialog.addEventListener('cancel', onCancel)
    dialog.addEventListener('close', onNativeClose)
    try {
      dialog.showModal()
    } catch (cause) {
      callbacks.current.onError(new Error(callbacks.current.t('reader.screenshot.previewFailed'), { cause }))
      requestClose()
    }
    return () => {
      alive.current = false
      dialog.removeEventListener('cancel', onCancel)
      dialog.removeEventListener('close', onNativeClose)
      if (dialog.open) dialog.close()
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [requestClose])

  useEffect(() => {
    imageGeneration.current++
    setCopyState('idle')
    setError(undefined)
    const nextUrl = URL.createObjectURL(image.blob)
    setUrl(nextUrl)
    return () => {
      imageGeneration.current++
      URL.revokeObjectURL(nextUrl)
    }
  }, [image.blob])

  const copyImage = async () => {
    const generation = imageGeneration.current
    setError(undefined)
    const fail = (key: string, cause?: unknown) => {
      if (!alive.current || closeRequested.current || imageGeneration.current !== generation) return
      const message = callbacks.current.t(key)
      setError(message)
      setCopyState('idle')
      callbacks.current.onError(new Error(message, { cause }))
    }
    try {
      if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write
          || (typeof ClipboardItem.supports === 'function' && !ClipboardItem.supports('image/png'))) {
        fail('reader.screenshot.clipboardUnavailable')
        return
      }
      setCopyState('copying')
      // Start the write during the click gesture, without an intervening await.
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': image.blob })])
      if (alive.current && !closeRequested.current && imageGeneration.current === generation) {
        setCopyState('copied')
      }
    } catch (cause) {
      fail('reader.screenshot.copyFailed', cause)
    }
  }

  const recognize = () => {
    const callback = callbacks.current.onOcr
    requestClose()
    try { callback?.() } catch (cause) { callbacks.current.onError(cause) }
  }

  const trapFocus = (event: React.KeyboardEvent<HTMLDialogElement>) => {
    // Keep reader shortcuts (Escape, Delete, undo/save) behind the modal inactive.
    // Escape's default action still emits the dialog's native cancel event.
    event.stopPropagation()
    if (event.key !== 'Tab') return
    const dialog = event.currentTarget
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0)
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (!first) {
      event.preventDefault()
      dialog.focus()
    } else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog
        || !dialog.contains(document.activeElement))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog
        || !dialog.contains(document.activeElement))) {
      event.preventDefault()
      first.focus()
    }
  }

  return <dialog ref={dialogRef} className="dsh-pdf-screenshot-dialog" tabIndex={-1}
    aria-labelledby={titleId} aria-describedby={descriptionId} onKeyDown={trapFocus}>
    <header className="dsh-pdf-screenshot-header">
      <div>
        <h2 id={titleId} className="dsh-pdf-screenshot-title">{t('reader.screenshot.title')}</h2>
        <p id={descriptionId} className="dsh-pdf-screenshot-meta">
          {t('reader.screenshot.page')} {image.page} · {image.width} × {image.height} px
        </p>
      </div>
      <button type="button" onClick={requestClose} autoFocus>{t('reader.screenshot.close')}</button>
    </header>
    <div className="dsh-pdf-screenshot-body">
      {url && <img className="dsh-pdf-screenshot-image" src={url} width={image.width} height={image.height}
        alt={t('reader.screenshot.imageAlt')} />}
    </div>
    <footer className="dsh-pdf-screenshot-actions">
      <button type="button" onClick={() => void copyImage()} disabled={copyState === 'copying'}>
        {t(copyState === 'copying' ? 'reader.screenshot.copying' : 'reader.screenshot.copy')}
      </button>
      <a href={url} download={`pdf-page-${image.page}-region.png`} aria-disabled={!url}
        tabIndex={url ? 0 : -1} onClick={(event) => { if (!url) event.preventDefault() }}>
        {t('reader.screenshot.download')}
      </a>
      {onOcr && <button type="button" onClick={recognize}>{t('reader.screenshot.recognize')}</button>}
    </footer>
    <div className="dsh-pdf-screenshot-status" role="status" aria-live="polite">
      {copyState === 'copied' && t('reader.screenshot.copied')}
    </div>
    {error && <p className="dsh-pdf-screenshot-error" role="alert">{error}</p>}
  </dialog>
}
