import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import React, { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Settings, type ConfigForm, type ConfigFormSnapshot } from '../src/client/Settings.tsx'
import { defaultSettings } from '../src/shared/contracts.ts'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}
const ready = (): ConfigFormSnapshot => ({ status: 'ready', value: { ...defaultSettings },
  base: {}, user: {}, writable: true, revision: 1 })
const formFor = (snapshot: ConfigFormSnapshot): ConfigForm => ({ getSnapshot: () => snapshot,
  subscribe: () => () => {}, mutate: async () => true })

test('a settings connection without index management does not advertise an unusable action', () => {
  const html = renderToStaticMarkup(React.createElement(Settings, { form: formFor(ready()), t: key => key, translationEngines: [] }))
  assert.equal(html.includes('重建索引'), false)
})

test('index rebuild settings show progress and recovery, fence duplicates, and cancel when their owner changes', async () => {
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
  const legacySnapshot: ConfigFormSnapshot = { ...ready(), value: { ...defaultSettings,
    embeddingEngine: 'local-qwen3-embedding', engineConfigurations: { embedding: { 'local-qwen3-embedding': {
      endpoint: 'http://localhost:8001/v1/embeddings', modelRevision: 'retired-version',
    } } } } }
  const mutations: unknown[] = []
  let owner: ConfigForm = { ...formFor(legacySnapshot), async mutate(operations) { mutations.push(operations); return true } }
  let calls = 0, signal!: AbortSignal, finish!: () => void
  let perform = async () => new Promise<void>(resolve => { finish = resolve })
  const rebuildRetrievalIndex = (active: AbortSignal) => { calls++; signal = active; return perform() }
  const render = () => root.render(React.createElement(Settings, { form: owner, t: key => key,
    translationEngines: [], rebuildRetrievalIndex, engineCatalog: { revision: 'service', engines: {
      ocr: [], image: [], translation: [], embedding: [
        { id: 'none', name: 'Disabled', version: '1', execution: 'disabled' },
        { id: 'local-qwen3-embedding', name: 'Embedding service', version: '1', execution: 'service',
          configurationFields: [{ key: 'endpoint', label: 'Embedding endpoint', type: 'string' }] },
      ],
    } } }))
  const button = (label: string) => {
    const control = [...container.querySelectorAll('button')].find(node => node.textContent === label)
    assert.ok(control, `button ${label} exists`)
    return control
  }
  let unmounted = false
  try {
    await act(async () => { render() })
    const endpoint = container.querySelector<HTMLInputElement>('input[id$="-embedding-endpoint"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!.call(endpoint, 'https://provider.example/v1/embeddings')
      endpoint.dispatchEvent(new dom.Event('input', { bubbles: true }))
    })
    await act(async () => { button('保存设置').click() })
    assert.equal(mutations.length, 1, 'a retired modelRevision cannot prevent saving a valid engine edit')
    assert.match(JSON.stringify(mutations[0]), /provider\.example/)
    assert.equal(JSON.stringify(mutations[0]).includes('modelRevision'), false)
    assert.match(container.textContent ?? '', /不会修改 PDF 或草稿/)
    await act(async () => { button('重建索引').click(); button('重建索引').click() })
    assert.equal(calls, 1)
    assert.equal(button('正在清除索引缓存…').disabled, true)
    assert.equal(container.querySelector<HTMLInputElement>('input[id$="-historyCapacity"]')!.disabled, true)
    await act(async () => { finish() })
    assert.match(container.textContent ?? '', /索引缓存已清除，将在后台或下次检索时重建/)
    assert.equal(button('重建索引').disabled, false)

    perform = async () => { throw new Error('Host unavailable') }
    await act(async () => { button('重建索引').click() })
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /无法重建索引：Host unavailable/)
    assert.equal(container.textContent?.includes('索引缓存已清除，将在后台或下次检索时重建'), false)

    // Unsaved configuration cannot be mistaken for the configuration being rebuilt.
    const input = container.querySelector<HTMLInputElement>('input[id$="-historyCapacity"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!.call(input, '66')
      input.dispatchEvent(new dom.Event('input', { bubbles: true }))
    })
    assert.equal(button('重建索引').disabled, true)
    await act(async () => { button('撤销修改').click() })
    assert.equal(button('重建索引').disabled, false)

    perform = async () => new Promise<void>(resolve => { finish = resolve })
    await act(async () => { button('重建索引').click() })
    const oldSignal = signal
    owner = formFor(ready())
    await act(async () => { render() })
    assert.equal(oldSignal.aborted, true)
    assert.equal(button('重建索引').disabled, false)
    await act(async () => { finish() })
    assert.equal(container.textContent?.includes('索引缓存已清除，将在后台或下次检索时重建'), false,
      'late completion cannot publish success into a replacement settings owner')
    owner = formFor({ ...ready(), writable: false })
    await act(async () => { render() })
    assert.equal(button('重建索引').disabled, true)
    owner = formFor(ready())
    await act(async () => { render() })
    await act(async () => { button('重建索引').click() })
    await act(async () => { root.unmount(); unmounted = true })
    assert.equal(signal.aborted, true)
    finish()
  } finally {
    if (!unmounted) await act(async () => { root.unmount() })
    dom.close()
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
