import React, { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MAX_EXPLANATION_ITEM_QUESTION_CHARACTERS } from '../../explanation/index.js'

export interface ExplanationQuestionEditorProps {
  viewport: HTMLElement | null
  getAnchor(): DOMRect | null
  mode: 'new' | 'edit'
  index: number
  question: string
  disabled: boolean
  t(key: string): string
  onChange(value: string): void
  onSave(): void
  onCancel(): void
  onDelete?(): void
}

interface EditorPlacement {
  left: number
  top: number
  width: number
  side: 'above' | 'below'
}

const EDGE_GAP = 12
const ANCHOR_GAP = 10

/** A short-lived question draft anchored to a PDF selection or saved mark. */
export function ExplanationQuestionEditor({ viewport, getAnchor, mode, index, question, disabled, t,
  onChange, onSave, onCancel, onDelete }: ExplanationQuestionEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const focusedRef = useRef(false)
  const anchorRef = useRef(getAnchor)
  anchorRef.current = getAnchor
  const [placement, setPlacement] = useState<EditorPlacement | null>(null)
  const canSave = !!question.trim() && !disabled
  const portalRoot = viewport?.closest<HTMLElement>('.dsh-pdf-reader') ?? null

  useLayoutEffect(() => {
    if (!placement || focusedRef.current) return
    const input = inputRef.current
    if (!input) return
    const frame = requestAnimationFrame(() => {
      input.focus({ preventScroll: true })
      if (document.activeElement === input) {
        input.setSelectionRange(input.value.length, input.value.length)
        focusedRef.current = true
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [placement !== null])

  useLayoutEffect(() => {
    const editor = editorRef.current
    if (!editor || !viewport || !portalRoot) return
    let frame = 0

    const update = () => {
      const anchor = anchorRef.current()
      if (!anchor) { setPlacement(null); return }
      const bounds = viewport.getBoundingClientRect()
      if (anchor.bottom <= bounds.top || anchor.top >= bounds.bottom
        || anchor.right <= bounds.left || anchor.left >= bounds.right) { setPlacement(null); return }
      const width = Math.max(0, Math.min(360, bounds.width - EDGE_GAP * 2, window.innerWidth - EDGE_GAP * 2))
      if (!width) { setPlacement(null); return }
      editor.style.width = `${width}px`

      const leftEdge = Math.max(bounds.left + EDGE_GAP, EDGE_GAP)
      const rightEdge = Math.min(bounds.right - EDGE_GAP, window.innerWidth - EDGE_GAP)
      const height = editor.offsetHeight
      const center = anchor.left + anchor.width / 2
      const left = Math.min(Math.max(center - width / 2, leftEdge), Math.max(leftEdge, rightEdge - width))
      const controls = viewport.closest('.dsh-pdf-reader')?.querySelector<HTMLElement>('.dsh-pdf-floating-controls-layout')
      const controlsBottom = controls?.getBoundingClientRect().bottom ?? 0
      const topEdge = Math.max(bounds.top + EDGE_GAP, controlsBottom + (controls ? 8 : 0))
      const bottomEdge = Math.min(bounds.bottom - EDGE_GAP, window.innerHeight - EDGE_GAP)
      const above = anchor.top - height - ANCHOR_GAP
      const below = anchor.bottom + ANCHOR_GAP
      const fitsAbove = above >= topEdge
      const fitsBelow = below + height <= bottomEdge
      const side: EditorPlacement['side'] = fitsAbove || (!fitsBelow && anchor.top - topEdge > bottomEdge - anchor.bottom)
        ? 'above' : 'below'
      const desiredTop = side === 'above' ? above : below
      const top = Math.max(topEdge, Math.min(desiredTop, Math.max(topEdge, bottomEdge - height)))
      const rootBounds = portalRoot.getBoundingClientRect()
      const relativeLeft = left - rootBounds.left
      const relativeTop = top - rootBounds.top
      setPlacement(previous => previous?.left === relativeLeft && previous.top === relativeTop
        && previous.width === width && previous.side === side
        ? previous : { left: relativeLeft, top: relativeTop, width, side })
    }
    const schedule = () => {
      if (frame) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => { frame = 0; update() })
    }

    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    observer?.observe(viewport)
    observer?.observe(editor)
    observer?.observe(portalRoot)
    const controls = portalRoot.querySelector<HTMLElement>('.dsh-pdf-floating-controls-layout')
    if (controls) observer?.observe(controls)
    const controlsObserver = controls ? new MutationObserver(schedule) : null
    if (controls) controlsObserver?.observe(controls, { childList: true, subtree: true, characterData: true })
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      observer?.disconnect()
      controlsObserver?.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
    }
  }, [viewport, portalRoot, mode])

  if (!portalRoot) return null
  return createPortal(<div ref={editorRef} role="dialog" aria-modal="false" aria-label={t('reader.explain.askQuestion')}
    className="dsh-pdf-explanation-question-editor" data-side={placement?.side}
    style={placement ? { left: placement.left, top: placement.top, width: placement.width } : { visibility: 'hidden' }}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canSave) {
        event.preventDefault(); event.stopPropagation(); onSave()
      }
    }}>
    <label className="dsh-pdf-explanation-question-label" htmlFor={`dsh-pdf-explanation-question-${index}`}>
      {t('reader.explain.askQuestion')}
    </label>
    <textarea ref={inputRef} id={`dsh-pdf-explanation-question-${index}`} rows={3} required
      maxLength={MAX_EXPLANATION_ITEM_QUESTION_CHARACTERS} value={question} disabled={disabled}
      placeholder={t('reader.explain.itemQuestionPlaceholder')}
      onChange={event => onChange(event.target.value)} />
    <div className="dsh-pdf-explanation-question-actions">
      {mode === 'edit' && onDelete && <button type="button" className="dsh-pdf-explanation-question-delete"
        aria-label={t('reader.explain.deleteQuestion')} title={t('reader.explain.deleteQuestion')}
        disabled={disabled} onClick={onDelete}>
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
          <path d="M3.75 5.5h12.5M8 5.5V3.75h4V5.5m-6.75 0 .7 10.25c.03.42.39.75.81.75h6.48c.42 0 .78-.33.81-.75l.7-10.25M8.25 8.5v5M11.75 8.5v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>}
      <span className="dsh-pdf-explanation-question-spacer" />
      <button type="button" onClick={onCancel} disabled={disabled}>{t('reader.cancel')}</button>
      <button type="button" className="dsh-pdf-explanation-question-save" onClick={onSave} disabled={!canSave}>
        {t('reader.save')}
      </button>
    </div>
  </div>, portalRoot)
}
