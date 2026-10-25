import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Settings, settingsLocales, type ConfigForm, type ConfigFormSnapshot } from '../src/client/Settings.tsx'
import { defaultSettings } from '../src/shared/contracts.ts'
import type { EngineCatalogSnapshot } from '../src/modules/engines/index.ts'

test('PDF Settings groups AI engines and explains each setting only once in both languages', () => {
  const snapshot: ConfigFormSnapshot = {
    status: 'ready', value: { ...defaultSettings }, base: {}, user: {}, revision: 1, writable: true,
  }
  const form: ConfigForm = { getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: async () => true }
  const engineCatalog: EngineCatalogSnapshot = { revision: 'fixture', engines: {
    ocr: [{ id: 'session-llm', name: 'Session OCR', version: '1', execution: 'local' }],
    image: [{ id: 'session-vision', name: 'Session vision', version: '1', execution: 'remote' }],
    translation: [{ id: 'dsh-model', name: 'Session translator', version: '1', execution: 'remote' }],
  } }
  for (const locale of [settingsLocales.zh, settingsLocales.en]) {
    const html = renderToStaticMarkup(React.createElement(Settings, {
      form, engineCatalog, translationEngines: [], t: key => (locale as Record<string, string>)[key] ?? key,
    }))
    assert.equal([...html.matchAll(/<h3\b/g)].length, 3, 'one section for engines, navigation and prompts')
    for (const key of ['settings.enginesHelp', 'settings.ocrHelp', 'settings.imageHelp',
      'settings.translationHelp', 'settings.explanationPromptsHelp'] as const) {
      assert.equal(html.split(locale[key]).length - 1, 1, `${key} is not repeated`)
    }
    assert.match(html, /dsh-pdf-settings-engine-kind/)
    assert.ok(html.includes(locale['settings.engineLocal']))
    assert.ok(html.includes(locale['settings.engineRemote']))
    assert.doesNotMatch(html, /<h3[^>]*>(?:OCR|图像理解|Image understanding|翻译|Translation)<\/h3>/)
    assert.deepEqual([...html.matchAll(/<textarea\b[^>]*rows="(\d+)"/g)].map(match => match[1]), ['3', '2', '2'])
    for (const match of html.matchAll(/aria-describedby="([^"]+)"/g)) {
      for (const reference of match[1].split(' ')) {
        assert.ok(html.includes(`id="${reference}"`), `help reference ${reference} resolves`)
      }
    }
  }
})

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
  assert.equal(controls.length, 5)
  for (const control of controls) assert.doesNotMatch(control, /\bdisabled(?:\s|=|>)/)
})
