import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Settings, settingsLocales, type ConfigForm, type ConfigFormSnapshot } from '../src/client/Settings.tsx'
import { defaultSettings } from '../src/shared/contracts.ts'
import type { EngineCatalogSnapshot } from '../src/modules/engines/index.ts'

test('embedding service settings use one deployment-neutral badge and no badge for disabled retrieval', () => {
  const engineCatalog: EngineCatalogSnapshot = { revision: 'services', engines: { ocr: [], image: [], translation: [], embedding: [
    { id: 'none', name: 'Disabled', version: '1', execution: 'disabled' },
    { id: 'embedding-service', name: 'Embedding service', version: '1', execution: 'service' },
  ] } }
  for (const locale of [settingsLocales.zh, settingsLocales.en]) {
    for (const embeddingEngine of ['none', 'embedding-service']) {
      const snapshot: ConfigFormSnapshot = { status: 'ready', value: { ...defaultSettings, embeddingEngine },
        base: {}, user: {}, revision: 1, writable: true }
      const form: ConfigForm = { getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: async () => true }
      const html = renderToStaticMarkup(React.createElement(Settings, { form, engineCatalog,
        translationEngines: [], t: key => (locale as Record<string, string>)[key] ?? key }))
      const badges = [...html.matchAll(/<small class="dsh-pdf-settings-engine-kind">([^<]+)<\/small>/g)].map(match => match[1])
      assert.deepEqual(badges, embeddingEngine === 'none' ? [] : [locale['settings.engineService']])
    }
  }
})
