import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import React, { act } from 'react'
import { Settings, settingsLocales, type ConfigForm, type ConfigFormSnapshot } from '../src/client/Settings.tsx'
import { defaultSettings, type PdfSettings } from '../src/shared/contracts.ts'
import type { EngineCatalogSnapshot } from '../src/modules/engines/index.ts'
import { SETTINGS_ACK_TIMEOUT_MS } from '../src/client/settings-ack.ts'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}
type Operations = Parameters<ConfigForm['mutate']>[0]
const catalog: EngineCatalogSnapshot = { revision: 'fixture', engines: {
  ocr: [{ id: 'session-llm', name: 'OCR', version: '1', execution: 'local' },
    { id: 'fixture.ocr', name: 'Other OCR', version: '1', execution: 'local' }],
  image: [{ id: 'dsh-vision', name: 'Vision', version: '1', execution: 'remote',
    configurationFields: [{ key: 'endpoint', label: 'Image endpoint', type: 'string' }, { key: 'credential', label: 'Credential', type: 'string' }] },
    { id: 'fixture.required', name: 'Configured vision', version: '1', execution: 'local',
      configurationFields: [{ key: 'model', label: 'Required model', type: 'string', required: true }] }],
  translation: [{ id: 'dsh-model', name: 'Default translator', version: '1', execution: 'remote' },
    { id: 'fixture.translation', name: 'Other translator', version: '1', execution: 'local' }],
  embedding: [{ id: 'none', name: 'Disabled', version: '1', execution: 'disabled' }],
} }
function ready(value: PdfSettings = { ...defaultSettings }): ConfigFormSnapshot {
  return { status: 'ready', value, base: {}, user: {}, writable: true, revision: 1 }
}
async function setup(initial = ready()) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost' }).window
  const globals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, HTMLElement: dom.HTMLElement,
    Event: dom.Event, MouseEvent: dom.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const container = dom.document.getElementById('root')!, root = createRoot(container)
  let snapshot = initial
  const listeners = new Set<() => void>(), calls: { ops: Operations; revision: number | undefined }[] = []
  const notify = () => { for (const listener of listeners) listener() }
  const accept = (ops: Operations) => {
    const value = { ...snapshot.value } as Record<string, unknown>
    const user = { ...snapshot.user as Record<string, unknown> }
    for (const operation of ops) {
      const field = String(operation.path[0])
      value[field] = operation.op === 'set' ? operation.value
        : (snapshot.base as Partial<PdfSettings>)?.[field as keyof PdfSettings] ?? defaultSettings[field as keyof PdfSettings]
      const raw = operation.op === 'set' ? operation.value : (snapshot.base as Record<string, unknown>)[field]
      if (raw === undefined) delete user[field]; else user[field] = raw
    }
    snapshot = { ...snapshot, value: value as unknown as PdfSettings, user, revision: Number(snapshot.revision) + 1 }
    notify()
  }
  let mutate = async (ops: Operations, _revision: number | undefined) => { accept(ops); return true }
  const form: ConfigForm = { getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async mutate(ops, revision) { calls.push({ ops, revision }); return mutate(ops, revision) } }
  const render = (owner = form) => root.render(React.createElement(Settings, { form: owner,
    t: key => (settingsLocales.en as Record<string, string>)[key] ?? key, translationEngines: [], engineCatalog: catalog }))
  await act(async () => { render() })
  const control = (suffix: string) => {
    const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[id$="-${suffix}"]`)
    assert.ok(input, suffix); return input
  }
  const button = (name: string) => {
    const found = [...container.querySelectorAll('button')].find(node => node.textContent === name)
    assert.ok(found, name); return found
  }
  return { dom, container, control, calls, accept, form, state: () => snapshot, subscriptions: () => listeners.size,
    silentExternal(value: Partial<PdfSettings>) {
      snapshot = { ...snapshot, value: { ...snapshot.value!, ...value }, revision: Number(snapshot.revision) + 1 }
    },
    generationQueue() {
      let host = structuredClone(snapshot), generation = 0, pendingRevision: number | undefined
      let tail = Promise.resolve()
      const requests: Array<{ ops: Operations; revision: number | undefined; complete(): void; fail(): void }> = []
      const publish = () => { snapshot = structuredClone(host); notify() }
      // Faithful to DSH ConfigFormController: only the latest queued generation
      // publishes; earlier successes retain a pending revision, not a new view.
      form.mutate = (ops, expectedRevision) => {
        const ownGeneration = ++generation
        const task = tail.then(async () => {
          const revision = expectedRevision ?? pendingRevision ?? snapshot.revision
          calls.push({ ops, revision })
          const accepted = await new Promise<boolean>((resolve, reject) => {
            requests.push({ ops, revision, fail: () => reject(new Error('reader write transport failed')),
              complete() {
                if (revision !== host.revision) { resolve(false); return }
                const value = { ...host.value! }, user = { ...host.user as Record<string, unknown> }
                for (const op of ops) {
                  const field = op.path[0]! as keyof PdfSettings
                  Object.assign(value, { [field]: op.op === 'set' ? op.value : defaultSettings[field] })
                  if (op.op === 'set') user[field] = op.value; else delete user[field]
                }
                host = { ...host, value, user, revision: Number(host.revision) + 1 }
                resolve(true)
              } })
          })
          if (ownGeneration === generation) { pendingRevision = undefined; publish() }
          else if (accepted) pendingRevision = host.revision
          return accepted
        })
        tail = task.then(() => {}, () => {})
        return task
      }
      return { requests, async publish() { await act(async () => { publish() }) } }
    },
    changeMutation(next: typeof mutate) { mutate = next },
    async render(owner: ConfigForm) { await act(async () => { render(owner) }) },
    async unmount(blurSuffix?: string) { await act(async () => {
      if (blurSuffix) control(blurSuffix).dispatchEvent(new dom.FocusEvent('focusout', { bubbles: true }))
      root.render(null)
    }) },
    async fill(suffix: string, value: string) {
      await act(async () => { const input = control(suffix)
        const prototype = input.tagName === 'TEXTAREA' ? dom.HTMLTextAreaElement.prototype : dom.HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new dom.Event('input', { bubbles: true })) })
    },
    async blur(suffix: string) { await act(async () => { control(suffix).dispatchEvent(new dom.FocusEvent('focusout', { bubbles: true })) }) },
    async choose(suffix: string, value: string) { await act(async () => { const select = control(suffix)
      select.value = value; select.dispatchEvent(new dom.Event('change', { bubbles: true })) }) },
    async click(name: string) { await act(async () => { button(name).click() }) },
    async external(value: Partial<PdfSettings>, status: Partial<ConfigFormSnapshot> = {}) {
      await act(async () => { snapshot = { ...snapshot, ...status,
        value: Object.hasOwn(status, 'value') ? status.value : { ...snapshot.value!, ...value },
        revision: Number(snapshot.revision) + 1 }; notify() })
    },
    async close() { await act(async () => { root.unmount() }); dom.close()
      for (const [key, descriptor] of globals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

test('global engine selectors save immediately; invalid numbers stay editable without blocking independent changes', async () => {
  const h = await setup()
  try {
    assert.equal([...h.container.querySelectorAll('button')].some(node => node.textContent === 'Save settings'), false)
    await h.choose('ocrEngine', 'fixture.ocr')
    assert.equal(h.state().value!.ocrEngine, 'fixture.ocr')
    await h.choose('translationEngine', 'fixture.translation')
    assert.equal(h.state().value!.translationEngine, 'fixture.translation')
    await h.fill('translationTimeoutMs', '999'); await h.blur('translationTimeoutMs')
    assert.equal(h.calls.length, 2)
    assert.equal(h.control('translationTimeoutMs').value, '999')
    assert.match(h.container.textContent!, /Enter an integer from 1000 to 600000/)
    await h.choose('ocrEngine', 'session-llm')
    assert.equal(h.state().value!.ocrEngine, 'session-llm')
    assert.equal(h.state().value!.translationTimeoutMs, defaultSettings.translationTimeoutMs)
    await h.fill('translationTimeoutMs', '19000'); await h.blur('translationTimeoutMs')
    assert.equal(h.state().value!.translationTimeoutMs, 19000)
    await h.fill('explanationGeneralInstruction', 'x'.repeat(2001)); await h.blur('explanationGeneralInstruction')
    assert.match(h.container.textContent!, /Each prompt can contain at most 2000 characters/)
    assert.equal(h.state().value!.explanationGeneralInstruction, defaultSettings.explanationGeneralInstruction)
    await h.fill('explanationGeneralInstruction', 'Explain concisely.'); await h.blur('explanationGeneralInstruction')
    assert.equal(h.state().value!.explanationGeneralInstruction, 'Explain concisely.')
    assert.doesNotMatch(h.container.textContent!, /Settings changed elsewhere/)
  } finally { await h.close() }
})

test('global engine edits and reset leave document indexing defaults untouched', async () => {
  const h = await setup(ready({ ...defaultSettings, indexScanPages: false, indexImageDescriptions: true }))
  try {
    assert.equal(h.container.querySelectorAll('input[type="checkbox"]').length, 0)
    await h.choose('ocrEngine', 'fixture.ocr')
    await h.click('Restore defaults')
    assert.equal(h.state().value!.ocrEngine, defaultSettings.ocrEngine)
    assert.equal(h.state().value!.indexScanPages, false)
    assert.equal(h.state().value!.indexImageDescriptions, true)
    assert.ok(h.calls.length > 0)
    assert.ok(h.calls.flatMap(call => call.ops).every(operation =>
      !['indexScanPages', 'indexImageDescriptions'].includes(operation.path[0]!)))
  } finally { await h.close() }
})

test('typing coalesces into one bounded debounce and blur flushes valid prompt edits', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = await setup()
  try {
    await h.fill('historyCapacity', '4')
    await act(async () => { t.mock.timers.tick(200) })
    await h.fill('historyCapacity', '45')
    await act(async () => { t.mock.timers.tick(399) })
    assert.equal(h.calls.length, 0)
    await act(async () => { t.mock.timers.tick(1) })
    assert.equal(h.calls.length, 1)
    assert.equal(h.state().value!.historyCapacity, 45)
    await h.fill('explanationGeneralInstruction', 'Explain the assumptions first.')
    await h.blur('explanationGeneralInstruction')
    assert.equal(h.state().value!.explanationGeneralInstruction, 'Explain the assumptions first.')
    assert.equal(h.calls.length, 2)
  } finally { await h.close(); t.mock.timers.reset() }
})

test('an incomplete engine choice waits for its valid configuration and then saves both atomically', async () => {
  const h = await setup()
  try {
    await h.choose('imageEngine', 'fixture.required')
    assert.equal(h.calls.length, 0)
    assert.equal(h.state().value!.imageEngine, 'dsh-vision')
    assert.equal(h.control('imageEngine').value, 'fixture.required')
    assert.match(h.container.textContent!, /Check the selected engine configuration/)
    await h.choose('ocrEngine', 'fixture.ocr')
    assert.equal(h.state().value!.ocrEngine, 'fixture.ocr')
    assert.equal(h.state().value!.imageEngine, 'dsh-vision')
    await h.fill('image-model', 'my-model'); await h.blur('image-model')
    assert.equal(h.calls.length, 2)
    assert.deepEqual(h.calls[1]!.ops.map(operation => operation.path[0]).sort(), ['engineConfigurations', 'imageEngine'])
    assert.equal(h.state().value!.imageEngine, 'fixture.required')
    assert.deepEqual(h.state().value!.engineConfigurations?.image?.['fixture.required'], { model: 'my-model' })
  } finally { await h.close() }
})

test('serial saves retain edits made in flight, including a revert to the original value', async () => {
  const h = await setup()
  try {
    let finish!: () => void
    h.changeMutation(async ops => new Promise(resolve => { finish = () => { h.accept(ops); resolve(true) } }))
    await h.fill('historyCapacity', '40'); await h.blur('historyCapacity')
    assert.equal(h.calls.length, 1)
    assert.equal(h.control('historyCapacity').disabled, false, 'saving does not lock the settings form')
    await h.fill('historyCapacity', String(defaultSettings.historyCapacity)); await h.blur('historyCapacity')
    await h.choose('ocrEngine', 'fixture.ocr')
    assert.equal(h.calls.length, 1, 'only one mutation is in flight')
    h.changeMutation(async ops => { h.accept(ops); return true })
    await act(async () => { finish() })
    assert.equal(h.calls.length, 2)
    assert.deepEqual(h.calls.map(call => call.revision), [1, 2])
    assert.equal(h.state().value!.historyCapacity, defaultSettings.historyCapacity)
    assert.equal(h.state().value!.ocrEngine, 'fixture.ocr')
    assert.doesNotMatch(h.container.textContent!, /Settings changed elsewhere|Unsaved changes/)
  } finally { await h.close() }
})

test('transport errors and Host refusals retain edits and offer explicit retry', async () => {
  const h = await setup()
  try {
    h.changeMutation(async () => { throw new Error('offline') })
    await h.fill('historyCapacity', '77'); await h.blur('historyCapacity')
    assert.match(h.container.textContent!, /Could not save: offline/)
    assert.equal(h.control('historyCapacity').value, '77')
    const closing = new h.dom.Event('beforeunload', { cancelable: true })
    h.dom.dispatchEvent(closing)
    assert.equal(closing.defaultPrevented, true)
    h.changeMutation(async () => false)
    await h.click('Retry saving')
    assert.match(h.container.textContent!, /Settings were not accepted/)
    assert.equal(h.calls.length, 2)
    h.changeMutation(async ops => { h.accept(ops); return true })
    await h.click('Retry saving')
    assert.equal(h.state().value!.historyCapacity, 77)
    assert.equal(h.container.querySelector('[role="alert"]'), null)
    const saved = new h.dom.Event('beforeunload', { cancelable: true })
    h.dom.dispatchEvent(saved)
    assert.equal(saved.defaultPrevented, false)
  } finally { await h.close() }
})

test('loading and unavailable snapshots retain local edits until the connection is ready again', async () => {
  const h = await setup({ ...ready(), status: 'loading', value: undefined })
  try {
    assert.match(h.container.textContent!, /Loading PDF settings/)
    assert.equal(h.container.querySelector('input'), null)
    await h.external({ ...defaultSettings }, { status: 'ready' })
    await h.fill('historyCapacity', '70')
    await h.external({}, { status: 'unavailable', value: undefined })
    assert.match(h.container.textContent!, /Your edits are retained here/)
    assert.equal(h.control('historyCapacity').value, '70')
    assert.equal(h.control('historyCapacity').disabled, true)
    await h.blur('historyCapacity')
    assert.equal(h.calls.length, 0)
    await h.external({ ...defaultSettings }, { status: 'ready' })
    assert.equal(h.state().value!.historyCapacity, 70)
  } finally { await h.close() }
})

test('external revisions merge independent fields and require a choice for conflicting local values', async () => {
  const h = await setup()
  try {
    await h.fill('historyCapacity', '55')
    await h.external({ translationTimeoutMs: 12000 })
    assert.equal(h.control('translationTimeoutMs').value, '12000')
    assert.equal(h.control('historyCapacity').value, '55')
    assert.doesNotMatch(h.container.textContent!, /Settings changed elsewhere/)
    await h.external({ historyCapacity: 77 })
    assert.match(h.container.textContent!, /Settings changed elsewhere/)
    await h.blur('historyCapacity')
    assert.equal(h.calls.length, 0)
    await h.click('Keep my changes')
    assert.equal(h.state().value!.historyCapacity, 55)
    assert.equal(h.state().value!.translationTimeoutMs, 12000)
    await h.fill('historyCapacity', '56')
    await h.external({ historyCapacity: 78 })
    await h.click('Load latest settings')
    assert.equal(h.control('historyCapacity').value, '78')
    assert.doesNotMatch(h.container.textContent!, /Settings changed elsewhere/)
  } finally { await h.close() }
})

test('engine configuration merges preserve another writer’s independent keys', async () => {
  const h = await setup(ready({ ...defaultSettings, engineConfigurations: { image: { 'dsh-vision': { endpoint: 'old', credential: 'old-reference' } } } }))
  try {
    await h.fill('image-endpoint', 'new')
    await h.external({ engineConfigurations: { image: { 'dsh-vision': { endpoint: 'old', credential: 'new-reference' } } } })
    assert.equal(h.control('image-credential').value, 'new-reference')
    assert.equal(h.control('image-endpoint').value, 'new')
    await h.blur('image-endpoint')
    assert.deepEqual(h.state().value!.engineConfigurations?.image?.['dsh-vision'], { endpoint: 'new', credential: 'new-reference' })
    assert.doesNotMatch(h.container.textContent!, /Settings changed elsewhere/)
  } finally { await h.close() }
})

test('read-only connections pause pending edits; replacing the form isolates old mutation responses', async () => {
  const h = await setup()
  try {
    await h.fill('historyCapacity', '60')
    await h.external({}, { writable: false })
    await h.blur('historyCapacity')
    assert.equal(h.calls.length, 0)
    assert.equal(h.control('historyCapacity').value, '60')
    await h.external({}, { writable: true })
    assert.equal(h.state().value!.historyCapacity, 60)
    let finish!: () => void
    h.changeMutation(async ops => new Promise(resolve => { finish = () => { h.accept(ops); resolve(true) } }))
    await h.fill('historyCapacity', '61'); await h.blur('historyCapacity')
    const replacement = ready({ ...defaultSettings, historyCapacity: 88 })
    let replacementWrites = 0
    const owner: ConfigForm = { getSnapshot: () => replacement, subscribe: () => () => {}, mutate: async () => { replacementWrites++; return false } }
    await h.render(owner)
    await act(async () => { finish() })
    assert.equal(h.control('historyCapacity').value, '88')
    assert.equal(replacementWrites, 0, 'a previous owner’s pending intent cannot leak into a new form')
    assert.doesNotMatch(h.container.textContent!, /Settings saved/)
  } finally { await h.close() }
})

test('restore defaults clears overrides automatically and legacy prompt conversion saves without a submit button', async () => {
  const initial = ready({ ...defaultSettings, historyCapacity: 99, explanationPromptTemplate: 'Legacy {{items}}' })
  initial.base = { historyCapacity: 31, explanationPromptTemplate: 'Legacy {{items}}' }
  const h = await setup(initial)
  try {
    await h.click('Use separate prompts')
    assert.equal(h.state().value!.explanationPromptTemplate, defaultSettings.explanationPromptTemplate)
    await h.click('Restore defaults')
    assert.equal(h.state().value!.historyCapacity, 31)
    assert.ok(h.calls.at(-1)!.ops.every(operation => operation.op === 'unset'))
    assert.doesNotMatch(h.container.textContent!, /Unsaved changes/)
  } finally { await h.close() }
})

test('closing before the debounce or in the same event as blur persists a valid edit and reopening reads it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = await setup()
  try {
    await h.fill('historyCapacity', '77')
    assert.equal(h.calls.length, 0)
    await h.unmount('historyCapacity')
    assert.equal(h.subscriptions(), 0, 'a closed settings view retains no passive form watcher')
    await act(async () => { t.mock.timers.tick(1000) })
    assert.equal(h.calls.length, 1)
    assert.equal(h.state().value!.historyCapacity, 77)
    await h.render(h.form)
    assert.equal(h.subscriptions(), 1)
    assert.equal(h.control('historyCapacity').value, '77')
    await h.fill('translationTimeoutMs', '999')
    await h.unmount()
    assert.equal(h.subscriptions(), 0)
    assert.equal(h.calls.length, 1, 'closing cannot submit an invalid number')
    await h.render(h.form)
    assert.equal(h.control('translationTimeoutMs').value, '999', 'invalid input remains editable when reopened')
    await h.fill('translationTimeoutMs', '19000'); await h.blur('translationTimeoutMs')
    assert.equal(h.state().value!.translationTimeoutMs, 19000)
  } finally { await h.close(); t.mock.timers.reset() }
})

test('a later edit drains after an in-flight save even when the settings view has closed', async () => {
  const h = await setup()
  try {
    let finish!: () => void
    h.changeMutation(async ops => new Promise(resolve => { finish = () => { h.accept(ops); resolve(true) } }))
    await h.fill('historyCapacity', '40'); await h.blur('historyCapacity')
    await h.fill('historyCapacity', '41')
    await h.unmount()
    assert.equal(h.calls.length, 1)
    h.changeMutation(async ops => { h.accept(ops); return true })
    await act(async () => { finish() })
    assert.equal(h.subscriptions(), 0, 'draining the detached queue does not reattach a watch')
    assert.deepEqual(h.calls.map(call => call.revision), [1, 2])
    assert.equal(h.state().value!.historyCapacity, 41)
    await h.render(h.form)
    assert.equal(h.control('historyCapacity').value, '41')
    assert.doesNotMatch(h.container.textContent!, /Unsaved changes|Settings changed elsewhere/)
  } finally { await h.close() }
})

test('the close flush rechecks a newer Host revision even before its view notification arrives', async () => {
  const h = await setup()
  try {
    await h.fill('historyCapacity', '77')
    h.silentExternal({ translationTimeoutMs: 19000 })
    await h.unmount()
    assert.equal(h.state().value!.historyCapacity, 77)
    assert.equal(h.state().value!.translationTimeoutMs, 19000)
    assert.equal(h.calls[0]!.revision, 2, 'rebase precedes the detached write')
  } finally { await h.close() }
})

test('a concurrent external edit after the first acceptance fences a closed view’s queued change', async () => {
  const h = await setup()
  try {
    let finish!: () => void, first!: Operations
    h.changeMutation(async ops => new Promise(resolve => { first = ops; finish = () => resolve(true) }))
    await h.fill('historyCapacity', '40'); await h.blur('historyCapacity')
    await h.fill('historyCapacity', '41'); await h.unmount()
    await act(async () => { h.accept(first) })
    await h.external({ historyCapacity: 99 })
    h.changeMutation(async ops => { h.accept(ops); return true })
    await act(async () => { finish() })
    assert.equal(h.calls.length, 1, 'the latest revision alone cannot authorize overwriting another writer')
    assert.equal(h.state().value!.historyCapacity, 99)
    await h.render(h.form)
    assert.equal(h.control('historyCapacity').value, '41')
    assert.match(h.container.textContent!, /Settings changed elsewhere/)
    await h.click('Keep my changes')
    assert.equal(h.state().value!.historyCapacity, 41)
    assert.equal(h.calls.at(-1)!.revision, 3)
  } finally { await h.close() }
})

test('a failed detached write does not retry itself and retains later input for an explicit retry after reopening', async () => {
  const h = await setup()
  try {
    let reject!: () => void
    h.changeMutation(async () => new Promise((_resolve, no) => { reject = () => no(new Error('offline')) }))
    await h.fill('historyCapacity', '40'); await h.blur('historyCapacity')
    await h.fill('historyCapacity', '41'); await h.unmount()
    await act(async () => { reject() })
    assert.equal(h.calls.length, 1)
    await h.render(h.form)
    assert.equal(h.control('historyCapacity').value, '41')
    assert.match(h.container.textContent!, /Could not save: offline/)
    assert.equal(h.calls.length, 1)
    h.changeMutation(async ops => { h.accept(ops); return true })
    await h.click('Retry saving')
    assert.equal(h.state().value!.historyCapacity, 41)
  } finally { await h.close() }
})

test('an invalid legacy template is preserved until explicit conversion and does not block independent valid changes', async () => {
  const legacy = 'An older invalid template without an item slot.'
  const h = await setup(ready({ ...defaultSettings, explanationPromptTemplate: legacy }))
  try {
    assert.match(h.container.textContent!, /Invalid template/)
    assert.equal(h.calls.length, 0)
    await h.fill('historyCapacity', '79'); await h.blur('historyCapacity')
    assert.equal(h.state().value!.historyCapacity, 79)
    assert.equal(h.state().value!.explanationPromptTemplate, legacy)
    assert.ok(h.calls[0]!.ops.every(operation => operation.path[0] !== 'explanationPromptTemplate'))
    await h.click('Use separate prompts')
    assert.equal(h.state().value!.explanationPromptTemplate, defaultSettings.explanationPromptTemplate)
    assert.doesNotMatch(h.container.textContent!, /Invalid template/)
  } finally { await h.close() }
})

test('a reader-side queued write may hide the first ACK without conflicting with the settings edit drained after close', async () => {
  const h = await setup(ready({ ...defaultSettings, historyCapacity: 30 }))
  try {
    const queue = h.generationQueue()
    await h.fill('historyCapacity', '40'); await h.blur('historyCapacity')
    await h.fill('historyCapacity', '41'); await h.blur('historyCapacity')
    const language = h.form.mutate([{ op: 'set', path: ['translationTargetLanguage'], value: 'fr' }])
    await h.unmount()
    await act(async () => { queue.requests[0]!.complete() })
    assert.equal(h.state().revision, 1, 'superseded A returned true without publishing its accepted revision')
    assert.equal(h.state().value!.historyCapacity, 30)
    assert.equal(h.subscriptions(), 1, 'only the temporary ACK watcher remains after closing')
    await act(async () => { queue.requests[1]!.complete(); await language })
    assert.equal(queue.requests.length, 3)
    assert.equal(queue.requests[2]!.revision, 3, 'B uses the actual published revision after the reader-side write')
    await act(async () => { queue.requests[2]!.complete() })
    assert.equal(h.state().value!.historyCapacity, 41)
    assert.equal(h.state().value!.translationTargetLanguage, 'fr')
    assert.equal(h.subscriptions(), 0)
    await h.render(h.form)
    assert.doesNotMatch(h.container.textContent!, /Settings changed elsewhere|Could not save/)
  } finally { await h.close() }
})

test('a true same-field external change remains a conflict when its queued generation finally publishes', async () => {
  const h = await setup(ready({ ...defaultSettings, historyCapacity: 30 }))
  try {
    const queue = h.generationQueue()
    await h.fill('historyCapacity', '40'); await h.blur('historyCapacity')
    await h.fill('historyCapacity', '41')
    const external = h.form.mutate([{ op: 'set', path: ['historyCapacity'], value: 99 }])
    await h.unmount()
    await act(async () => { queue.requests[0]!.complete() })
    await act(async () => { queue.requests[1]!.complete(); await external })
    assert.equal(queue.requests.length, 2, 'a newer revision alone does not authorize overwriting C')
    assert.equal(h.state().value!.historyCapacity, 99)
    await h.render(h.form)
    assert.equal(h.control('historyCapacity').value, '41')
    assert.match(h.container.textContent!, /Settings changed elsewhere/)
    await h.click('Keep my changes')
    assert.equal(queue.requests[2]!.revision, 3)
    await act(async () => { queue.requests[2]!.complete() })
    assert.equal(h.state().value!.historyCapacity, 41)
  } finally { await h.close() }
})

test('an ACK timeout after a reader transport failure retains accepted A until recovery and never replays it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = await setup(ready({ ...defaultSettings, historyCapacity: 30 }))
  try {
    const queue = h.generationQueue()
    await h.fill('historyCapacity', '40'); await h.blur('historyCapacity')
    await h.fill('historyCapacity', '41')
    const language = h.form.mutate([{ op: 'set', path: ['translationTargetLanguage'], value: 'fr' }])
    const rejected = assert.rejects(language, /transport failed/)
    await h.unmount()
    await act(async () => { queue.requests[0]!.complete() })
    await act(async () => { queue.requests[1]!.fail(); await rejected })
    await act(async () => { t.mock.timers.tick(SETTINGS_ACK_TIMEOUT_MS) })
    assert.equal(h.subscriptions(), 0)
    await h.render(h.form)
    assert.match(h.container.textContent!, /accepted settings have not synchronized/)
    assert.equal(queue.requests.length, 2)
    await queue.publish()
    assert.doesNotMatch(h.container.textContent!, /Settings changed elsewhere/)
    assert.equal(queue.requests.length, 2, 'a recovered snapshot does not automatically retry a failed save')
    await h.click('Retry saving')
    assert.equal(queue.requests.length, 3)
    assert.equal(queue.requests[2]!.revision, 2)
    assert.deepEqual(queue.requests[2]!.ops, [{ op: 'set', path: ['historyCapacity'], value: 41 }], 'retry sends B, never A')
    await act(async () => { queue.requests[2]!.complete() })
    assert.equal(h.state().value!.historyCapacity, 41)
  } finally { await h.close(); t.mock.timers.reset() }
})

test('normalization and repeated defaults avoid no-op RPCs without losing explicit user overrides', async () => {
  const initial = ready({ ...defaultSettings, historyCapacity: 30 })
  initial.base = { historyCapacity: 30 }; initial.user = { historyCapacity: 30 }
  const h = await setup(initial)
  try {
    await h.fill('historyCapacity', '030'); await h.blur('historyCapacity')
    assert.equal(h.calls.length, 0)
    assert.equal(h.control('historyCapacity').value, '30')
    await h.click('Restore defaults'); await h.click('Restore defaults')
    assert.equal(h.calls.length, 0)
    await h.fill('historyCapacity', '40'); await h.blur('historyCapacity')
    await h.click('Restore defaults')
    assert.equal(h.calls.length, 2, 'resetting a real override still writes its inherited value')
    assert.equal(h.state().value!.historyCapacity, 30)
    await h.click('Restore defaults')
    assert.equal(h.calls.length, 2)
  } finally { await h.close() }
  const implicit = ready({ ...defaultSettings, historyCapacity: 30 })
  implicit.base = { historyCapacity: 30 }
  const explicit = await setup(implicit)
  try {
    await explicit.fill('historyCapacity', '030'); await explicit.blur('historyCapacity')
    assert.equal(explicit.calls.length, 1, 'equal effective values do not erase the intent to create an explicit override')
    assert.deepEqual(explicit.state().user, { historyCapacity: 30 })
  } finally { await explicit.close() }
})

test('retrying before ACK recovery waits again without replaying the already accepted write', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = await setup(ready({ ...defaultSettings, historyCapacity: 30 }))
  try {
    const queue = h.generationQueue()
    await h.fill('historyCapacity', '40'); await h.blur('historyCapacity')
    await h.fill('historyCapacity', '41')
    const reader = assert.rejects(h.form.mutate([{ op: 'set', path: ['translationTargetLanguage'], value: 'fr' }]), /transport failed/)
    await h.unmount()
    await act(async () => { queue.requests[0]!.complete() })
    await act(async () => { queue.requests[1]!.fail(); await reader; t.mock.timers.tick(SETTINGS_ACK_TIMEOUT_MS) })
    await h.render(h.form)
    await h.click('Retry saving')
    assert.equal(queue.requests.length, 2)
    assert.equal(h.subscriptions(), 2, 'the retry owns one temporary ACK watch in addition to the mounted view')
    await queue.publish()
    assert.equal(queue.requests.length, 3)
    assert.equal(queue.requests[2]!.revision, 2)
    await act(async () => { queue.requests[2]!.complete() })
    assert.equal(h.state().value!.historyCapacity, 41)
    assert.equal(h.subscriptions(), 1)
  } finally { await h.close(); t.mock.timers.reset() }
})

test('a late ACK clears an expired error when the entire local edit has already been saved', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = await setup(ready({ ...defaultSettings, historyCapacity: 30 }))
  try {
    const queue = h.generationQueue()
    await h.fill('historyCapacity', '40'); await h.blur('historyCapacity')
    const reader = assert.rejects(h.form.mutate([{ op: 'set', path: ['translationTargetLanguage'], value: 'fr' }]), /transport failed/)
    await act(async () => { queue.requests[0]!.complete() })
    await act(async () => { queue.requests[1]!.fail(); await reader; t.mock.timers.tick(SETTINGS_ACK_TIMEOUT_MS) })
    assert.match(h.container.textContent!, /accepted settings have not synchronized/)
    await queue.publish()
    assert.equal(h.control('historyCapacity').value, '40')
    assert.equal(h.container.querySelector('[role="alert"]'), null)
    assert.match(h.container.textContent!, /Settings saved/)
    assert.doesNotMatch(h.container.textContent!, /Retry saving|Unsaved changes/)
    assert.equal(queue.requests.length, 2, 'late acknowledgement clears feedback without issuing another write')
  } finally { await h.close(); t.mock.timers.reset() }
})
