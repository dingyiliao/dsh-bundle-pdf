import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FloatingStatusRail, floatingStatusOrder } from '../src/client/FloatingStatusRail.tsx'

test('floating statuses retain their first-appearance order when another status arrives', () => {
  assert.deepEqual(floatingStatusOrder([], ['save']), ['save'])
  assert.deepEqual(floatingStatusOrder(['save'], ['ocr', 'save']), ['save', 'ocr'])
  assert.deepEqual(floatingStatusOrder(['save', 'ocr'], ['ocr', 'screenshot']), ['ocr', 'screenshot'])
  assert.deepEqual(floatingStatusOrder(['ocr', 'screenshot'], ['save', 'ocr', 'screenshot']), ['ocr', 'screenshot', 'save'])
})

test('one rail renders independent text, progress, and cancelable statuses', () => {
  const html = renderToStaticMarkup(React.createElement(FloatingStatusRail, { statuses: [
    { id: 'save', content: 'Saved', activity: 'dot', durationMs: 2600, onExpire: () => {} },
    { id: 'ocr', content: 'Recognizing text…', activity: 'progress',
      actions: [{ label: 'Cancel OCR', onClick: () => {} }] },
    { id: 'screenshot', content: 'Stopping screenshot…', activity: 'progress',
      actions: [{ label: 'Cancel screenshot', disabled: true, onClick: () => {} }] },
  ] }))
  assert.match(html, /dsh-pdf-floating-status-rail/)
  assert.ok(html.indexOf('Saved') < html.indexOf('Recognizing text…'))
  assert.ok(html.indexOf('Recognizing text…') < html.indexOf('Stopping screenshot…'))
  assert.match(html, /role="status" aria-live="polite"/)
  assert.match(html, /<button type="button">Cancel OCR<\/button>/)
  assert.match(html, /<button type="button" disabled="">Cancel screenshot<\/button>/)
})
