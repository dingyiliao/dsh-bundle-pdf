import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import React, { act } from 'react'
import { Settings, settingsLocales, type ConfigForm, type ConfigFormSnapshot, type SettingsProps } from '../src/client/Settings.tsx'
import { defaultSettings, type PdfSettings } from '../src/shared/contracts.ts'
import { createModelOptionsStore, type ModelOptionsSnapshot, type ModelOptionsStore } from '../src/adapters/client/remote/model-options.ts'
import type { EngineCatalogSnapshot } from '../src/modules/engines/index.ts'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}
const catalog: NonNullable<ModelOptionsSnapshot['catalog']> = { groups: [
  { id: 'provider/a', name: 'Provider A', models: [
    { id: 'vision/one', name: 'Visual One', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } },
    { id: 'vision/two', name: 'Visual Two' },
  ] },
  { id: 'provider/b', name: 'Provider B', models: [{ id: 'vision/one', name: 'Other Visual One' }] },
], failures: [] }
const engines: EngineCatalogSnapshot = { revision: 'engines', engines: {
  image: [{ id: 'dsh-vision', name: 'DSH visual model', version: '2', execution: 'remote', configurationFields: [
    { key: 'provider', label: 'Provider', type: 'string' }, { key: 'model', label: 'Model', type: 'string' },
    { key: 'reasoningEffort', label: 'Reasoning effort', type: 'string' },
  ] }], ocr: [], translation: [], embedding: [],
} }

