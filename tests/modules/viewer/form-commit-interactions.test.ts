import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import React, { act } from 'react'
import type { PdfFormField } from '../../../src/core/pdf-types.ts'
import { NativeViewport } from '../../../src/shared/geometry/native-viewport.ts'
import { createReaderFormCommits } from '../../../src/modules/viewer/controllers/reader-form-commits.ts'
import { ReaderFormCommitProvider } from '../../../src/modules/viewer/rendering/FormCommitContext.tsx'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string) => { window: Window & typeof globalThis & { close(): void } }
}

test('focused widget drafts defer only to commands in their own Reader and otherwise commit on blur', async () => {
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
  const calls: string[] = [], errors: unknown[] = []
  let result = true
  const owner = createReaderFormCommits(async (id, value) => { calls.push(`${id}:${value}`); return result }, error => { errors.push(error) })
  let otherOwner: ReturnType<typeof createReaderFormCommits> | undefined
  const field: PdfFormField = { id: 'name', name: 'Name', type: 'text', value: 'old', readOnly: false, required: false,
    widgets: [{ page: 1, rect: [20, 20, 80, 40] }] }
  const viewport = new NativeViewport({ page: 1, cropBox: [0, 0, 300, 400], rotation: 0, userUnit: 1 }, 1)
  let lastCommand: Promise<void> = Promise.resolve()
  const command = () => { lastCommand = owner.flush().then(ok => { if (ok) calls.push('save') }) }
  const render = async (value = field.value) => {
    const content = React.createElement('div', {
      className: 'dsh-pdf-reader',
      onKeyDown(event: React.KeyboardEvent) { if (event.ctrlKey && event.key === 's') { event.preventDefault(); command() } },
    }, React.createElement(FormWidgets, { page: 1, viewport, fields: [{ ...field, value }],
      onChange: async () => { assert.fail('the provider owns writes') } }),
    React.createElement('button', { 'data-reader-command': true, onClick: command }, 'Save'))
    await act(async () => root.render(React.createElement(ReaderFormCommitProvider, { value: owner }, content)))
  }
  const type = async (input: HTMLInputElement, value: string) => { await act(async () => {
    input.focus(); input.value = value; input.dispatchEvent(new dom.Event('input', { bubbles: true }))
  }) }
  try {
    await render()
    let input = container.querySelector<HTMLInputElement>('input')!
    await type(input, 'keyboard')
    assert.equal(owner.getSnapshot(), true)
    await act(async () => {
      input.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))
      await lastCommand
    })
    assert.deepEqual(calls, ['name:keyboard', 'save'])
    assert.equal(dom.document.activeElement, input, 'saving does not blur or steal focus')
    await type(input, 'click')
    await render('host revision')
    input = container.querySelector<HTMLInputElement>('input')!
    assert.equal(input.value, 'click', 'a working-copy rerender retains the unsubmitted draft')
    const save = container.querySelector<HTMLButtonElement>('button')!
    await act(async () => { input.focus(); save.focus() })
    assert.deepEqual(calls, ['name:keyboard', 'save'], 'command focus does not start an early blur mutation')
    await act(async () => { save.click(); await lastCommand })
    assert.deepEqual(calls, ['name:keyboard', 'save', 'name:click', 'save'])
    await type(input, 'failed')
    result = false
    await act(async () => { save.focus(); save.click(); await lastCommand })
    assert.equal(calls.at(-1), 'name:failed', 'failed input submission blocks the save command')
    assert.equal(owner.value('name'), 'failed')
    assert.deepEqual(errors, [])

    result = true
    await owner.flush()
    calls.length = 0
    const secondOwner = createReaderFormCommits(async () => { assert.fail('the second Reader has no form drafts') }, error => { assert.fail(String(error)) })
    otherOwner = secondOwner
    await act(async () => root.render(React.createElement(React.Fragment, null,
      React.createElement(ReaderFormCommitProvider, { value: owner }, React.createElement('div', { className: 'dsh-pdf-reader' },
        React.createElement(FormWidgets, { page: 1, viewport, fields: [field], onChange: async () => {} }))),
      React.createElement(ReaderFormCommitProvider, { value: secondOwner }, React.createElement('div', { className: 'dsh-pdf-reader' },
        React.createElement('button', { 'data-reader-command': true, onClick: async () => {
          if (await secondOwner.flush()) calls.push('other-save')
        } }, 'Other Reader Save'))))))
    input = container.querySelector<HTMLInputElement>('input')!
    await type(input, 'across readers')
    const otherSave = container.querySelector<HTMLButtonElement>('button')!
    await act(async () => { otherSave.focus() })
    assert.deepEqual(calls, ['name:across readers'], 'a different Reader command cannot take ownership of the first Reader blur')
    assert.equal(owner.getSnapshot(), false, 'leaving the first Reader commits its input before it can be unmounted')
    await act(async () => { otherSave.click() })
    assert.deepEqual(calls, ['name:across readers', 'other-save'])
  } finally {
    await act(async () => root.unmount())
    owner.dispose()
    otherOwner?.dispose()
    dom.close()
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
