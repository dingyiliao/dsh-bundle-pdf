import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import React, { act, useRef, useState, type ReactNode } from 'react'
import { ReaderPopover } from '../../../src/modules/viewer/components/ReaderPopover.js'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

async function withDom(run: (dom: Window & typeof globalThis, container: HTMLElement,
  render: (element: React.ReactElement) => Promise<void>) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div><input id="outside" /></body></html>', { url: 'http://localhost' }).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom, document: dom.document,
    HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, CustomEvent: dom.CustomEvent,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id), IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const container = dom.document.getElementById('root')!
  const root = createRoot(container)
  try { await run(dom, container, async element => { await act(async () => { root.render(element) }) }) }
  finally {
    await act(async () => { root.unmount() })
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

function Menu({ name, children }: { name: string; children?: ReactNode }) {
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return React.createElement(React.Fragment, null,
    React.createElement('button', { ref: trigger, 'data-trigger': name, 'aria-expanded': open,
      onClick: () => setOpen(value => !value) }, name),
    open && React.createElement(ReaderPopover, { anchor: trigger, open, onClose: () => setOpen(false),
      'aria-label': name }, React.createElement('button', { 'data-option': name }, 'Option'), children))
}

const reader = (name: string, children: ReactNode = React.createElement(Menu, { name })) =>
  React.createElement('div', { className: 'dsh-pdf-reader', 'data-reader': name }, children)

test('reader-owned portals inherit only requested anchor layout tokens and refresh after layout changes', async () => {
  await withDom(async (dom, container, render) => {
    const token = '--pdf-document-history-display'
    const style = dom.document.createElement('style')
    style.textContent = `
      .layout-short [data-trigger="document"] { ${token}: flex; --pdf-private-token: scoped; }
      .layout-tall [data-trigger="document"] { ${token}: none; --pdf-private-token: scoped; }
    `
    dom.document.head.append(style)
    function DocumentMenu() {
      const anchor = useRef<HTMLButtonElement>(null)
      return reader('pdf', React.createElement('div', { className: 'layout-short', 'data-layout-scope': '' },
        React.createElement('div', { className: 'dsh-pdf-scroll' }),
        React.createElement('button', { ref: anchor, 'data-trigger': 'document' }, 'Document actions'),
        React.createElement(ReaderPopover, { anchor, open: true, anchorStyleProperties: [token],
          onClose: () => assert.fail('the open document menu must survive a layout change'),
          'aria-label': 'Document actions' }, React.createElement('button', null, 'Undo'))))
    }
    await render(React.createElement(DocumentMenu))
    const owner = container.querySelector<HTMLElement>('.dsh-pdf-reader')!
    const scope = container.querySelector<HTMLElement>('[data-layout-scope]')!
    const trigger = scope.querySelector<HTMLButtonElement>('[data-trigger="document"]')!
    const menu = owner.querySelector<HTMLElement>('[data-pdf-tool-popover]')!
    assert.equal(menu.parentElement, owner, 'the portal escapes the scoped rail layout')
    assert.equal(scope.contains(menu), false)
    assert.equal(trigger.style.getPropertyValue(token), '', 'the token comes from computed CSS, not inline styles')
    assert.equal(menu.style.getPropertyValue(token), 'flex', 'short layouts expose history commands in the portal')
    assert.equal(menu.style.getPropertyValue('--pdf-private-token'), '', 'unrequested styles stay inside the anchor scope')

    await act(async () => {
      scope.className = 'layout-tall'
      scope.querySelector('.dsh-pdf-scroll')!.dispatchEvent(new dom.Event('pdflayoutchange'))
      await new Promise(resolve => setTimeout(resolve, 10))
    })
    assert.equal(owner.querySelector('[data-pdf-tool-popover]'), menu, 'layout changes update the existing portal')
    assert.equal(menu.style.getPropertyValue(token), 'none', 'the latest anchor token replaces the short-layout value')
    assert.equal(menu.style.getPropertyValue('--pdf-private-token'), '')
  })
})

test('Escape follows the focused Reader instead of an earlier mounted PDF menu', async () => {
  await withDom(async (dom, container, render) => {
    await render(React.createElement(React.Fragment, null, reader('first'), reader('second')))
    const trigger = (name: string) => container.querySelector<HTMLButtonElement>(`[data-trigger="${name}"]`)!
    // Keyboard activation synthesizes click without an outside pointerdown;
    // the previous PDF tab may therefore retain its open menu while hidden.
    for (const name of ['first', 'second']) await act(async () => { trigger(name).click() })
    assert.equal(trigger('first').getAttribute('aria-expanded'), 'true')
    const secondOption = container.querySelector<HTMLButtonElement>('[data-option="second"]')!
    secondOption.focus()
    await act(async () => { secondOption.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    assert.equal(trigger('first').getAttribute('aria-expanded'), 'true', 'the other PDF retains its independent menu state')
    assert.equal(trigger('second').getAttribute('aria-expanded'), 'false', 'Escape closes the menu receiving the key')
    assert.equal(dom.document.activeElement, trigger('second'), 'focus stays in the active PDF')

    container.querySelector<HTMLButtonElement>('[data-option="first"]')!.focus()
    await act(async () => { dom.document.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    assert.equal(trigger('first').getAttribute('aria-expanded'), 'false', 'document-level synthetic keys use the active element')
    assert.equal(dom.document.activeElement, trigger('first'))
  })
})

test('Escape outside every Reader does not dismiss a PDF menu or steal focus', async () => {
  await withDom(async (dom, container, render) => {
    await render(reader('pdf'))
    const trigger = container.querySelector<HTMLButtonElement>('[data-trigger="pdf"]')!
    await act(async () => { trigger.click() })
    const outside = dom.document.getElementById('outside')!
    outside.focus()
    await act(async () => { outside.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    assert.equal(trigger.getAttribute('aria-expanded'), 'true')
    assert.equal(dom.document.activeElement, outside)
  })
})

test('Escape closes only the innermost menu and single-Reader document keys still work', async () => {
  await withDom(async (dom, container, render) => {
    await render(reader('pdf', React.createElement(Menu, { name: 'parent' }, React.createElement(Menu, { name: 'child' }))))
    const trigger = (name: string) => container.querySelector<HTMLButtonElement>(`[data-trigger="${name}"]`)!
    for (const name of ['parent', 'child']) await act(async () => { trigger(name).click() })
    // JSDOM click leaves focus at body, matching existing synthetic-key tests.
    await act(async () => { dom.document.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    assert.equal(trigger('parent').getAttribute('aria-expanded'), 'true')
    assert.equal(trigger('child').getAttribute('aria-expanded'), 'false')
    assert.equal(dom.document.activeElement, trigger('child'))
    await act(async () => { dom.document.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    assert.equal(trigger('parent').getAttribute('aria-expanded'), 'false')
    assert.equal(dom.document.activeElement, trigger('parent'))
  })
})
