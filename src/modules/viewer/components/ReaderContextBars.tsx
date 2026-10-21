import React from 'react'
import type { PdfAnnotation } from '../../../core/pdf-types.js'
import type { ReaderSelection } from '../model/reader-selection.js'
import { FloatingToolbar } from './FloatingToolbar.js'
import { ToolbarTooltip } from './ToolbarTooltip.js'
import { ToolbarIcon, type ToolbarIconName } from './ToolbarIcon.js'
import { SelectionHighlightControl } from './SelectionHighlightControl.js'
import { AnnotationColorBar } from './AnnotationColorBar.js'

type TextMark = 'Highlight' | 'Underline' | 'StrikeOut'
const textMarkIcons: Partial<Record<PdfAnnotation['subtype'], ToolbarIconName>> = {
  Highlight: 'highlight', Underline: 'underline', StrikeOut: 'strike',
}

export interface ReaderSelectionBarProps {
  viewport: HTMLElement | null
  getAnchor(): DOMRect | null
  active: boolean
  selection: ReaderSelection | null
  textCopied: boolean
  canExplain: boolean
  explanationSending: boolean
  editable: boolean
  color: string
  setColor(value: string): void
  copyText(): void
  explain(selection?: ReaderSelection): void
  translate(): void
  mark(subtype: TextMark, color?: string): void
  beginNote(page: number, point: number[]): void
  clearSelection(): void
  t(key: string): string
}

/** Actions that operate on a live browser text selection, not a saved annotation. */
export function ReaderSelectionBar(props: ReaderSelectionBarProps) {
  const { viewport, getAnchor, active, selection, textCopied, canExplain, explanationSending,
    editable, color, setColor, copyText, explain, translate, mark, beginNote, clearSelection, t } = props
  return <FloatingToolbar viewport={viewport} getAnchor={getAnchor} label={t('reader.textActions')} active={active}>
    <ToolbarTooltip><div className="dsh-pdf-selection-actions">
      <button type="button" className="dsh-pdf-selection-icon-action"
        aria-label={t(textCopied ? 'reader.textCopied' : 'reader.copyText')}
        data-tooltip={t(textCopied ? 'reader.textCopied' : 'reader.copyText')}
        onClick={copyText}><ToolbarIcon name="copy" /></button>
      {canExplain && <button type="button" className="dsh-pdf-selection-icon-action" disabled={explanationSending}
        aria-label={t('reader.explain.askQuestion')} data-tooltip={t('reader.explain.askQuestion')}
        onClick={() => explain(selection ?? undefined)}><ToolbarIcon name="explain" /></button>}
      <button type="button" className="dsh-pdf-selection-icon-action" aria-label={t('reader.translateSelection')}
        data-tooltip={t('reader.translateSelection')} onClick={translate}><ToolbarIcon name="translate" /></button>
      <span className="dsh-pdf-selection-actions-divider" aria-hidden="true" />
      <SelectionHighlightControl value={color} active={active} disabled={!editable} t={t}
        onHighlight={hex => { setColor(hex); mark('Highlight', hex) }} />
      <button type="button" className="dsh-pdf-selection-icon-action" disabled={!editable}
        aria-label={t('reader.underline')} data-tooltip={t('reader.underline')}
        onClick={() => mark('Underline')}><ToolbarIcon name="underline" /></button>
      <button type="button" className="dsh-pdf-selection-icon-action" disabled={!editable}
        aria-label={t('reader.strike')} data-tooltip={t('reader.strike')}
        onClick={() => mark('StrikeOut')}><ToolbarIcon name="strike" /></button>
      <button type="button" className="dsh-pdf-selection-icon-action" disabled={!editable}
        aria-label={t('reader.note')} data-tooltip={t('reader.note')} onClick={() => {
          const fragment = selection?.fragments[0]
          if (fragment) { beginNote(fragment.page, [fragment.rect[0], fragment.rect[3]]); clearSelection() }
        }}><ToolbarIcon name="note" /></button>
      <span className="dsh-pdf-selection-actions-divider" aria-hidden="true" />
      <button type="button" className="dsh-pdf-selection-icon-action" aria-label={t('reader.clearSelection')}
        data-tooltip={t('reader.clearSelection')} onClick={clearSelection}><ToolbarIcon name="close" /></button>
    </div></ToolbarTooltip>
  </FloatingToolbar>
}

export interface ReaderAnnotationBarProps {
  viewport: HTMLElement | null
  getAnchor(): DOMRect | null
  selected?: PdfAnnotation
  commentActionAvailable: boolean
  annotationColor: string
  readOnly: boolean
  editable: boolean
  updateColor(value: string): void
  openCommentEditor(): void
  deleteAnnotation(): void
  clearAnnotation(): void
  t(key: string): string
}

/** Actions on an existing PDF annotation; text marks and notes keep distinct identities. */
export function ReaderAnnotationBar(props: ReaderAnnotationBarProps) {
  const { viewport, getAnchor, selected, commentActionAvailable, annotationColor, readOnly, editable,
    updateColor, openCommentEditor, deleteAnnotation, clearAnnotation, t } = props
  // A standalone Text annotation is represented by its marker/card pair. It
  // has no separate selection toolbar; the open card owns its actions.
  if (!selected || selected.subtype === 'Text') return null
  const markIcon = textMarkIcons[selected.subtype]
  return <FloatingToolbar viewport={viewport} getAnchor={getAnchor} label={t('reader.selectedAnnotation')}
    className="dsh-pdf-annotation-toolbar">
    <span className="dsh-pdf-annotation-kind" title={t('reader.selectedAnnotation')}>
      {markIcon ? <ToolbarIcon name={markIcon} />
        : <span className="dsh-pdf-annotation-kind-color" style={{ backgroundColor: annotationColor }} aria-hidden="true" />}
      {selected.supported ? t(`reader.type.${selected.subtype}`) : selected.subtype}
    </span>
    <>
      <span className="dsh-pdf-annotation-actions-divider" aria-hidden="true" />
      {markIcon && <AnnotationColorBar value={annotationColor} disabled={readOnly || !selected.editable}
        label={t('reader.annotationColor')} t={t} onQuickColor={updateColor} onPaletteColor={updateColor} />}
      {markIcon && <span className="dsh-pdf-annotation-actions-divider" aria-hidden="true" />}
      {markIcon && <button className="dsh-pdf-annotation-action" title={t('reader.commentText')} aria-label={t('reader.commentText')}
        disabled={!commentActionAvailable} onClick={openCommentEditor}><ToolbarIcon name="comment" /></button>}
    </>
    <button className="dsh-pdf-annotation-action dsh-pdf-annotation-action-danger" title={t('reader.delete')}
      aria-label={t('reader.delete')} disabled={!editable || !selected.editable} onClick={deleteAnnotation}>
      <ToolbarIcon name="discard" />
    </button>
    <span className="dsh-pdf-annotation-actions-divider" aria-hidden="true" />
    <button className="dsh-pdf-annotation-action" title={t('reader.deselectAnnotation')}
      aria-label={t('reader.deselectAnnotation')} onClick={clearAnnotation}><ToolbarIcon name="close" /></button>
  </FloatingToolbar>
}
