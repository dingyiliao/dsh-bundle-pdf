import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import { ReaderAlerts, type ReaderAlertsProps } from '../../../src/modules/viewer/components/ReaderAlerts.tsx'

function props(overrides: Partial<ReaderAlertsProps> = {}): ReaderAlertsProps {
  return {
    snapshot: null, error: '', positionNotice: '', editable: true,
    reloadConfirm: false, setError() {}, setPositionNotice() {}, setReloadConfirm() {},
    beginSaveAs() {}, reload() {}, t: key => key,
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

function saveAs(overrides: Partial<NonNullable<ReaderAlertsProps['saveAs']>> = {}): NonNullable<ReaderAlertsProps['saveAs']> {
  return { name: 'book.pdf', directory: '/books', pickerAvailable: true, picking: false, busy: false,
    targetChecking: false, target: null, replaceConfirm: false, error: '',
    onNameChange() {}, onDirectoryChange() {}, onChooseDirectory() {}, onSubmit() {}, onCancel() {}, onBack() {},
    t: key => key, ...overrides }
}

test('reader alerts present the Save As sheet with separate filename and location and require a checked target', () => {
  const unchecked = renderToStaticMarkup(React.createElement(ReaderAlerts, props({ saveAs: saveAs() })))
  assert.match(unchecked, /class="dsh-pdf-save-as dsh-pdf-glass" role="dialog" aria-modal="true"/)
  assert.match(unchecked, /reader\.saveAsTitle/)
  assert.match(unchecked, /reader\.saveName/)
  assert.match(unchecked, /value="book\.pdf"/)
  assert.match(unchecked, /reader\.saveLocation/)
  assert.match(unchecked, /reader\.changeSaveLocation/)
  assert.match(unchecked, /type="submit"[^>]*disabled=""/)
  assert.doesNotMatch(unchecked, /type="checkbox"|reader\.savePath/)
  const checked = renderToStaticMarkup(React.createElement(ReaderAlerts,
    props({ saveAs: saveAs({ target: { path: '/books/book.pdf', version: null } }) })))
  assert.match(checked, /reader\.targetNew/)
  assert.doesNotMatch(checked, /type="submit"[^>]*disabled=""/)
  const replacing = renderToStaticMarkup(React.createElement(ReaderAlerts,
    props({ saveAs: saveAs({ target: { path: '/books/book.pdf', version: 'v1' }, replaceConfirm: true }) })))
  assert.match(replacing, /reader\.replaceTitle/)
  assert.match(replacing, /reader\.replaceAndSave/)
  assert.match(replacing, /reader\.saveBack/)
  assert.doesNotMatch(replacing, /reader\.saveName|type="checkbox"/)
})

test('Save As feedback is announced only in its modal while document notices remain separate', () => {
  const html = renderToStaticMarkup(React.createElement(ReaderAlerts,
    props({ error: 'target changed', positionNotice: 'position unavailable', saveAs: saveAs({ error: 'target changed' }) })))
  assert.equal((html.match(/role="alert"/g) ?? []).length, 1)
  assert.equal((html.match(/target changed/g) ?? []).length, 1)
  assert.match(html, /position unavailable/)
  assert.doesNotMatch(html, /class="dsh-pdf-error"/)
})

test('reader alerts preserve separate error and position announcements', () => {
  const html = renderToStaticMarkup(React.createElement(ReaderAlerts,
    props({ error: 'open failed', positionNotice: 'position failed' })))
  assert.match(html, /class="dsh-pdf-error" role="alert"/)
  assert.match(html, /class="dsh-pdf-notice" role="status"/)
  assert.match(html, /open failed/)
  assert.match(html, /position failed/)
})
