import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Settings, settingsLocales, type ConfigForm, type ConfigFormSnapshot } from '../src/client/Settings.tsx'
import { defaultSettings } from '../src/shared/contracts.ts'
import type { EngineCatalogSnapshot, EngineConfiguration } from '../src/modules/engines/index.ts'

test('PDF Settings omits the AI engine heading and explains each setting only once in both languages', () => {
  const snapshot: ConfigFormSnapshot = {
    status: 'ready', value: { ...defaultSettings }, base: {}, user: {}, revision: 1, writable: true,
  }
  const form: ConfigForm = { getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: async () => true }
  const engineCatalog: EngineCatalogSnapshot = { revision: 'fixture', engines: {
    ocr: [{ id: 'session-llm', name: 'Session OCR', version: '1', execution: 'local' }],
    image: [{ id: 'dsh-vision', name: 'Session vision', version: '1', execution: 'remote', capabilities: ['image-description'] }],
    translation: [{ id: 'dsh-model', name: 'Session translator', version: '1', execution: 'remote' }],
  } }
  for (const locale of [settingsLocales.zh, settingsLocales.en]) {
    const html = renderToStaticMarkup(React.createElement(Settings, {
      form, engineCatalog, translationEngines: [], t: key => (locale as Record<string, string>)[key] ?? key,
    }))
    assert.equal([...html.matchAll(/<h3\b/g)].length, 2, 'only navigation and prompts retain group headings')
    assert.doesNotMatch(html, /AI 引擎|AI engines|engines-title/)
    for (const key of ['settings.enginesHelp', 'settings.ocrHelp', 'settings.imageHelp', 'settings.indexScanPagesHelp', 'settings.indexImageDescriptionsHelp',
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
  assert.equal(controls.length, 8)
  for (const control of controls) assert.doesNotMatch(control, /\bdisabled(?:\s|=|>)/)
})

test('index preprocessing checkboxes follow embedding and use defaults for older settings snapshots', () => {
  const { indexScanPages: _scanned, indexImageDescriptions: _descriptions, ...legacySettings } = defaultSettings
  const snapshot: ConfigFormSnapshot = { status: 'ready', value: legacySettings,
    base: {}, user: {}, revision: 1, writable: true }
  const form: ConfigForm = { getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: async () => true }
  const html = renderToStaticMarkup(React.createElement(Settings, { form,
    t: key => (settingsLocales.en as Record<string, string>)[key] ?? key, translationEngines: [] }))
  const checks = [...html.matchAll(/<input\b[^>]*type="checkbox"[^>]*>/g)].map(match => match[0])
  assert.equal(checks.length, 2)
  assert.match(checks[0]!, /indexScanPages/)
  assert.match(checks[0]!, /\bchecked=""/)
  assert.match(checks[1]!, /indexImageDescriptions/)
  assert.doesNotMatch(checks[1]!, /\bchecked=/)
  const embeddingSelect = html.match(/<select\b[^>]*id="[^"]*-embeddingEngine"[^>]*>/)?.[0]
  assert.ok(embeddingSelect)
  assert.ok(html.indexOf(embeddingSelect) < html.indexOf(checks[0]!))
  assert.match(html, /Adds model calls, waiting time and cost/)
})

test('semantic search settings follow the engine catalog and retain an unloaded selection', () => {
  const snapshot: ConfigFormSnapshot = { status: 'ready', value: { ...defaultSettings,
    embeddingEngine: 'custom-embedding' }, base: {}, user: {}, revision: 1, writable: true }
  const form: ConfigForm = { getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: async () => true }
  const catalog: EngineCatalogSnapshot = { revision: 'one', engines: { ocr: [], image: [], translation: [], embedding: [
    { id: 'none', name: 'Disabled', version: '1', execution: 'disabled' },
    { id: 'custom-embedding', name: 'My local encoder', version: '1', execution: 'local' },
  ] } }
  const render = () => renderToStaticMarkup(React.createElement(Settings, { form, engineCatalog: catalog,
    translationEngines: [], t: key => (settingsLocales.en as Record<string, string>)[key] ?? key }))
  assert.match(render(), /My local encoder/)
  assert.match(render(), /value="none"/)
  catalog.engines.embedding = [catalog.engines.embedding![0]!]
  const unloaded = render()
  assert.match(unloaded, /custom-embedding/)
  assert.match(unloaded, /Engine not loaded/)
  assert.equal(snapshot.value!.embeddingEngine, 'custom-embedding')
})

test('legacy auxiliary settings display one shared DSH vision selector and preserve its model configuration', () => {
  const snapshot: ConfigFormSnapshot = { status: 'ready', value: { ...defaultSettings,
    imageEngine: 'auxiliary-vision', indexImageDescriptions: true,
    engineConfigurations: { image: { 'auxiliary-vision': { provider: 'fixture-provider', model: 'fixture-model' } } },
  }, base: {}, user: {}, revision: 1, writable: true }
  const form: ConfigForm = { getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: async () => true }
  const engineCatalog: EngineCatalogSnapshot = { revision: 'one', engines: { ocr: [], translation: [], image: [
    { id: 'dsh-vision', name: 'DSH vision model', version: '1', execution: 'remote', configurationFields: [
      { key: 'provider', label: 'Provider', type: 'string' }, { key: 'model', label: 'Model', type: 'string' },
    ] },
  ] } }
  const html = renderToStaticMarkup(React.createElement(Settings, { form, engineCatalog, translationEngines: [],
    t: key => (settingsLocales.en as Record<string, string>)[key] ?? key }))
  assert.match(html, /value="dsh-vision" selected=""/)
  assert.match(html, /value="specified" selected=""/)
  assert.match(html, /fixture-provider \/ fixture-model/)
  assert.doesNotMatch(html, /<input[^>]*id="[^"]*-(?:provider|model)"/)
  assert.doesNotMatch(html, /id="[^"]*-indexDescriptionEngine"/)
  assert.equal([...html.matchAll(/<select\b[^>]*id="[^"]*-imageEngine"/g)].length, 1)
  assert.equal(snapshot.value!.imageEngine, 'auxiliary-vision', 'display migration never mutates a remote snapshot')
})

test('unknown legacy auxiliary model routes stay visible as missing rather than adopting the current model', () => {
  const engineCatalog: EngineCatalogSnapshot = { revision: 'one', engines: { ocr: [], translation: [], image: [
    { id: 'dsh-vision', name: 'DSH vision model', version: '1', execution: 'remote' },
  ] } }
  const routes: EngineConfiguration[] = [{}, { provider: 'only-provider' }]
  for (const route of routes) {
    const snapshot: ConfigFormSnapshot = { status: 'ready', value: { ...defaultSettings,
      imageEngine: 'auxiliary-vision', indexImageDescriptions: true,
      engineConfigurations: { image: { 'auxiliary-vision': route } },
    }, base: {}, user: {}, revision: 1, writable: true }
    const form: ConfigForm = { getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: async () => true }
    const html = renderToStaticMarkup(React.createElement(Settings, { form, engineCatalog, translationEngines: [],
      t: key => (settingsLocales.en as Record<string, string>)[key] ?? key }))
    assert.match(html, /<option value="auxiliary-vision" disabled="" selected=""/)
    assert.match(html, /Engine not loaded/)
    assert.doesNotMatch(html, /value="dsh-vision" selected=""/)
  }
})
