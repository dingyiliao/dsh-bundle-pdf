import { useId, useLayoutEffect, useRef, useState, type HTMLAttributes, type RefObject } from 'react'
import { createPortal } from 'react-dom'

const OPEN_EVENT = 'pdf-tool-popover-open'

/** Tool menus share a reader-owned layer outside the rail's scrolling/material layers. */
export function ReaderPopover({ anchor, open, onClose, anchorStyleProperties, children, className = '', ...attributes }: {
  anchor: RefObject<HTMLElement | null>
  open: boolean
  onClose(): void
  /** Explicit layout tokens that must cross the reader-owned portal boundary. */
  anchorStyleProperties?: readonly string[]
} & HTMLAttributes<HTMLDivElement>) {
  const id = useId()
  const element = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const [owner, setOwner] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => { setOwner(anchor.current?.closest<HTMLElement>('.dsh-pdf-reader') ?? null) }, [anchor, open])
  useLayoutEffect(() => {
    if (!open || !owner || !element.current || !anchor.current) return
    const menu = element.current
    const trigger = anchor.current
    let frame = 0
    const place = () => {
      frame = 0
      // A responsive rail can replace a menu trigger with direct commands.
      // Its portal must not survive after the trigger leaves the layout.
      if (trigger.checkVisibility && !trigger.checkVisibility()) { close.current(); return }
      if (anchorStyleProperties?.length) {
        const style = trigger.ownerDocument.defaultView!.getComputedStyle(trigger)
        for (const property of anchorStyleProperties) menu.style.setProperty(property, style.getPropertyValue(property))
      }
      const origin = owner.getBoundingClientRect()
      const rail = trigger.closest('[data-pdf-tool-rail]')?.getBoundingClientRect()
      const content = rail ? null : owner.querySelector<HTMLElement>('.dsh-pdf-scroll')
      const bounds = content?.getBoundingClientRect() ?? origin
      const button = trigger.getBoundingClientRect()
      const clips = [trigger.closest('.dsh-pdf-tool-middle'), trigger.closest('.dsh-pdf-rail-shell')]
      if (button.height > 0 && clips.some(element => {
        const clip = element?.getBoundingClientRect()
        return clip && clip.height > 0 && (button.bottom <= clip.top || button.top >= clip.bottom)
      })) { close.current(); return }
      const preferredLeft = rail ? rail.right + 8 : button.left
      menu.style.maxWidth = `${Math.max(0, rail ? bounds.right - preferredLeft - 8 : bounds.width - 16)}px`
      menu.style.maxHeight = `${Math.max(0, bounds.height - 16)}px`
      const left = Math.max(bounds.left + 8, Math.min(preferredLeft, bounds.right - menu.offsetWidth - 8))
      const desiredTop = rail ? button.top : button.bottom + 8 + menu.offsetHeight <= bounds.bottom - 8
        ? button.bottom + 8 : button.top - menu.offsetHeight - 8
      const top = Math.max(bounds.top + 8, Math.min(desiredTop, bounds.bottom - menu.offsetHeight - 8))
      menu.style.left = `${left - origin.left}px`
      menu.style.top = `${top - origin.top}px`
      menu.style.transformOrigin = `0 ${Math.max(0, button.top + button.height / 2 - top)}px`
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(place) }
    menu.dataset.pdfPopoverParent = trigger.closest<HTMLElement>('[data-pdf-popover-id]')?.dataset.pdfPopoverId ?? ''
    const ownsPopupTarget = (target: Node): boolean => {
      if (menu.contains(target)) return true
      let popup = target instanceof Element ? target.closest<HTMLElement>('[data-pdf-popover-id]') : null
      const seen = new Set<string>()
      while (popup?.dataset.pdfPopoverParent && !seen.has(popup.dataset.pdfPopoverParent)) {
        const parent = popup.dataset.pdfPopoverParent
        if (parent === id) return true
        seen.add(parent)
        popup = [...owner.querySelectorAll<HTMLElement>('[data-pdf-popover-id]')].find(item => item.dataset.pdfPopoverId === parent) ?? null
      }
      return false
    }
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !ownsPopupTarget(event.target) && !trigger.contains(event.target)) close.current()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Inactive PDF tabs can remain mounted with their menu state intact.
      // Only the Reader receiving this key may dismiss a menu or move focus.
      const doc = owner.ownerDocument
      const target = event.target instanceof Element && event.target !== doc.body && event.target !== doc.documentElement
        ? event.target : doc.activeElement
      const keyOwner = target?.closest('.dsh-pdf-reader')
      if (keyOwner ? keyOwner !== owner : target && target !== doc.body && target !== doc.documentElement) return
      if (!keyOwner && [...doc.querySelectorAll<HTMLElement>('[data-pdf-popover-id]:not([hidden])')]
        .some(item => item.closest('.dsh-pdf-reader') !== owner)) return
      if ([...owner.querySelectorAll<HTMLElement>('[data-pdf-popover-parent]')]
        .some(item => !item.hidden && item.dataset.pdfPopoverParent === id)) return
      event.preventDefault(); event.stopImmediatePropagation()
      close.current(); trigger.focus({ preventScroll: true })
    }
    const anotherMenu = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string; anchor: HTMLElement }>).detail
      if (detail.id !== id && !ownsPopupTarget(detail.anchor)) close.current()
    }
    const ReaderEvent = owner.ownerDocument.defaultView?.CustomEvent ?? CustomEvent
    owner.dispatchEvent(new ReaderEvent(OPEN_EVENT, { detail: { id, anchor: trigger } }))
    owner.addEventListener(OPEN_EVENT, anotherMenu)
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    owner.addEventListener('scroll', schedule, true)
    const observer = new ResizeObserver(schedule)
    observer.observe(owner); observer.observe(menu); observer.observe(trigger)
    const scrollport = owner.querySelector<HTMLElement>('.dsh-pdf-scroll')
    if (scrollport) {
      observer.observe(scrollport)
      scrollport.addEventListener('pdfviewchange', schedule)
      scrollport.addEventListener('pdflayoutchange', schedule)
      scrollport.addEventListener('pdfcontextchange', schedule)
    }
    place()
    if (trigger.matches(':focus-visible')) menu.querySelector<HTMLElement>('button:not(:disabled), input, textarea')?.focus({ preventScroll: true })
    return () => {
      cancelAnimationFrame(frame); observer.disconnect()
      owner.removeEventListener(OPEN_EVENT, anotherMenu)
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape, true)
      owner.removeEventListener('scroll', schedule, true)
      scrollport?.removeEventListener('pdfviewchange', schedule)
      scrollport?.removeEventListener('pdflayoutchange', schedule)
      scrollport?.removeEventListener('pdfcontextchange', schedule)
    }
  }, [open, owner, anchor, id, anchorStyleProperties])
  const content = <div {...attributes} ref={element} hidden={!open}
    className={`dsh-pdf-reader-popover ${className}`} data-pdf-tool-popover="" data-pdf-popover-id={id}>{children}</div>
  return owner ? createPortal(content, owner) : content
}
