import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ZoomMenu } from '../../../src/modules/viewer/components/ZoomMenu.tsx'
import { readerLocales } from '../../../src/modules/viewer/index.js'

const t = (key: string) => (readerLocales.en as Record<string, string>)[key] ?? key
const render = (fit: 'custom' | 'width' | 'page', zoom: number, disabled = false) =>
  renderToStaticMarkup(React.createElement(ZoomMenu, { fit, zoom, disabled, t, onSelect: () => {} }))

test('Zoom uses the shared toolbar disclosure and marks the current choice', () => {
  const html = render('width', 1)
  assert.match(html, /class="dsh-pdf-toolbar-disclosure dsh-pdf-toolbar-zoom"/)
  assert.match(html, /<details[^>]*aria-label="Zoom: Fit width"/)
  assert.match(html, /<div class="dsh-pdf-tools-menu(?: [^"]+)? dsh-pdf-zoom-menu"/)
  assert.match(html, /<button[^>]*aria-pressed="true"[^>]*><span>Fit width<\/span>/)
  assert.equal((html.match(/<button /g) ?? []).length, 9)
  assert.doesNotMatch(html, /<select|<option/)
})

test('the zoom disclosure carries a decorative arrow inside its one click target', () => {
  const html = render('width', 1)
  // The arrow stays inside the single click target and out of the accessibility tree.
  assert.match(html, /<summary[^>]*>[\s\S]*?<span class="dsh-pdf-toolbar-chevron" aria-hidden="true">▾<\/span><\/summary>/)
  assert.doesNotMatch(html, /<button[^>]*dsh-pdf-toolbar-chevron/)
  assert.equal((html.match(/<summary/g) ?? []).length, 1)
})

test('wheel zoom retains a selectable nonpreset value and navigation disables the trigger', () => {
  const html = render('custom', 1.1, true)
  assert.match(html, /aria-label="Zoom: 110%"/)
  assert.match(html, /<summary[^>]*aria-disabled="true"[^>]*tabindex="-1"/)
  assert.match(html, /<button[^>]*aria-pressed="true"[^>]*><span>110%<\/span>/)
  assert.equal((html.match(/<button /g) ?? []).length, 10)
})