async function withSettings(run: (harness: {
  container: HTMLElement
  select(suffix: string): HTMLSelectElement
  choose(suffix: string, value: string): Promise<void>
  click(label: string): Promise<void>
  fillHistory(value: string): Promise<void>
  state(): ConfigFormSnapshot
  mutations: unknown[][]
  modelRequests(): number
  publishModels(snapshot: ModelOptionsSnapshot): Promise<void>
  publishSettings(settings: PdfSettings): Promise<void>
  render(overrides?: Partial<SettingsProps>): Promise<void>
}) => Promise<void>, initial: PdfSettings = { ...defaultSettings }, models: ModelOptionsSnapshot = { status: 'ready', catalog }) {
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
  const listeners = new Set<() => void>(), modelListeners = new Set<() => void>()
  let snapshot: ConfigFormSnapshot = { status: 'ready', value: initial, writable: true, revision: 1, base: {}, user: {} }
  let modelSnapshot = models, modelRequests = 0
  const mutations: unknown[][] = []
  const form: ConfigForm = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async mutate(operations) {
      mutations.push([...operations])
      const next = { ...snapshot.value } as Record<string, unknown>
      for (const operation of operations) {
        const key = String(operation.path[0])
        if (operation.op === 'set') next[key] = operation.value
        else if (operation.op === 'unset') delete next[key]
      }
      snapshot = { ...snapshot, value: next as unknown as PdfSettings, revision: Number(snapshot.revision) + 1 }
      for (const listener of listeners) listener()
      return true
    },
  }
  const options: ModelOptionsStore = {
    getSnapshot: () => modelSnapshot,
    subscribe(listener) { modelListeners.add(listener); return () => { modelListeners.delete(listener) } },
    async load() { modelRequests++ }, async refresh() { modelRequests++ },
  }
  const props: SettingsProps = { form, modelOptions: options, engineCatalog: engines, translationEngines: [],
    t: key => (settingsLocales.en as Record<string, string>)[key] ?? key }
  let rendered = props
  const render = async (overrides: Partial<SettingsProps> = {}) => {
    rendered = { ...rendered, ...overrides }
    await act(async () => { root.render(React.createElement(Settings, rendered)) })
  }
  const select = (suffix: string) => {
    const control = container.querySelector<HTMLSelectElement>(`select[id$="-${suffix}"]`)
    assert.ok(control, `select ${suffix} exists`)
    return control
  }
  try {
    await render()
    await run({ container, select, render, mutations, state: () => snapshot, modelRequests: () => modelRequests,
      async choose(suffix, value) {
        await act(async () => { const control = select(suffix); control.value = value
          control.dispatchEvent(new dom.Event('change', { bubbles: true })) })
      },
      async click(label) { await act(async () => {
        const button = [...container.querySelectorAll('button')].find(control => control.textContent === label)
        assert.ok(button, `button ${label} exists`); button.click()
      }) },
      async fillHistory(value) {
        await act(async () => {
          const control = container.querySelector<HTMLInputElement>('input[id$="-historyCapacity"]')!
          Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!.call(control, value)
          control.dispatchEvent(new dom.Event('input', { bubbles: true }))
          control.dispatchEvent(new dom.FocusEvent('focusout', { bubbles: true }))
        })
      },
      async publishModels(next) { await act(async () => { modelSnapshot = next; for (const listener of modelListeners) listener() }) },
      async publishSettings(value) { await act(async () => {
        snapshot = { ...snapshot, value, revision: Number(snapshot.revision) + 1 }; for (const listener of listeners) listener()
      }) },
    })
  } finally {
    await act(async () => { root.unmount() })
    dom.close()
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

const pair = (provider: string, model: string) => JSON.stringify([provider, model])

test('DSH vision follows the session without model lookup; explicit choices save catalog IDs and advertised effort', async () => {
  await withSettings(async h => {
    assert.equal(h.select('vision-source').value, 'follow')
    assert.equal(h.container.querySelector('select[id$="-vision-model"]'), null)
    assert.equal(h.container.querySelector('input[id$="-image-provider"],input[id$="-image-model"],input[id$="-image-reasoningEffort"]'), null)
    assert.equal(h.modelRequests(), 0, 'follow mode performs no model-directory request')
    await h.choose('vision-source', 'specified')
    await h.choose('vision-source', 'follow')
    assert.equal(h.mutations.length, 0, 'opening and leaving explicit mode without a choice adds no redundant configuration')
    await h.choose('vision-source', 'specified')
    assert.equal(h.modelRequests(), 2)
    assert.deepEqual([...h.select('vision-model').querySelectorAll('optgroup')].map(group => group.label), ['Provider A', 'Provider B'])
    assert.equal(h.mutations.length, 0, 'explicit mode cannot silently save as follow before a model is chosen')
    assert.equal([...h.container.querySelectorAll('[role="alert"]')].filter(node => /Choose a currently available visual model/.test(node.textContent ?? '')).length, 1)
    await h.choose('vision-model', pair('provider/a', 'vision/one'))
    assert.equal(h.select('vision-effort').value, 'low')
    await h.choose('vision-effort', 'high')
    assert.equal(h.mutations.length, 2, 'model and effort selectors each save their valid choice immediately')
    assert.deepEqual(h.state().value!.engineConfigurations?.image?.['dsh-vision'], {
      provider: 'provider/a', model: 'vision/one', reasoningEffort: 'high',
    })
    assert.equal(Object.keys(h.state().value!).some(key => /mode|source/i.test(key)), false, 'mode is not a persisted setting')
    await h.choose('vision-model', pair('provider/a', 'vision/two'))
    assert.equal(h.container.querySelector('select[id$="-vision-effort"]'), null, 'a new model never inherits an unsupported effort')
    assert.deepEqual(h.state().value!.engineConfigurations?.image?.['dsh-vision'], { provider: 'provider/a', model: 'vision/two' })
    await h.choose('vision-source', 'follow')
    assert.equal(h.container.querySelector('select[id$="-vision-model"]'), null)
    assert.equal(h.state().value!.engineConfigurations?.image?.['dsh-vision'], undefined, 'follow removes every model override')
    assert.deepEqual(h.state().value!.engineConfigurations?.image?.['other-engine'], { endpoint: 'fixture' })
  }, { ...defaultSettings, engineConfigurations: { image: { 'other-engine': { endpoint: 'fixture' } } } })
})

test('unavailable saved models remain visible and unrelated edits save; a newly selected model must remain in the directory', async () => {
  await withSettings(async h => {
    assert.equal(h.select('vision-source').value, 'specified')
    assert.equal(h.select('vision-model').value, pair('removed-provider', 'removed-model'))
    assert.equal(h.select('vision-model').selectedOptions[0]!.disabled, true)
    await h.fillHistory('42')
    assert.equal(h.mutations.length, 1, 'catalog availability does not force changes to a saved route')
    await h.publishModels({ status: 'loading', catalog })
    await h.choose('vision-model', pair('provider/b', 'vision/one'))
    await h.publishModels({ status: 'ready', catalog: { groups: [], failures: [] } })
    assert.equal(h.select('vision-model').value, pair('provider/b', 'vision/one'))
    assert.equal(h.select('vision-model').selectedOptions[0]!.disabled, true)
    assert.equal(h.mutations.length, 1)
    await h.publishModels({ status: 'ready', catalog })
    assert.equal(h.mutations.length, 2)
    assert.deepEqual(h.state().value!.engineConfigurations?.image?.['dsh-vision'], { provider: 'provider/b', model: 'vision/one' })
  }, { ...defaultSettings, engineConfigurations: { image: { 'dsh-vision': { provider: 'removed-provider', model: 'removed-model', reasoningEffort: 'retained' } } } })
})

test('discard and defaults clear local model-source intent while independent remote edits merge automatically', async () => {
  await withSettings(async h => {
    await h.choose('vision-source', 'specified')
    await h.click('Discard changes')
    assert.equal(h.select('vision-source').value, 'follow')
    await h.choose('vision-source', 'specified')
    await h.choose('vision-model', pair('provider/a', 'vision/one'))
    await h.click('Restore defaults')
    assert.equal(h.select('vision-source').value, 'follow')
    const before = h.mutations.length
    await h.choose('vision-source', 'specified')
    await h.publishSettings({ ...defaultSettings, historyCapacity: 65 })
    assert.doesNotMatch(h.container.textContent ?? '', /Settings changed elsewhere/)
    assert.equal(h.select('vision-source').value, 'specified', 'incomplete model-source intent survives independent remote edits')
    assert.equal(h.mutations.length, before, 'incomplete specified mode cannot persist as follow')
    await h.click('Discard changes')
    assert.equal(h.select('vision-source').value, 'follow')
    const otherSnapshot: ConfigFormSnapshot = { status: 'ready', value: { ...defaultSettings,
      engineConfigurations: { image: { 'dsh-vision': { provider: 'provider/a', model: 'vision/two' } } } },
      revision: 1, writable: true, base: {}, user: {} }
    const other: ConfigForm = { getSnapshot: () => otherSnapshot, subscribe: () => () => {}, mutate: async () => false }
    await h.render({ form: other })
    assert.equal(h.select('vision-source').value, 'specified')
    assert.equal(h.select('vision-model').value, pair('provider/a', 'vision/two'))
  })
})

test('model failures, empty visual catalogs and partial catalogs offer retry without raw ID input', async () => {
  await withSettings(async h => {
    await h.choose('vision-source', 'specified')
    assert.match(h.container.textContent ?? '', /could not be loaded/)
    await h.click('Refresh models')
    assert.equal(h.modelRequests(), 2)
    await h.publishModels({ status: 'ready', catalog: { groups: [], failures: [] } })
    assert.match(h.container.textContent ?? '', /No model currently declares image input/)
    assert.equal(h.mutations.length, 0)
    await h.publishModels({ status: 'ready', catalog: { ...catalog, failures: [{ id: 'offline', name: 'Offline provider', message: 'Unavailable' }] } })
    assert.match(h.container.textContent ?? '', /Some providers could not be loaded/)
    await h.choose('vision-model', pair('provider/a', 'vision/two'))
    assert.equal(h.mutations.length, 1)
    assert.equal(h.container.querySelector('input[id$="-image-provider"],input[id$="-image-model"]'), null)
  }, { ...defaultSettings }, { status: 'error', error: 'Offline' })
})

test('a legacy effort without an explicit route follows the complete session route without hidden controls', async () => {
  await withSettings(async h => {
    assert.equal(h.select('vision-source').value, 'follow')
    assert.equal(h.container.querySelector('select[id$="-vision-effort"]'), null)
    assert.equal(h.container.querySelector('select[id$="-vision-model"]'), null)
    assert.equal(h.modelRequests(), 0)
  }, { ...defaultSettings, engineConfigurations: { image: { 'dsh-vision': { reasoningEffort: 'high' } } } })
})

test('leaving specified-model UI cancels its real directory request and drops late replies', async () => {
  for (const destination of ['follow', 'third-party'] as const) {
    const lifetime = new AbortController()
    let requestSignal: AbortSignal | undefined, resolve!: (value: unknown) => void
    const reply = new Promise<unknown>(done => { resolve = done })
    const store = createModelOptionsStore({ rpc: { async call(_path, method, _payload, signal) {
      assert.equal(method, 'pdf.model-options'); requestSignal = signal; return reply
    } } }, lifetime.signal)
    try {
      await withSettings(async h => {
        await h.render({ modelOptions: store, engineCatalog: { ...engines, engines: { ...engines.engines,
          image: [...engines.engines.image, { id: 'third-party', name: 'Third party', version: '1', execution: 'local' }] } } })
        await h.choose('vision-source', 'specified')
        assert.ok(requestSignal)
        assert.equal(requestSignal.aborted, false)
        if (destination === 'follow') await h.choose('vision-source', 'follow')
        else await h.choose('imageEngine', 'third-party')
        assert.equal(requestSignal.aborted, true, 'both parent validation and child selector subscriptions release the request')
        resolve({ ok: true, value: catalog })
        await act(async () => { await Promise.resolve(); await Promise.resolve() })
        assert.equal(store.getSnapshot().catalog, undefined, 'a late reply cannot populate the retired UI generation')
        assert.equal(h.container.querySelector('select[id$="-vision-model"]'), null)
      })
    } finally { lifetime.abort(); store.dispose() }
  }
})

test('whitespace-only legacy model fields render as follow and padded saved IDs match the catalog', async () => {
  await withSettings(async h => {
    assert.equal(h.select('vision-source').value, 'follow')
    assert.equal(h.container.querySelector('select[id$="-vision-model"]'), null)
    assert.equal(h.modelRequests(), 0)
  }, { ...defaultSettings, engineConfigurations: { image: { 'dsh-vision': { provider: ' ', model: '\t', reasoningEffort: 'high' } } } })
  await withSettings(async h => {
    assert.equal(h.select('vision-source').value, 'specified')
    assert.equal(h.select('vision-model').value, pair('provider/a', 'vision/one'))
    assert.equal(h.select('vision-model').selectedOptions[0]!.disabled, false)
    await h.choose('vision-effort', 'high')
    assert.deepEqual(h.state().value!.engineConfigurations?.image?.['dsh-vision'], {
      provider: 'provider/a', model: 'vision/one', reasoningEffort: 'high',
    })
  }, { ...defaultSettings, engineConfigurations: { image: { 'dsh-vision': { provider: ' provider/a ', model: ' vision/one ', reasoningEffort: ' low ' } } } })
})
