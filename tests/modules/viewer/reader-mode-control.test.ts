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
