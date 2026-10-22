import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import React, { act } from 'react'
import type { PdfFormField } from '../../../src/core/pdf-types.ts'
import { NativeViewport } from '../../../src/shared/geometry/native-viewport.ts'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string) => { window: Window & typeof globalThis & { close(): void } }
}

test('radio, dropdown and list controls send exact field identities and typed values', async () => {
  const dom = new JSDOM('<div id="root"></div>').window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
    HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event,
    IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  const { FormWidgets } = await import('../../../src/modules/viewer/rendering/FormWidgets.tsx')
  const { createRoot } = await import('react-dom/client')
  const container = dom.document.getElementById('root')!, root = createRoot(container)
  const widget = { page: 1, rect: [20, 20, 80, 40] as [number, number, number, number] }
  const base = { value: '', widgets: [widget], readOnly: false, required: false }
  const fields: PdfFormField[] = [
    { ...base, id: 'radio-id', name: 'Choice', type: 'radio', value: 'one', options: ['one', 'two'],
      widgets: [{ ...widget, option: 'one' }, { ...widget, option: 'two' }] },
    { ...base, id: 'dropdown-id', name: 'Choice', type: 'dropdown', value: ['one'], options: ['one', 'two'] },
    { ...base, id: 'list-id', name: 'List', type: 'option-list', value: ['one'], options: ['one', 'two'] },
    { ...base, id: 'locked-id', name: 'Locked', type: 'text', readOnly: true },
  ]
  const writes: Array<[string, string | boolean | string[]]> = []
  const render = async () => { await act(async () => root.render(React.createElement(FormWidgets, {
    page: 1, viewport: new NativeViewport({ page: 1, cropBox: [0, 0, 300, 400], rotation: 0, userUnit: 1 }, 1),
    fields, async onChange(id, value) { writes.push([id, value]) },
  }))) }
  try {
    await render()
    assert.equal(container.querySelector('[aria-label="Locked"]'), null)
    const one = container.querySelector<HTMLInputElement>('[aria-label="Choice: one"]')!
    const two = container.querySelector<HTMLInputElement>('[aria-label="Choice: two"]')!
    assert.equal(one.checked, true)
    await act(async () => two.click())
    const dropdown = container.querySelector<HTMLSelectElement>('select[aria-label="Choice"]')!
    assert.equal(dropdown.value, 'one')
    await act(async () => { dropdown.value = 'two'; dropdown.dispatchEvent(new dom.Event('change', { bubbles: true })) })
    const list = container.querySelector<HTMLSelectElement>('select[aria-label="List"]')!
    await act(async () => {
      for (const option of list.options) option.selected = true
      list.dispatchEvent(new dom.Event('change', { bubbles: true }))
    })
    assert.deepEqual(writes, [['radio-id', 'two'], ['dropdown-id', 'two'], ['list-id', ['one', 'two']]])
    fields[0] = { ...fields[0], value: 'two' }
    fields[1] = { ...fields[1], value: 'two' }
    await render()
    assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Choice: two"]')!.checked, true)
    assert.equal(container.querySelector<HTMLSelectElement>('select[aria-label="Choice"]')!.value, 'two')
  } finally {
    await act(async () => root.unmount())
    dom.close()
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
