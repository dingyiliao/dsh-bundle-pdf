import React from 'react'
import { AnnotationColorBar } from './AnnotationColorBar.js'
import { SplitActionControl } from './SplitActionControl.js'
import { ToolbarIcon } from './ToolbarIcon.js'

interface SelectionHighlightControlProps {
  value: string
  active: boolean
  disabled: boolean
  t: (key: string) => string
  onHighlight: (color: string) => void
}

/** Word-style split action: the main button applies; the chevron only chooses a color. */
export function SelectionHighlightControl({ value, active, disabled, t, onHighlight }: SelectionHighlightControlProps) {
  return <SplitActionControl className="dsh-pdf-selection-highlight" menuClassName="dsh-pdf-selection-highlight-menu"
    menuTestId="pdf-selection-highlight-colors" label={t('reader.highlight')} actionLabel={t('reader.highlight')}
    menuLabel={t('reader.highlightColors')} active={active} disabled={disabled}
    action={<ToolbarIcon name="highlight" accent={value} />}
    onAction={() => onHighlight(value)}>
    {close => <>
      <span className="dsh-pdf-selection-highlight-menu-title">{t('reader.highlightColors')}</span>
      <AnnotationColorBar value={value} disabled={disabled} label={t('reader.annotationColor')} t={t}
        onQuickColor={color => { close(); onHighlight(color) }}
        onPaletteColor={color => { close(); onHighlight(color) }} />
    </>}
  </SplitActionControl>
}
