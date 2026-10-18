import React, { useEffect, useRef, useState } from 'react'
import {
  addHighlightQuickColor,
  editHighlightQuickColor,
  HIGHLIGHT_QUICK_COLORS_KEY,
  MAX_HIGHLIGHT_QUICK_COLORS,
  normalizeHighlightColor,
  readHighlightQuickColors,
  removeHighlightQuickColor,
} from './highlight-colors.js'

interface AnnotationColorBarProps {
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

const changeEvent = 'dsh-pdf:highlight-quick-colors-change'

function persistColors(colors: string[]): void {
  try { localStorage.setItem(HIGHLIGHT_QUICK_COLORS_KEY, JSON.stringify(colors)) } catch { /* Private-mode storage may be unavailable. */ }
  window.dispatchEvent(new CustomEvent<string[]>(changeEvent, { detail: colors }))
}

/**
 * Five editable quick slots plus a native palette. No silent replacement at
 * capacity. Highlight, underline and strike-out share one bar and one saved
 * palette, so the mark color is chosen the same way whichever action created it.
 */
export function AnnotationColorBar({ value, disabled = false, onQuickColor, onPaletteColor, label, t }: AnnotationColorBarProps) {
  const [colors, setColors] = useState(readHighlightQuickColors)
  const [menuIndex, setMenuIndex] = useState<number | null>(null)
  const [menuError, setMenuError] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)
  const swatchRefs = useRef<(HTMLButtonElement | null)[]>([])
  const chosen = normalizeHighlightColor(value)
  const isDuplicate = chosen !== null && colors.includes(chosen)
  const isFull = colors.length >= MAX_HIGHLIGHT_QUICK_COLORS
  const cannotAdd = !chosen || isDuplicate || isFull
  const addReason = isFull ? t('reader.quickColorsFull') : isDuplicate ? t('reader.colorAlreadySaved') : ''

  useEffect(() => {
    const synchronize = (event: Event) => {
      const next = event instanceof CustomEvent ? event.detail as string[] : readHighlightQuickColors()
      setColors((current) => current.length === next.length && current.every((color, index) => color === next[index]) ? current : next)
    }
    const synchronizeStorage = (event: StorageEvent) => {
      if (event.key === HIGHLIGHT_QUICK_COLORS_KEY || event.key === null) synchronize(event)
    }
    window.addEventListener(changeEvent, synchronize)
    window.addEventListener('storage', synchronizeStorage)
    return () => {
      window.removeEventListener(changeEvent, synchronize)
      window.removeEventListener('storage', synchronizeStorage)
    }
  }, [])

  useEffect(() => {
    if (menuIndex === null) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node) || (!menuRef.current?.contains(target) && !swatchRefs.current[menuIndex]?.contains(target))) {
        setMenuIndex(null)
        setMenuError('')
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setMenuIndex(null)
      setMenuError('')
      swatchRefs.current[menuIndex]?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuIndex])

  const updateColors = (next: string[]) => {
    setColors(next)
    persistColors(next)
  }

  return <div className="dsh-pdf-highlight-colors" data-testid="pdf-highlight-colors" role="group" aria-label={t('reader.quickColor')}>
    {colors.length > 0 && <div className="dsh-pdf-highlight-swatches">
      {colors.map((hex, index) => <span className="dsh-pdf-highlight-swatch-wrap" key={index}>
        <button type="button" ref={(element) => { swatchRefs.current[index] = element }}
          className="dsh-pdf-highlight-swatch" data-testid={`pdf-highlight-swatch-${index}`}
          disabled={disabled} aria-pressed={chosen === hex}
          aria-label={`${t('reader.quickColor')} ${index + 1}: ${hex}`}
          title={`${t('reader.quickColor')} ${index + 1}: ${hex}`}
          onClick={() => { setMenuIndex(null); onQuickColor(hex) }}
          onContextMenu={(event) => {
            event.preventDefault()
            if (!disabled) { setMenuIndex(index); setMenuError('') }
          }}><span className="dsh-pdf-highlight-swatch-core" style={{ backgroundColor: hex }} aria-hidden="true" /></button>
        {menuIndex === index && <div ref={menuRef} className="dsh-pdf-highlight-menu" data-testid="pdf-highlight-color-menu"
          role="dialog" aria-label={`${t('reader.quickColor')} ${index + 1}`} style={index >= 3 ? { right: 0 } : { left: 0 }}>
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
        </div>}
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
