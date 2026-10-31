import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import React, { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FloatingStatusRail, floatingStatusOrder } from '../../../src/modules/viewer/components/FloatingStatusRail.tsx'

test('floating statuses retain their first-appearance order when another status arrives', () => {
  assert.deepEqual(floatingStatusOrder([], ['save']), ['save'])
  assert.deepEqual(floatingStatusOrder(['save'], ['ocr', 'save']), ['save', 'ocr'])
  assert.deepEqual(floatingStatusOrder(['save', 'ocr'], ['ocr', 'screenshot']), ['ocr', 'screenshot'])
  assert.deepEqual(floatingStatusOrder(['ocr', 'screenshot'], ['save', 'ocr', 'screenshot']), ['ocr', 'screenshot', 'save'])
})

test('one rail renders independent text, progress, and cancelable statuses', () => {
  const html = renderToStaticMarkup(React.createElement(FloatingStatusRail, { t: key => key, statuses: [
    { id: 'save', content: 'Saved', activity: 'dot', durationMs: 2600, onExpire: () => {} },
    { id: 'ocr', content: 'Recognizing text…', activity: 'progress',
      actions: [{ label: 'Cancel OCR', onClick: () => {} }] },
    { id: 'screenshot', content: 'Stopping screenshot…', activity: 'progress',
      actions: [{ label: 'Cancel screenshot', disabled: true, onClick: () => {} }] },
  ] }))
  assert.match(html, /dsh-pdf-floating-status-rail/)
  assert.match(html, /aria-label="reader.activity: 3"/)
  assert.match(html, /aria-expanded="false"/)
  assert.match(html, /dsh-pdf-activity-popover/)
  const list = html.slice(html.indexOf('dsh-pdf-activity-popover'))
  assert.ok(list.indexOf('Saved') < list.indexOf('Recognizing text…'))
  assert.ok(list.indexOf('Recognizing text…') < list.indexOf('Stopping screenshot…'))
  assert.match(html, /role="status" aria-live="polite"/)
  assert.match(html, /<button type="button">Cancel OCR<\/button>/)
  assert.match(html, /<button type="button" disabled="">Cancel screenshot<\/button>/)
})

test('task outcomes have independent tones without changing task identity or labels', () => {
  const html = renderToStaticMarkup(React.createElement(FloatingStatusRail, { t: key => key, statuses: [
    { id: 'working', kind: 'indexing', content: 'Indexing', activity: 'progress', tone: 'progress' },
    { id: 'done', kind: 'indexing', content: 'Ready', activity: 'dot', tone: 'success' },
    { id: 'failed', kind: 'error', content: 'Failed', activity: 'dot', tone: 'error' },
    { id: 'cancelled', kind: 'indexing', content: 'Cancelled', activity: 'dot', tone: 'neutral' },
  ] }))
  assert.match(html, /data-status-id="working" data-kind="indexing" data-tone="progress"/)
  assert.match(html, /data-status-id="done" data-kind="indexing" data-tone="success"/)
  assert.match(html, /data-status-id="failed" data-kind="error" data-tone="error"/)
  assert.match(html, /data-status-id="cancelled" data-kind="indexing" data-tone="neutral"/)
  assert.match(html, /dsh-pdf-activity-trigger" data-kind="error" data-tone="error"/)
})

test('the task badge counts active work, including saves, without counting retained ready states', () => {
  const html = renderToStaticMarkup(React.createElement(FloatingStatusRail, { t: key => key, statuses: [
    { id: 'ready', kind: 'indexing', tone: 'success', activity: 'dot', content: 'Index ready' },
    { id: 'saved', kind: 'saved', tone: 'success', activity: 'dot', content: 'Saved' },
    { id: 'save', kind: 'saving', tone: 'progress', activity: 'dot', content: 'Saving' },
    { id: 'ocr', activity: 'progress', content: 'Recognizing' },
  ] }))
  assert.match(html, /dsh-pdf-activity-count" aria-hidden="true">2</)
  assert.match(html, /Index ready/)
  const ready = renderToStaticMarkup(React.createElement(FloatingStatusRail, { t: key => key, statuses: [
    { id: 'ready', kind: 'indexing', tone: 'success', activity: 'dot', content: 'Index ready' },
  ] }))
  assert.doesNotMatch(ready, /dsh-pdf-activity-count/)
})

test('a standalone activity popover retains inside actions and closes on an outside pointer', async () => {
  const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
    JSDOM: new (html: string) => { window: Window & typeof globalThis & { close(): void } }
  }
  const dom = new JSDOM('<!doctype html><div id="root"></div><button id="outside">Outside</button>').window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  const globals = { window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element,
    Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true }
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const mount = dom.document.getElementById('root')!, root = createRoot(mount)
  let cancelled = 0
  try {
    await act(async () => root.render(React.createElement(FloatingStatusRail, { t: key => key, statuses: [
      { id: 'ocr', content: 'Recognizing text', activity: 'progress',
        actions: [{ label: 'Cancel OCR', onClick: () => { cancelled++ } }] },
    ] })))
    const trigger = mount.querySelector<HTMLButtonElement>('.dsh-pdf-activity-trigger')!
    const popover = mount.querySelector<HTMLElement>('.dsh-pdf-activity-popover')!
    assert.equal(popover.hidden, true)
    await act(async () => { trigger.click() })
    assert.equal(trigger.getAttribute('aria-expanded'), 'true')
    assert.equal(popover.hidden, false)
    const cancel = popover.querySelector<HTMLButtonElement>('button')!
    await act(async () => {
      cancel.dispatchEvent(new dom.Event('pointerdown', { bubbles: true }))
      cancel.click()
    })
    assert.equal(cancelled, 1, 'an inside pointer must retain the action until its click is delivered')
    assert.equal(popover.hidden, false)
    await act(async () => { dom.document.getElementById('outside')!.dispatchEvent(new dom.Event('pointerdown', { bubbles: true })) })
    assert.equal(trigger.getAttribute('aria-expanded'), 'false')
    assert.equal(popover.hidden, true)
  } finally {
    await act(async () => root.unmount())
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
