import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FloatingStatusRail, floatingStatusOrder } from '../../../src/modules/viewer/components/FloatingStatusRail.tsx'
import { ExplanationStatusBar } from '../../../src/modules/viewer/components/ExplanationStatusBar.tsx'

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

test('expanded explanation mode shows its title and selected question count', () => {
  const html = renderToStaticMarkup(React.createElement(ExplanationStatusBar, {
    count: 2, max: 5, sending: false, error: '', imageAvailable: true, selectingArea: false,
    t: key => key, onSend() {}, onExit() {}, onSelectArea() {},
  }))
  assert.match(html, /reader\.explain\.title/)
  assert.match(html, /dsh-pdf-explanation-status-count">2\/5</)
})
