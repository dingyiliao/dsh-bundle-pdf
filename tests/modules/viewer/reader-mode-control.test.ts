import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReaderModeControl } from '../../../src/modules/viewer/components/ReaderModeControl.tsx'

const t = (key: string) => key

test('note and region modes remain in the toolbar with a cancel action', () => {
  const note = renderToStaticMarkup(React.createElement(ReaderModeControl, {
    mode: { kind: 'note', label: 'Place a note', onCancel() {} }, t,
  }))
  assert.match(note, /data-status-id="note-mode"/)
  assert.match(note, /aria-label="Place a note"/)
  assert.match(note, /reader.cancel/)
  const region = renderToStaticMarkup(React.createElement(ReaderModeControl, {
    mode: { kind: 'region', label: 'Select a region', onCancel() {} }, t,
  }))
  assert.match(region, /data-status-id="region-selection"/)
  assert.match(region, /data-icon="crop"/)
})

test('explanation mode keeps progress and actions in the same toolbar surface', () => {
  const html = renderToStaticMarkup(React.createElement(ReaderModeControl, {
    t,
    explanation: {
      count: 2, max: 20, sending: false, error: '', imageAvailable: true, selectingArea: false,
      t, onSend() {}, onExit() {}, onSelectArea() {},
    },
  }))
  assert.match(html, /dsh-pdf-mode-explanation/)
  assert.match(html, /reader.explain.title, 2\/20/)
  assert.doesNotMatch(html, /dsh-pdf-explanation-status-mode/)
  assert.doesNotMatch(html, /<details/)
  assert.match(html, /reader.explain.sendShort/)
  assert.match(html, /reader.explain.exitShort/)
  assert.doesNotMatch(html, /dsh-pdf-explanation-status-area/, 'area selection belongs to the scrolling tool list')
})

test('an explanation failure reuses the count row without adding a third fixed action', () => {
  const html = renderToStaticMarkup(React.createElement(ReaderModeControl, {
    t, explanation: { count: 2, max: 20, sending: false, error: 'Vision unavailable', imageAvailable: false,
      selectingArea: false, t, onSend() {}, onExit() {}, onSelectArea() {} },
  }))
  assert.match(html, /class="dsh-pdf-mode-identity dsh-pdf-mode-error-indicator"/)
  assert.match(html, /aria-label="2\/20: Vision unavailable"/)
  assert.match(html, /dsh-pdf-mode-count">2\/20</)
  assert.equal((html.match(/dsh-pdf-mode-error-indicator/g) ?? []).length, 1)
  assert.doesNotMatch(html, />!<|dsh-pdf-explanation-status-area/)
})
