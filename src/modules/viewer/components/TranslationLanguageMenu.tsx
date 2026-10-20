import React, { useEffect, useRef } from 'react'
import { translationTargetLanguages } from '../../../shared/contracts.js'
import { ToolbarIcon } from './ToolbarIcon.js'

export function TranslationLanguageMenu({ value, label, languageName, onChange }: {
  value: string
  label: string
  languageName: (language: string) => string
  onChange: (language: string) => void
}) {
  const details = useRef<HTMLDetailsElement>(null)
  const trigger = useRef<HTMLElement>(null)

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && details.current && !details.current.contains(event.target)) details.current.open = false
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [])

  return <details ref={details} className="dsh-pdf-translation-language" onToggle={event => {
    if (!event.currentTarget.open) return
    const menu = event.currentTarget.querySelector<HTMLElement>('.dsh-pdf-translation-language-menu')
    const panel = event.currentTarget.closest<HTMLElement>('.dsh-pdf-panel-scroll')
    if (!menu || !panel) return
    const bounds = panel.getBoundingClientRect()
    const anchor = event.currentTarget.getBoundingClientRect()
    menu.style.width = `${Math.min(160, Math.max(0, bounds.width - 24))}px`
    const left = Math.max(bounds.left + 12, Math.min(anchor.left, bounds.right - 12 - menu.offsetWidth))
    menu.style.left = `${left - anchor.left}px`
    const below = bounds.bottom - anchor.bottom - 19
    const above = anchor.top - bounds.top - 19
    if (menu.scrollHeight > below && above > below) {
      menu.style.top = 'auto'
      menu.style.bottom = 'calc(100% + 7px)'
      menu.style.maxHeight = `${Math.max(0, above)}px`
    } else {
      menu.style.top = 'calc(100% + 7px)'
      menu.style.bottom = 'auto'
      menu.style.maxHeight = `${Math.max(0, below)}px`
    }
  }} onBlur={event => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false
  }} onKeyDown={event => {
    if (event.key !== 'Escape' || !event.currentTarget.open) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.open = false
    trigger.current?.focus()
  }}>
    <summary ref={trigger} className="dsh-pdf-translation-language-trigger" aria-label={`${label}: ${languageName(value)}`}>
      <span>{languageName(value)}</span><ToolbarIcon name="chevronDown" />
    </summary>
    <div className="dsh-pdf-tools-menu dsh-pdf-translation-language-menu" role="group" aria-label={label}>
      {translationTargetLanguages.map(language => <button key={language} type="button" aria-label={languageName(language)} aria-pressed={language === value}
        onClick={() => {
          if (details.current) details.current.open = false
          trigger.current?.focus()
          if (language !== value) onChange(language)
        }}>{languageName(language)}</button>)}
    </div>
  </details>
}
