import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import React, { act } from 'react'
import { Settings, type ConfigForm, type ConfigFormSnapshot } from '../src/client/Settings.tsx'
import { defaultSettings } from '../src/shared/contracts.ts'

// Resolve the pinned test DOM from this package so native CI jobs are self-contained.
const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

function ready(revision = 1): ConfigFormSnapshot {
  return { status: 'ready', value: { ...defaultSettings }, base: {}, user: {}, writable: true, revision }
}

test('PDF settings handles remote revisions, validation and failed saves without dropping local edits', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  const savedGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT']) {
    savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  }
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom },
    document: { configurable: true, value: dom.document },
    HTMLElement: { configurable: true, value: dom.HTMLElement },
    Event: { configurable: true, value: dom.Event },
    MouseEvent: { configurable: true, value: dom.MouseEvent },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  })
  const { createRoot } = await import('react-dom/client')
  const container = dom.document.getElementById('root')!
  const rootView = createRoot(container)
  let snapshot = ready()
  let mutation: (operations: unknown, revision: unknown) => Promise<boolean> = async () => true
  const listeners = new Set<() => void>()
  const form = {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot() { return snapshot },
    mutate(operations: unknown, revision: unknown) { return mutation(operations, revision) },
  } as ConfigForm
  const props = { form, t: (key: string) => key, translationEngines: [{ id: 'dsh-model', label: 'DSH model' }] }
  const button = (label: string) => {
    const control = [...container.querySelectorAll('button')].find(node => node.textContent === label)
    assert.ok(control, `button ${label} exists`)
    return control
  }
  const input = (suffix: string) => {
    const control = container.querySelector<HTMLInputElement>(`input[id$="-${suffix}"]`)
    assert.ok(control, `input ${suffix} exists`)
    return control
  }
  const fill = async (suffix: string, value: string) => {
    const control = input(suffix)
    const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set
    assert.ok(setter)
    await act(async () => {
      setter.call(control, value)
      control.dispatchEvent(new dom.Event('input', { bubbles: true }))
      control.dispatchEvent(new dom.Event('change', { bubbles: true }))
    })
  }
  const fillPrompt = async (suffix: string, value: string) => {
    const control = container.querySelector<HTMLTextAreaElement>(`textarea[id$="-${suffix}"]`)
    assert.ok(control)
    const setter = Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, 'value')?.set
    assert.ok(setter)
    await act(async () => {
      setter.call(control, value)
      control.dispatchEvent(new dom.Event('input', { bubbles: true }))
      control.dispatchEvent(new dom.Event('change', { bubbles: true }))
    })
  }
  const click = async (label: string) => {
    await act(async () => { button(label).click(); await Promise.resolve() })
  }
  const publish = async (next: ConfigFormSnapshot) => {
    await act(async () => { snapshot = next; for (const listener of listeners) listener() })
  }
  try {
    await act(async () => { rootView.render(React.createElement(Settings, props)) })
    await fill('historyCapacity', '77')
    assert.equal(container.querySelector('textarea[id$="-explanationPromptTemplate"]'), null,
      'the old placeholder template is not shown as an editable field')
    await fillPrompt('explanationGeneralInstruction', '请逐段解释并在最后总结。')
    await fillPrompt('explanationImageInstruction', '请先读图例。')
    assert.match(container.textContent ?? '', /有未保存的修改/)
    const unload = new dom.Event('beforeunload', { cancelable: true })
    dom.dispatchEvent(unload)
    assert.equal(unload.defaultPrevented, true, 'dirty settings warn before closing')

    await publish({ ...ready(2), value: { ...defaultSettings, translationTimeoutMs: 18_000 } })
    assert.match(container.textContent ?? '', /设置已在其他地方更新/)
    assert.equal(button('保存设置').disabled, true)
    await click('保留我的修改')
    assert.equal(input('historyCapacity').value, '77')
    assert.match(container.querySelector('textarea')!.value, /最后总结/)
    assert.equal(input('translationTimeoutMs').value, '18000')
    assert.equal(button('保存设置').disabled, false)

    await fill('translationTimeoutMs', '999')
    assert.equal(input('translationTimeoutMs').value, '999')
    // Native number-input constraints block a button click before the React
    // submit handler. Dispatch submit to verify its separate server-safe guard.
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }))
    })
    assert.match(container.textContent ?? '', /请先修正标出的设置/)
    assert.match(container.textContent ?? '', /请输入 1000 到 600000 之间的整数/)
    await fill('translationTimeoutMs', '19000')
    await fillPrompt('explanationGeneralInstruction', 'x'.repeat(2001))
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }))
    })
    assert.match(container.textContent ?? '', /每个提示词最多 2000 个字符/)
    await fillPrompt('explanationGeneralInstruction', '请逐段解释并在最后总结。')
    const calls: { operations: unknown; revision: unknown }[] = []
    mutation = async (operations, revision) => {
      calls.push({ operations, revision })
      throw new Error('offline')
    }
    await click('保存设置')
    assert.match(container.textContent ?? '', /保存失败：offline/)
    assert.equal(calls[0]?.revision, 2)
    assert.match(JSON.stringify(calls[0]?.operations), /historyCapacity/)
    assert.match(JSON.stringify(calls[0]?.operations), /explanationGeneralInstruction/)
    assert.match(JSON.stringify(calls[0]?.operations), /explanationImageInstruction/)
    assert.equal(input('historyCapacity').value, '77', 'a failed save retains the draft')

    mutation = async () => false
    await click('保存设置')
    assert.match(container.textContent ?? '', /设置未被接受/)
    await publish({ ...ready(3), value: { ...defaultSettings, translationTimeoutMs: 18_000 } })
    await click('载入最新设置')
    assert.equal(input('historyCapacity').value, String(defaultSettings.historyCapacity))
    assert.equal(input('translationTimeoutMs').value, '18000')

    await publish({ ...ready(4), value: { ...defaultSettings, explanationPromptTemplate: 'Missing items' } })
    await fill('historyCapacity', '52')
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }))
    })
    assert.match(container.textContent ?? '', /请先修正标出的设置/)

    await publish({ ...ready(5), base: { explanationPromptTemplate: 'Legacy instruction. {{items}}' },
      value: { ...defaultSettings,
      explanationPromptTemplate: 'Legacy instruction. {{items}}' } })
    await click('载入最新设置')
    assert.match(container.textContent ?? '', /旧版完整模板仍在生效/)
    await click('改用分项提示词')
    mutation = async (operations, revision) => { calls.push({ operations, revision }); return false }
    await click('保存设置')
    assert.deepEqual((calls.at(-1)?.operations as Array<{ op: string; path: string[]; value?: string }>).find(
      item => item.path[0] === 'explanationPromptTemplate'), {
      op: 'set', path: ['explanationPromptTemplate'], value: defaultSettings.explanationPromptTemplate,
    }, 'switching must override even a legacy template supplied by the profile base')

    await click('恢复默认')
    assert.match(container.textContent ?? '', /默认值已填入/)
    mutation = async (operations, revision) => {
      calls.push({ operations, revision })
      snapshot = ready(5)
      for (const listener of listeners) listener()
      return true
    }
    await click('保存设置')
    assert.match(JSON.stringify(calls.at(-1)?.operations), /"op":"unset"/)
    assert.match(container.textContent ?? '', /设置已保存/)

    await fill('historyCapacity', '51')
    // The form can change between the last render and submit. The revision
    // fence catches this even if no notification arrived from the store.
    snapshot = ready(6)
    await click('保存设置')
    assert.match(container.textContent ?? '', /设置已在其他地方更新/)

    let replacement: ConfigFormSnapshot = { ...ready(), status: 'loading', value: undefined }
    const replacementListeners = new Set<() => void>()
    const replacementForm = {
      subscribe(listener: () => void) { replacementListeners.add(listener); return () => { replacementListeners.delete(listener) } },
      getSnapshot() { return replacement },
      async mutate() { return true },
    } as ConfigForm
    await act(async () => { rootView.render(React.createElement(Settings, { ...props, form: replacementForm })) })
    assert.match(container.textContent ?? '', /正在加载 PDF 设置/)
    await act(async () => {
      replacement = { ...ready(8), writable: false }
      for (const listener of replacementListeners) listener()
    })
    assert.match(container.textContent ?? '', /当前设置为只读/)
    assert.equal(input('historyCapacity').value, String(defaultSettings.historyCapacity),
      'replacing the form must not retain the previous form’s unsaved draft')
  } finally {
    await act(async () => { rootView.unmount() })
    dom.close()
    for (const [key, descriptor] of savedGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
