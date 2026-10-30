import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import React, { act } from 'react'
import { Settings, settingsLocales, type ConfigForm, type ConfigFormSnapshot } from '../src/client/Settings.tsx'
import { defaultSettings, type PdfSettings } from '../src/shared/contracts.ts'
import type { EngineCatalogSnapshot, EngineDescriptor } from '../src/modules/engines/index.ts'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}
const imageEngines: EngineDescriptor[] = [
  { id: 'fixture.vision', name: 'Visual descriptions', version: '1', execution: 'local',
    configurationFields: [{ key: 'model', label: 'Vision model', type: 'string', required: true }] },
  { id: 'fixture.remote', name: 'Remote vision', version: '1', execution: 'remote' },
]

test('OCR and vision share their index bindings, keep independent toggles and follow engine registration changes', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost' }).window
  const globals = new Map<string, PropertyDescriptor | undefined>()
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT']) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  }
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom }, document: { configurable: true, value: dom.document },
    HTMLElement: { configurable: true, value: dom.HTMLElement }, Event: { configurable: true, value: dom.Event },
    MouseEvent: { configurable: true, value: dom.MouseEvent }, IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  })
  const { createRoot } = await import('react-dom/client')
  const container = dom.document.getElementById('root')!, root = createRoot(container)
  const listeners = new Set<() => void>()
  let catalog: EngineCatalogSnapshot = { revision: 'all', engines: { image: imageEngines,
    ocr: [{ id: 'fixture.ocr', name: 'OCR provider', version: '1', execution: 'local',
      configurationFields: [{ key: 'language', label: 'OCR language', type: 'string' }] }],
    translation: [{ id: 'dsh-model', name: 'Translator', version: '1', execution: 'remote' }],
    embedding: [{ id: 'none', name: 'Disabled', version: '1', execution: 'disabled' }] } }
  const baseSettings: PdfSettings = { ...defaultSettings, ocrEngine: 'fixture.ocr', imageEngine: 'ocr-text',
    engineConfigurations: { image: { 'fixture.vision': { model: 'saved-visual-model' } },
      ocr: { 'fixture.ocr': { language: 'eng' } } } }
  let snapshot: ConfigFormSnapshot = { status: 'ready', value: { ...baseSettings, indexImageDescriptions: true },
    base: {}, user: {}, writable: true, revision: 1 }
  type Operation = { op: 'set' | 'unset'; path: string[]; value?: unknown }
  const mutations: Operation[][] = []
  const form: ConfigForm = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async mutate(operations) {
      mutations.push(operations as Operation[])
      const value = { ...snapshot.value } as unknown as Record<string, unknown>
      for (const operation of operations as Operation[]) {
        if (operation.op === 'set') value[operation.path[0]!] = operation.value
        else delete value[operation.path[0]!]
      }
      snapshot = { ...snapshot, value: value as unknown as PdfSettings, revision: Number(snapshot.revision) + 1 }
      for (const listener of listeners) listener()
      return true
    },
  }
  const render = () => root.render(React.createElement(Settings, { form, engineCatalog: catalog, translationEngines: [],
    t: key => (settingsLocales.en as Record<string, string>)[key] ?? key }))
  const input = (suffix: string) => {
    const result = container.querySelector<HTMLInputElement>(`input[id$="-${suffix}"]`)
    assert.ok(result, `input ${suffix} exists`)
    return result
  }
  const select = (suffix: string) => {
    const result = container.querySelector<HTMLSelectElement>(`select[id$="-${suffix}"]`)
    assert.ok(result, `select ${suffix} exists`)
    return result
  }
  const fill = async (suffix: string, value: string) => {
    await act(async () => {
      const control = input(suffix)
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!.call(control, value)
      control.dispatchEvent(new dom.Event('input', { bubbles: true }))
    })
  }
  const choose = async (suffix: string, value: string) => {
    await act(async () => { const control = select(suffix); control.value = value
      control.dispatchEvent(new dom.Event('change', { bubbles: true })) })
  }
  const save = async () => {
    await act(async () => { container.querySelector('form')!.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true })) })
  }
  const publish = async (settings: PdfSettings) => {
    await act(async () => { snapshot = { ...snapshot, value: settings, revision: Number(snapshot.revision) + 1 }
      for (const listener of listeners) listener() })
  }
  try {
    await act(async () => { render() })
    assert.equal(select('imageEngine').value, 'ocr-text', 'removed OCR bridge remains an unavailable placeholder')
    assert.equal(select('imageEngine').selectedOptions[0]!.disabled, true)
    assert.deepEqual([...select('imageEngine').options].filter(option => !option.disabled).map(option => option.value),
      ['fixture.vision', 'fixture.remote'], 'only actual registered vision engines are selectable')
    assert.equal(container.querySelector('select[id$="-indexDescriptionEngine"]'), null, 'there is no duplicate index engine')
    assert.equal(container.querySelectorAll('input[type="checkbox"]').length, 2)
    await fill('historyCapacity', '88')
    await save()
    assert.equal(mutations.length, 1, 'unrelated edits remain saveable for an old missing image choice')
    assert.deepEqual(mutations[0], [{ op: 'set', path: ['historyCapacity'], value: 88 }])

    await publish({ ...baseSettings, indexScanPages: false, indexImageDescriptions: false })
    assert.equal(select('imageEngine').value, 'ocr-text', 'engine controls do not depend on index toggles')
    await act(async () => { input('indexScanPages').click(); input('indexImageDescriptions').click() })
    await save()
    assert.equal(mutations.length, 1, 'new visual indexing requires a loaded image engine')
    assert.match(container.textContent ?? '', /Choose an installed engine/)
    await choose('imageEngine', 'fixture.vision')
    assert.equal(input('image-model').value, 'saved-visual-model')
    assert.equal(input('ocr-language').value, 'eng')
    assert.equal(input('indexScanPages').checked, true)
    assert.equal(input('indexImageDescriptions').checked, true)
    await fill('image-model', 'shared-visual-model')
    await save()
    assert.equal(mutations.length, 2)
    for (const field of ['indexScanPages', 'indexImageDescriptions']) {
      assert.deepEqual(mutations[1]!.find(operation => operation.path[0] === field), { op: 'set', path: [field], value: true })
    }
    assert.deepEqual(mutations[1]!.find(operation => operation.path[0] === 'imageEngine'),
      { op: 'set', path: ['imageEngine'], value: 'fixture.vision' })
    assert.ok(mutations.flat().every(operation => operation.path[0] !== 'indexDescriptionEngine'))
    assert.equal(snapshot.value!.ocrEngine, 'fixture.ocr')
    assert.equal(snapshot.value!.imageEngine, 'fixture.vision')
    assert.deepEqual(snapshot.value!.engineConfigurations, {
      image: { 'fixture.vision': { model: 'shared-visual-model' } },
      ocr: { 'fixture.ocr': { language: 'eng' } },
    })

    for (const field of ['indexScanPages', 'indexImageDescriptions']) {
      await act(async () => { input(field).click() })
      assert.equal(select('imageEngine').value, 'fixture.vision')
      assert.equal(input('image-model').value, 'shared-visual-model')
      await save()
    }
    assert.equal(input('indexScanPages').checked, false)
    assert.equal(input('indexImageDescriptions').checked, false)
    assert.equal(mutations.length, 4)
    await act(async () => { catalog = { ...catalog, revision: 'unloaded', engines: { ...catalog.engines,
      image: imageEngines.filter(engine => engine.id !== 'fixture.vision') } }; render() })
    assert.equal(select('imageEngine').value, 'fixture.vision')
    assert.equal(select('imageEngine').selectedOptions[0]!.disabled, true)
    assert.equal(container.querySelector('input[id$="-image-model"]'), null, 'unloaded provider fields disappear')
    await fill('historyCapacity', '89')
    await save()
    assert.equal(mutations.length, 5, 'missing untouched image selection permits unrelated saves')

    await choose('imageEngine', 'fixture.remote')
    await act(async () => { catalog = { ...catalog, revision: 'remote-unloaded', engines: { ...catalog.engines,
      image: [] } }; render() })
    assert.equal(select('imageEngine').value, 'fixture.remote', 'catalog removal cannot auto-pick another engine')
    await save()
    assert.equal(mutations.length, 5, 'an edited selection cannot save after its provider unloads')
    await act(async () => { catalog = { ...catalog, revision: 'reloaded', engines: { ...catalog.engines, image: imageEngines } }; render() })
    assert.equal(select('imageEngine').selectedOptions[0]!.disabled, false)
    await save()
    assert.equal(mutations.length, 6)
    assert.equal(snapshot.value!.imageEngine, 'fixture.remote')
    assert.equal(container.querySelectorAll('select[id$="-imageEngine"]').length, 1)
    assert.equal(container.querySelector('select[id$="-indexDescriptionEngine"]'), null)
  } finally {
    await act(async () => { root.unmount() })
    dom.close()
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
