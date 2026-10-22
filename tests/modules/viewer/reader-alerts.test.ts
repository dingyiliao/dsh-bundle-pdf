import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import { ReaderAlerts, type ReaderAlertsProps } from '../../../src/modules/viewer/components/ReaderAlerts.tsx'

function props(overrides: Partial<ReaderAlertsProps> = {}): ReaderAlertsProps {
  return {
    snapshot: null, error: '', positionNotice: '', editable: true, saveAsOpen: false,
    savePath: '/book.pdf', target: null, targetChecking: false, overwrite: false,
    busy: false, reloadConfirm: false, setError() {}, setPositionNotice() {},
    setSavePath() {}, setOverwrite() {}, setSaveAsOpen() {}, setReloadConfirm() {},
    save() {}, beginSaveAs() {}, reload() {}, t: key => key,
    ...overrides,
  }
}

test('reader alerts expose a single read-only notice, warning, and conflict action', () => {
  const snapshot = { document: { readOnly: true, readOnlyReason: 'encrypted-document' },
    warning: 'unsafe form', conflict: true } as WorkspaceSnapshot
  const html = renderToStaticMarkup(React.createElement(ReaderAlerts, props({ snapshot, editable: false })))
  assert.match(html, /reader\.encryptedReadOnly/)
  assert.match(html, /unsafe form/)
  assert.match(html, /reader\.conflict/)
  assert.match(html, /disabled=""/)
})

test('reader alerts do not label an editable AcroForm as read-only', () => {
  const snapshot = { document: { readOnly: false, formKind: 'acroform' } } as WorkspaceSnapshot
  const html = renderToStaticMarkup(React.createElement(ReaderAlerts, props({ snapshot, editable: true })))
  assert.doesNotMatch(html, /reader\.signedReadOnly|reader\.encryptedReadOnly/)
})

test('reader alerts keep Save As submit disabled until the selected target is checked and confirmed', () => {
  const base = props({ saveAsOpen: true, target: { path: '/book.pdf', version: 'v1' } })
  const unchecked = renderToStaticMarkup(React.createElement(ReaderAlerts, base))
  assert.match(unchecked, /reader\.targetExists/)
  assert.match(unchecked, /type="submit" disabled=""/)
  const confirmed = renderToStaticMarkup(React.createElement(ReaderAlerts, { ...base, overwrite: true }))
  assert.doesNotMatch(confirmed, /type="submit" disabled=""/)
})

test('reader alerts preserve separate error and position announcements', () => {
  const html = renderToStaticMarkup(React.createElement(ReaderAlerts,
    props({ error: 'open failed', positionNotice: 'position failed' })))
  assert.match(html, /class="dsh-pdf-error" role="alert"/)
  assert.match(html, /class="dsh-pdf-notice" role="status"/)
  assert.match(html, /open failed/)
  assert.match(html, /position failed/)
})
