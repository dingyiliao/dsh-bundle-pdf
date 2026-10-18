import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Settings, settingsLocales, type ConfigForm, type ConfigFormSnapshot } from '../src/client/Settings.tsx'
import { defaultSettings } from '../src/shared/contracts.ts'

test('PDF Settings omits translation target and file-size controls', () => {
  const snapshot: ConfigFormSnapshot = {
    status: 'ready', value: { ...defaultSettings, maxFileBytes: 32 * 1024 * 1024 },
    base: {}, user: {}, revision: 1, writable: true,
  }
  const form: ConfigForm = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    mutate: async () => true,
  }
  const html = renderToStaticMarkup(React.createElement(Settings, {
    form,
    t: key => (settingsLocales.en as Record<string, string>)[key] ?? key,
    translationEngines: [{ id: 'dsh-model', label: 'DSH model' }],
  }))
  assert.match(html, /Translation engine/)
  assert.match(html, /Navigation history capacity/)
  assert.doesNotMatch(html, /Target language/)
  assert.doesNotMatch(html, /PDF size limit/)
  assert.doesNotMatch(html, /name="translationTargetLanguage"|name="maxFileBytes"/)
})

test('PDF Settings keeps ready writable controls editable without a mode field', () => {
  const snapshot: ConfigFormSnapshot = {
    status: 'ready', value: { ...defaultSettings },
    base: {}, user: {}, revision: 1, writable: true,
  }
  const form: ConfigForm = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    mutate: async () => true,
  }
  const html = renderToStaticMarkup(React.createElement(Settings, {
    form,
    t: key => (settingsLocales.en as Record<string, string>)[key] ?? key,
    translationEngines: [{ id: 'dsh-model', label: 'DSH model' }],
  }))
  const controls = [...html.matchAll(/<(?:select|input)\b[^>]*>/g)].map(match => match[0])
  assert.equal(controls.length, 3)
  for (const control of controls) assert.doesNotMatch(control, /\bdisabled(?:\s|=|>)/)
})
