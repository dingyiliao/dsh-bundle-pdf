import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReaderAlerts, type ReaderAlertsProps } from '../../../src/surfaces/client/viewer/components/ReaderAlerts.tsx'

function props(overrides: Partial<ReaderAlertsProps> = {}): ReaderAlertsProps {
  return { reloadConfirm: false, setReloadConfirm() {}, reload() {}, t: key => key, ...overrides }
}


function saveAs(overrides: Partial<NonNullable<ReaderAlertsProps['saveAs']>> = {}): NonNullable<ReaderAlertsProps['saveAs']> {
  return { name: 'book.pdf', directory: '/books', pickerAvailable: true, picking: false, busy: false,
    targetChecking: false, target: null, replaceConfirm: false, signatureConfirm: false, signatureCertified: false, error: '',
    onNameChange() {}, onDirectoryChange() {}, onChooseDirectory() {}, onSubmit() {}, onCancel() {}, onBack() {},
    t: key => key, ...overrides }
}

test('ReaderAlerts reserve their surface for blocking prompts, not document notices', () => {
  const html = renderToStaticMarkup(React.createElement(ReaderAlerts, props()))
  assert.equal(html, '')
})

test('ReaderAlerts still render interactive password and reload prompts', () => {
  const html = renderToStaticMarkup(React.createElement(ReaderAlerts, props({
    password: { identity: 'doc', status: 'required', busy: false, unlock() {}, cancel() {}, retry() {} },
    reloadConfirm: true,
  })))
  assert.match(html, /reader.unlockTitle/)
  assert.match(html, /reader.reloadConfirm/)
  assert.doesNotMatch(html, /dsh-pdf-notice|dsh-pdf-error/)
})

test('reader alerts present the Save As sheet with separate filename and location and require a checked target', () => {
  const unchecked = renderToStaticMarkup(React.createElement(ReaderAlerts, props({ saveAs: saveAs() })))
  assert.match(unchecked, /class="dsh-pdf-save-as dsh-pdf-glass" role="dialog" aria-modal="true"/)
  assert.match(unchecked, /reader.saveAsTitle/)
  assert.match(unchecked, /reader.saveName/)
  assert.match(unchecked, /value="book.pdf"/)
  assert.match(unchecked, /reader.saveLocation/)
  assert.match(unchecked, /reader.changeSaveLocation/)
  assert.match(unchecked, /type="submit"[^>]*disabled=""/)
  assert.doesNotMatch(unchecked, /type="checkbox"|reader.savePath/)
  const checked = renderToStaticMarkup(React.createElement(ReaderAlerts,
    props({ saveAs: saveAs({ target: { path: '/books/book.pdf', version: null } }) })))
  assert.match(checked, /reader.targetNew/)
  assert.doesNotMatch(checked, /type="submit"[^>]*disabled=""/)
  const replacing = renderToStaticMarkup(React.createElement(ReaderAlerts,
    props({ saveAs: saveAs({ target: { path: '/books/book.pdf', version: 'v1' }, replaceConfirm: true }) })))
  assert.match(replacing, /reader.replaceTitle/)
  assert.match(replacing, /reader.replaceAndSave/)
  assert.match(replacing, /reader.saveBack/)
  assert.doesNotMatch(replacing, /reader.saveName|type="checkbox"/)
})

test('Save As requires signature-loss consent and distinguishes a certification signature', () => {
  for (const [certified, body] of [[false, 'reader.signatureSaveBody'], [true, 'reader.signatureSaveCertifiedBody']] as const) {
    const html = renderToStaticMarkup(React.createElement(ReaderAlerts,
      props({ saveAs: saveAs({ target: { path: '/books/book.pdf', version: 'v1' },
        signatureConfirm: true, signatureCertified: certified }) })))
    assert.match(html, /reader\.signatureSaveTitle/)
    assert.match(html, new RegExp(body))
    assert.match(html, /reader\.signatureSaveConfirm/)
    assert.match(html, /book\.pdf/)
    assert.doesNotMatch(html, /reader\.saveName|type="checkbox"/)
    if (certified) assert.doesNotMatch(html, /reader\.signatureSaveBody/)
    else assert.doesNotMatch(html, /reader\.signatureSaveCertifiedBody/)
  }
})

test('Save As errors stay in the modal while generic banners are absent', () => {
  const html = renderToStaticMarkup(React.createElement(ReaderAlerts,
    props({ saveAs: saveAs({ error: 'target changed' }) })))
  assert.equal((html.match(/role="alert"/g) ?? []).length, 1)
  assert.equal((html.match(/target changed/g) ?? []).length, 1)
  assert.match(html, /class="dsh-pdf-save-as-error" role="alert"/)
  assert.doesNotMatch(html, /dsh-pdf-notice|class="dsh-pdf-error"/)
})
