import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { effectiveOcrEngine } from '../src/client/ocr-availability.ts'
import { Settings, type ConfigForm, type ConfigFormSnapshot } from '../src/client/Settings.tsx'
import { defaultSettings } from '../src/shared/contracts.ts'

test('OCR stays off even when an older configuration selected LocalOCR', () => {
  assert.equal(effectiveOcrEngine('local'), 'none')
  assert.equal(effectiveOcrEngine('none'), 'none')
})

test('PDF settings show only an unavailable, off OCR switch', () => {
  const snapshot: ConfigFormSnapshot = {
    status: 'ready', value: { ...defaultSettings, ocrEngine: 'local', translationEngine: 'none' },
    base: {}, user: {}, revision: 1, writable: true, mode: 'host',
  }
  const form: ConfigForm = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    mutate: async () => true,
  }
  const html = renderToStaticMarkup(React.createElement(Settings, {
    form, t: key => key, translationEngines: [{ id: 'dsh-model', label: 'DSH model' }],
  }))
  const toggle = html.match(/<button[^>]*role="switch"[^>]*>/)?.[0]
  assert.ok(toggle)
  assert.match(toggle, /aria-checked="false"/)
  assert.match(toggle, /disabled=""/)
  assert.doesNotMatch(html, /OCR engine|Recognition languages|Recognition timeout/)
  assert.match(html, /<option[^>]*value="dsh-model"[^>]*selected=""/)
  assert.doesNotMatch(html, /<option[^>]*value="none"/)
  assert.doesNotMatch(html, /NoneTranslation/)
})
