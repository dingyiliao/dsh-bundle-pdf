import { createDom } from '../../support/dom.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FloatingStatusRail, floatingStatusOrder, type FloatingStatus } from '../../../src/client/viewer/components/FloatingStatusRail.tsx'

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

  const { dom, restore: restoreDom, install: installDom } = createDom('<!doctype html><div id="root"></div><button id="outside">Outside</button>', { url: 'about:blank', globals: [] })

  const globals = { window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element,
    Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true }
  installDom(globals)
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
    restoreDom()

  }
})

const statusText = (key: string) => ({
  'reader.activity': 'Activity', 'reader.activityEmpty': 'No background activity',
  'reader.activityMore': 'More task actions', 'reader.activityDismiss': 'Close notification',
}[key] ?? key)

async function withReaderStatusRail(run: (fixture: {
  dom: Window & typeof globalThis
  reader: HTMLElement
  render(statuses: readonly FloatingStatus[]): Promise<void>
  button(label: string): HTMLButtonElement
  activity(): HTMLButtonElement
  menu(): HTMLElement | null
  click(element: HTMLElement): Promise<void>
  escape(element: HTMLElement): Promise<void>
}) => Promise<void>, rail = true, readerOwned = true) {

  const { dom, restore: restoreDom, install: installDom } = createDom('<!doctype html><html><body><div id="root"></div><button id="outside">Outside</button></body></html>', { globals: [] })

  const globals = { window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element,
    Node: dom.Node, CustomEvent: dom.CustomEvent,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id), IS_REACT_ACT_ENVIRONMENT: true }
  installDom(globals)
  const { createRoot } = await import('react-dom/client')
  const mount = dom.document.getElementById('root')!, root = createRoot(mount)
  const render = async (statuses: readonly FloatingStatus[]) => {
    await act(async () => root.render(React.createElement('div', {
      className: readerOwned ? 'dsh-pdf-reader' : undefined, 'data-status-fixture': '',
    },
      React.createElement('div', { ...(rail ? { 'data-pdf-tool-rail': '' } : {}) },
        React.createElement(FloatingStatusRail, { statuses, t: statusText })))))
  }
  try {
    await render([])
    const reader = mount.querySelector<HTMLElement>('[data-status-fixture]')!
    await run({ dom, reader, render,
      button(label) {
        const element = [...reader.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === label || button.textContent === label)
        assert.ok(element, `${label} must be present`)
        return element
      },
      activity: () => reader.querySelector<HTMLButtonElement>('.dsh-pdf-activity-trigger')!,
      menu: () => reader.querySelector<HTMLElement>('[role="group"][aria-label="More task actions: alpha.pdf"]'),
      async click(element) {
        await act(async () => { element.dispatchEvent(new dom.Event('pointerdown', { bubbles: true })); element.click() })
      },
      async escape(element) {
        await act(async () => { element.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
      },
    })
  } finally {
    await act(async () => root.unmount())
    restoreDom()

  }
}

test('a completed task keeps diagnostics behind More and closes only its notification with focus restored', async () => {
  await withReaderStatusRail(async f => {
    let copied = 0, dismissed = 0
    const done = { id: 'index:alpha', title: 'alpha.pdf', content: 'Index ready', occurrence: 1,
      menuActions: [{ label: 'Copy diagnostics', onClick: () => { copied++ } }, { label: 'Open log folder', onClick() {} }],
      dismiss: { label: 'Close notification', ariaLabel: 'Close notification: alpha.pdf', onClick: () => { dismissed++ } } }
    await f.render([done])
    assert.ok(!f.menu() || f.menu()!.hidden, 'diagnostics are not initially exposed as direct actions')
    await f.click(f.activity())
    const more = f.button('More task actions: alpha.pdf')
    assert.equal(more.getAttribute('aria-expanded'), 'false')
    more.focus()
    await f.click(more)
    assert.equal(more.getAttribute('aria-expanded'), 'true')
    assert.equal(f.menu()!.hidden, false)
    assert.equal(f.menu()!.parentElement, f.reader, 'the menu escapes the scrollable task-card layer')
    await f.click(f.button('Copy diagnostics'))
    assert.equal(copied, 1)
    assert.equal(more.getAttribute('aria-expanded'), 'false')
    assert.equal(f.dom.document.activeElement, more)
    assert.equal(f.activity().getAttribute('aria-expanded'), 'true')
    await f.click(f.button('Close notification: alpha.pdf'))
    assert.equal(dismissed, 1)
    assert.equal(f.dom.document.activeElement, f.activity())
    await f.render([])
    assert.equal(f.reader.querySelector('[data-status-id="index:alpha"]'), null)
  })
})

test('Escape closes the nested diagnostic menu before the task panel and outside pointers close the pair', async () => {
  await withReaderStatusRail(async f => {
    await f.render([{ id: 'index:alpha', title: 'alpha.pdf', content: 'Index failed',
      actions: [{ label: 'Resume indexing', onClick() {} }], menuActions: [{ label: 'Copy diagnostics', onClick() {} }] }])
    await f.click(f.activity())
    const more = f.button('More task actions: alpha.pdf')
    await f.click(more)
    f.button('Copy diagnostics').focus()
    await f.escape(f.button('Copy diagnostics'))
    assert.equal(more.getAttribute('aria-expanded'), 'false')
    assert.equal(f.activity().getAttribute('aria-expanded'), 'true')
    assert.equal(f.dom.document.activeElement, more)
    await f.escape(more)
    assert.equal(f.activity().getAttribute('aria-expanded'), 'false')
    assert.equal(f.dom.document.activeElement, f.activity())
    await f.click(f.activity()); await f.click(more)
    await f.click(f.dom.document.getElementById('outside')!)
    assert.equal(f.activity().getAttribute('aria-expanded'), 'false')
    assert.ok(!f.menu() || f.menu()!.hidden, 'no portal can survive its parent panel dismissal')
  })
})

test('a new task occurrence fences an old open menu and disabled diagnostics do not run or dismiss it', async () => {
  await withReaderStatusRail(async f => {
    let oldCalls = 0, newCalls = 0
    const task = { id: 'index:alpha', title: 'alpha.pdf', content: 'Indexing', occurrence: 1,
      actions: [{ label: 'Cancel indexing', onClick() {} }],
      menuActions: [{ label: 'Copy diagnostics', onClick: () => { oldCalls++ } }] }
    await f.render([task]); await f.click(f.activity()); await f.click(f.button('More task actions: alpha.pdf'))
    await f.render([{ ...task, occurrence: 2,
      menuActions: [{ label: 'Copy diagnostics', disabled: true, onClick: () => { newCalls++ } }] }])
    assert.equal(f.button('More task actions: alpha.pdf').getAttribute('aria-expanded'), 'false')
    assert.ok(!f.menu() || f.menu()!.hidden)
    await f.click(f.button('More task actions: alpha.pdf'))
    await f.click(f.button('Copy diagnostics'))
    assert.equal(oldCalls, 0); assert.equal(newCalls, 0)
    assert.equal(f.button('More task actions: alpha.pdf').getAttribute('aria-expanded'), 'true')
    await f.click(f.activity())
    assert.ok(!f.menu() || f.menu()!.hidden)
    await f.click(f.activity())
    assert.equal(f.button('More task actions: alpha.pdf').getAttribute('aria-expanded'), 'false', 'reopening the parent does not reopen its previous menu')
  })
})

test('an inline task panel retains its portaled diagnostic action until pointer click delivery', async () => {
  await withReaderStatusRail(async f => {
    let opened = 0
    await f.render([{ id: 'index:alpha', title: 'alpha.pdf', content: 'Index ready',
      menuActions: [{ label: 'Open log folder', onClick: () => { opened++ } }] }])
    await f.click(f.activity()); await f.click(f.button('More task actions: alpha.pdf'))
    await f.click(f.button('Open log folder'))
    assert.equal(opened, 1)
    assert.equal(f.activity().getAttribute('aria-expanded'), 'true')
    assert.ok(!f.menu() || f.menu()!.hidden)
  }, false)
})

test('standalone diagnostic menus restore keyboard focus before closing their task panel', async () => {
  await withReaderStatusRail(async f => {
    let copied = 0
    await f.render([{ id: 'index:alpha', title: 'alpha.pdf', content: 'Index ready',
      menuActions: [{ label: 'Copy diagnostics', onClick: () => { copied++ } }] }])
    await f.click(f.activity())
    const more = f.button('More task actions: alpha.pdf')
    await f.click(more)
    const copy = f.button('Copy diagnostics')
    copy.focus()
    await act(async () => {
      copy.dispatchEvent(new f.dom.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    assert.equal(more.getAttribute('aria-expanded'), 'true', 'ordinary menu keys must not dismiss the menu')
    assert.equal(copied, 0)
    await f.escape(copy)
    assert.equal(more.getAttribute('aria-expanded'), 'false')
    assert.equal(f.activity().getAttribute('aria-expanded'), 'true')
    assert.equal(f.dom.document.activeElement, more)
    await f.escape(more)
    assert.equal(f.activity().getAttribute('aria-expanded'), 'false')
    assert.equal(f.dom.document.activeElement, f.activity())
  }, false, false)
})

test('closed task panels keep expiry timers and a new occurrence replaces the old deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withReaderStatusRail(async f => {
    let expired = 0
    const status = { id: 'saved', title: 'Saved', content: 'Saved', occurrence: 1, durationMs: 20,
      onExpire: () => { expired++ } }
    await f.render([status])
    assert.equal(f.activity().getAttribute('aria-expanded'), 'false')
    await act(async () => { t.mock.timers.tick(10) })
    await f.render([{ ...status, occurrence: 2 }])
    await act(async () => { t.mock.timers.tick(10) })
    assert.equal(expired, 0)
    await act(async () => { t.mock.timers.tick(10) })
    assert.equal(expired, 1)
    await f.render([{ ...status, occurrence: 3, durationMs: 0 }])
    await act(async () => { t.mock.timers.tick(100) })
    assert.equal(expired, 1, 'persistent statuses never invent an expiry')
  })
})

test('dismiss-only cards use their accessible action label and honor disabled state without an empty More menu', async () => {
  await withReaderStatusRail(async f => {
    let dismissed = 0
    const status: FloatingStatus = { id: 'saved', content: 'Saved', menuActions: [],
      dismiss: { label: 'Close notification', disabled: true, onClick: () => { dismissed++ } } }
    await f.render([status]); await f.click(f.activity())
    assert.equal(f.reader.querySelector('[aria-label^="More task actions:"]'), null)
    assert.equal(f.button('Close notification').disabled, true)
    await f.click(f.button('Close notification'))
    assert.equal(dismissed, 0)
    await f.render([{ ...status, dismiss: { ...status.dismiss!, disabled: false } }])
    await f.click(f.button('Close notification'))
    assert.equal(dismissed, 1)
    assert.equal(f.dom.document.activeElement, f.activity())
  })
})
