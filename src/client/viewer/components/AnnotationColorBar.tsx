import { useEffect, useRef, useState } from 'react'
import { ReaderPopover } from './ReaderPopover.js'
import {
  addHighlightQuickColor,
  editHighlightQuickColor,
  HIGHLIGHT_QUICK_COLORS_KEY,
  NOTE_QUICK_COLORS_KEY,
  MAX_HIGHLIGHT_QUICK_COLORS,
  normalizeHighlightColor,
  readHighlightQuickColors,
  readNoteQuickColors,
  removeHighlightQuickColor,
} from '../model/highlight-colors.js'

interface AnnotationColorBarProps {
  palette?: 'markup' | 'note'
  value: string
  disabled?: boolean
  /** Clicking a saved color immediately applies it to the current selection. */
  onQuickColor: (hex: string) => void
  /** Choosing a palette color applies it to the current selection. */
  onPaletteColor: (hex: string) => void
  /** Kept on the native color input for existing reader accessibility and automation. */
  label: string
  t: (key: string) => string
}

const changeEvent = 'dsh-pdf:quick-colors-change'

function persistColors(key: string, colors: string[]): void {
  try { localStorage.setItem(key, JSON.stringify(colors)) } catch { /* Private-mode storage may be unavailable. */ }
  window.dispatchEvent(new CustomEvent(changeEvent, { detail: { key, colors } }))
}

/**
 * Five editable quick slots plus a native palette. No silent replacement at
 * capacity. Text marks share one saved palette; standalone notes reuse the
 * interaction with a separate set so paper colors do not edit markup colors.
 */
export function AnnotationColorBar({ palette = 'markup', value, disabled = false, onQuickColor, onPaletteColor, label, t }: AnnotationColorBarProps) {
  const storageKey = palette === 'note' ? NOTE_QUICK_COLORS_KEY : HIGHLIGHT_QUICK_COLORS_KEY
  const readColors = palette === 'note' ? readNoteQuickColors : readHighlightQuickColors
  const [colors, setColors] = useState(readColors)
  const [menuIndex, setMenuIndex] = useState<number | null>(null)
  const [menuError, setMenuError] = useState('')
  const menuAnchor = useRef<HTMLButtonElement | null>(null)
  const chosen = normalizeHighlightColor(value)
  const isDuplicate = chosen !== null && colors.includes(chosen)
  const isFull = colors.length >= MAX_HIGHLIGHT_QUICK_COLORS
  const cannotAdd = !chosen || isDuplicate || isFull
  const addReason = isFull ? t('reader.quickColorsFull') : isDuplicate ? t('reader.colorAlreadySaved') : ''

  useEffect(() => {
    const synchronize = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail as { key: string; colors: string[] } : null
      if (detail && detail.key !== storageKey) return
      const next = detail?.colors ?? readColors()
      setColors((current) => current.length === next.length && current.every((color, index) => color === next[index]) ? current : next)
    }
    const synchronizeStorage = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null) synchronize(event)
    }
    window.addEventListener(changeEvent, synchronize)
    window.addEventListener('storage', synchronizeStorage)
    return () => {
      window.removeEventListener(changeEvent, synchronize)
      window.removeEventListener('storage', synchronizeStorage)
    }
  }, [storageKey, readColors])

  useEffect(() => {
    if (menuIndex === null) return
    if (disabled) { setMenuIndex(null); setMenuError('') }
  }, [menuIndex, disabled])

  const updateColors = (next: string[]) => {
    setColors(next)
    persistColors(storageKey, next)
  }

  return <div className="dsh-pdf-highlight-colors" data-testid={palette === 'note' ? 'pdf-note-colors' : 'pdf-highlight-colors'} role="group" aria-label={t('reader.quickColor')}>
    {colors.length > 0 && <div className="dsh-pdf-highlight-swatches">
      {colors.map((hex, index) => <span className="dsh-pdf-highlight-swatch-wrap" key={index}>
        <button type="button"
          className="dsh-pdf-highlight-swatch" data-testid={`pdf-highlight-swatch-${index}`}
          disabled={disabled} aria-pressed={chosen === hex}
          aria-label={`${t('reader.quickColor')} ${index + 1}: ${hex}`}
          title={`${t('reader.quickColor')} ${index + 1}: ${hex}`}
          onClick={() => { setMenuIndex(null); onQuickColor(hex) }}
          onContextMenu={(event) => {
            event.preventDefault()
            if (!disabled) { menuAnchor.current = event.currentTarget; setMenuIndex(index); setMenuError('') }
          }}><span className="dsh-pdf-highlight-swatch-core" style={{ backgroundColor: hex }} aria-hidden="true" /></button>
        {menuIndex === index && <ReaderPopover anchor={menuAnchor} open onClose={() => { setMenuIndex(null); setMenuError('') }}
          className="dsh-pdf-highlight-menu" data-testid="pdf-highlight-color-menu"
          role="dialog" aria-label={`${t('reader.quickColor')} ${index + 1}`}>
          <label className="dsh-pdf-highlight-menu-edit">{t('reader.editQuickColor')}
            <input type="color" data-testid="pdf-highlight-edit-color" aria-label={t('reader.editQuickColor')}
              value={hex} onChange={(event) => {
                const next = editHighlightQuickColor(colors, index, event.target.value)
                if (!next) { setMenuError(t('reader.colorAlreadySaved')); return }
                updateColors(next)
                setMenuError('')
              }} />
          </label>
          <button type="button" data-testid="pdf-highlight-delete-color" onClick={() => {
            updateColors(removeHighlightQuickColor(colors, index))
            setMenuIndex(null)
            setMenuError('')
          }}>{t('reader.deleteQuickColor')}</button>
          {menuError && <span className="dsh-pdf-highlight-menu-error" role="status">{menuError}</span>}
        </ReaderPopover>}
      </span>)}
    </div>}
    <span className="dsh-pdf-highlight-palette-wrap" title={t('reader.colorPalette')}>
      <span className="dsh-pdf-highlight-palette-wheel" aria-hidden="true">
        <span className="dsh-pdf-highlight-palette-current" style={{ backgroundColor: chosen ?? '#ffff00' }} />
      </span>
      <input type="color" className="dsh-pdf-highlight-palette" data-testid="pdf-highlight-palette"
        aria-label={label} value={chosen ?? '#ffff00'} disabled={disabled}
        onChange={(event) => { setMenuIndex(null); onPaletteColor(event.target.value) }} />
    </span>
    {!isDuplicate && <button type="button" className="dsh-pdf-highlight-add" data-testid="pdf-highlight-add-color"
      disabled={disabled || cannotAdd} title={addReason || t('reader.addQuickColor')}
      aria-label={addReason ? `${t('reader.addQuickColor')}: ${addReason}` : t('reader.addQuickColor')}
      onClick={() => {
        const next = addHighlightQuickColor(colors, value)
        if (next) updateColors(next)
      }}><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button>}
    {!isDuplicate && addReason && <span className="dsh-pdf-visually-hidden" role="status">{addReason}</span>}
  </div>
}
